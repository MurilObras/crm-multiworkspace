// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { discardSupersededOutbound, discardPreparedOutbound } from '@/lib/agent-engine/edge/crm/discard-superseded-outbound';
import { OutboundLeaseLostError } from '@/lib/channels/delivery-error';
import { outboundPostgres, ORG, CONTACT, JOB, CONV } from '../helpers/outbound-postgres';

let db: Awaited<ReturnType<typeof outboundPostgres>>;
const input = {
  organizationId: ORG, contactId: CONTACT, jobId: JOB, conversationId: CONV, workerId: 'owner',
};
const OTHER = '20000000-0000-4000-8000-000000000001';

beforeAll(async () => { db = await outboundPostgres(); });
afterAll(async () => { await db.close(); });
beforeEach(async () => {
  await db.seed();
  await db.pool.query(`update job_queue set kind='inbound_turn',status='running',locked_by='owner',
    payload=$1 where id=$2`, [JSON.stringify({ conversation_id: CONV }), JOB]);
});

async function attempt(overrides: {
  status?: string; phase?: string | null; externalId?: string | null; ledgerStatus?: string;
  message?: boolean; linked?: boolean; organizationId?: string; contactId?: string;
  conversationId?: string; jobId?: string;
} = {}) {
  const org = overrides.organizationId ?? ORG;
  const contact = overrides.contactId ?? CONTACT;
  const ledger = (await db.pool.query<{ id: string }>(`insert into send_ledger
    (organization_id,contact_id,job_id,seq,body_hash,status)
    values ($1,$2,$3,(select coalesce(max(seq),0)+1 from send_ledger where job_id=$3),'fixture',$4)
    returning id`, [org, contact, overrides.jobId ?? JOB, overrides.ledgerStatus ?? 'queued'])).rows[0]!.id;
  if (overrides.message !== false) {
    await db.pool.query(`insert into messages
      (id,organization_id,contact_id,conversation_id,direction,status,external_id,metadata)
      values ($1,$2,$3,$4,'outbound',$5,$6,$7)`, [ledger, org, contact, overrides.conversationId ?? CONV,
      overrides.status ?? 'queued', overrides.externalId ?? null,
      JSON.stringify({ idempotency_key: ledger,
        ...(overrides.phase === null ? {} : { outbound_attempt: {
          phase: overrides.phase ?? 'prepared', input: { body: 'Conteúdo preservado' },
        } }),
      })]);
    if (overrides.linked !== false)
      await db.pool.query('update send_ledger set crm_message_id=$1 where id=$1', [ledger]);
  }
  return ledger;
}

async function state(id: string) {
  return (await db.pool.query(`select l.status ledger_status,l.last_error,l.crm_message_id,
    m.status message_status,m.error_code,m.metadata,m.external_id
    from send_ledger l left join messages m on m.id=l.id where l.id=$1`, [id])).rows[0];
}

describe('descarte de tentativas de inbound superada', () => {
  it('retirada do plano de áudio encerra só as intenções reservadas, preservando ACK e resposta normal', async () => {
    const context = await attempt({ status: 'sent', phase: 'confirmed', externalId: 'ack', ledgerStatus: 'accepted' });
    const audio = await attempt();
    const response = await attempt();
    const before = await state(context); const normal = await state(response);
    await discardPreparedOutbound(db.pool, input, { code: 'required_audio_no_longer_eligible', maxSequence: 2 });
    expect(await state(context)).toEqual(before);
    expect(await state(response)).toEqual(normal);
    expect(await state(audio)).toMatchObject({ ledger_status: 'vetoed', message_status: 'failed',
      error_code: 'required_audio_no_longer_eligible', metadata: { outbound_attempt: { phase: 'rejected', retryable: false } } });
  });
  it('encerra todas as intenções preparadas, inclusive crash antes de ligar o ledger, e é idempotente', async () => {
    const ids = [await attempt(), await attempt({ status: 'failed', linked: false, ledgerStatus: 'requested' })];
    await discardSupersededOutbound(db.pool, input);
    for (const id of ids) {
      expect(await state(id)).toMatchObject({ ledger_status: 'vetoed', last_error: 'inbound_superseded',
        crm_message_id: id, message_status: 'failed', error_code: 'inbound_superseded',
        metadata: { outbound_attempt: { phase: 'rejected', retryable: false,
          input: { body: 'Conteúdo preservado' } } } });
    }
    const before = await Promise.all(ids.map(state));
    await discardSupersededOutbound(db.pool, input);
    expect(await Promise.all(ids.map(state))).toEqual(before);
    expect((await db.pool.query('select status from job_queue where id=$1', [JOB])).rows[0]?.status)
      .toBe('running'); // A lane continua pertencendo ao chamador até completeJob.
  });

  it('encerra intenção requested sem mensagem persistida, mas conserva identidade ausente de queued', async () => {
    const requested = await attempt({ ledgerStatus: 'requested', message: false });
    const unknown = await attempt({ message: false });
    await discardSupersededOutbound(db.pool, input);
    expect(await state(requested)).toMatchObject({ ledger_status: 'vetoed', last_error: 'inbound_superseded' });
    expect(await state(unknown)).toMatchObject({ ledger_status: 'queued', last_error: null });
  });

  it.each([
    { status: 'sent', phase: 'prepared', externalId: 'ack' },
    { status: 'delivered', phase: 'started', externalId: 'ack' },
    { status: 'read', phase: 'uncertain', externalId: 'ack' },
    { status: 'sending', phase: 'started' },
    { status: 'failed', phase: 'uncertain' },
    { status: 'queued', phase: 'started' },
    { status: 'queued', phase: 'prepared', externalId: 'ack' },
    { status: 'queued', phase: null },
    { status: 'queued', phase: 'prepared', ledgerStatus: 'accepted' },
  ])('preserva envio confirmado/incerto/legado: %j', async (overrides) => {
    const id = await attempt(overrides);
    const before = await state(id);
    await discardSupersededOutbound(db.pool, input);
    expect(await state(id)).toEqual(before);
  });

  it('preserva outro job, workspace, contato e conversa mesmo com metadata de tentativa', async () => {
    await db.pool.query('insert into job_queue (id,organization_id,contact_id) values ($1,$2,$3)',
      [OTHER, ORG, CONTACT]);
    const ids = [await attempt({ jobId: OTHER }), await attempt({ organizationId: OTHER }),
      await attempt({ contactId: OTHER }), await attempt({ conversationId: OTHER })];
    const before = await Promise.all(ids.map(state));
    await discardSupersededOutbound(db.pool, input);
    expect(await Promise.all(ids.map(state))).toEqual(before);
  });

  it.each(['worker', 'workspace', 'contact', 'conversation', 'kind', 'status'])(
    'não altera dados sem ownership válido (%s)', async (change) => {
      const id = await attempt();
      const before = await state(id);
      const args = { ...input };
      if (change === 'worker') args.workerId = 'outro-owner';
      if (change === 'workspace') args.organizationId = OTHER;
      if (change === 'contact') args.contactId = OTHER;
      if (change === 'conversation') args.conversationId = OTHER;
      if (change === 'kind') await db.pool.query("update job_queue set kind='followup_turn' where id=$1", [JOB]);
      if (change === 'status') await db.pool.query("update job_queue set status='pending' where id=$1", [JOB]);
      await expect(discardSupersededOutbound(db.pool, args)).rejects.toBeInstanceOf(OutboundLeaseLostError);
      expect(await state(id)).toEqual(before);
    },
  );
});
