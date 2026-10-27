import { afterAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';

import { createInboundTurnHandler } from '@/lib/agent-engine/agent/inbound-turn';
import { readTurnClosing, rememberTurnClosing, settleTurnClosingOutbound } from '@/lib/agent-engine/agent/turn-closing';
import { createFakeRegistry } from '@/lib/agent-engine/edge/llm/providers';
import { createLogger } from '@/lib/agent-engine/obs/logger';
import type { ChannelSendInput } from '@/lib/agent-engine/channel-adapter';
import { claimJobs, completeJob, enqueueJob, failJob } from '@/lib/agent-engine/queue/queue';

if (!process.env.TEST_DB_CONTAINER) throw new Error('Rode via pnpm test:db, contra banco descartável');
const pool = new pg.Pool({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`, max: 4 });
afterAll(async () => { await pool.end(); });
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
const CHECKPOINT = JSON.stringify({ commitments: [], objections: [], next_action: 'Aguardar o cliente', rolling_summary: 'Resposta confirmada' });

async function fixture() {
  const org = randomUUID(), contact = randomUUID(), session = randomUUID(), conversation = randomUUID(), inbound = randomUUID();
  await pool.query(`insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$1::text,'Teste','Teste')`, [org]);
  await pool.query(`insert into contacts(id,organization_id,name,phone_number,source) values($1,$2,'Teste','+5511999900321','whatsapp')`, [contact, org]);
  await pool.query(`insert into channel_sessions(id,organization_id,waha_session_name,status,webhook_secret_encrypted)
    values($1::uuid,$2,$1::text,'WORKING','\\x00'::bytea)`, [session, org]);
  await pool.query(`insert into conversations(id,organization_id,contact_id,channel_session_id,status,is_group)
    values($1,$2,$3,$4,'ai_handling',false)`, [conversation, org, contact, session]);
  await pool.query(`insert into messages(id,organization_id,conversation_id,channel_session_id,contact_id,type,direction,status,body,sent_via,sent_at)
    values($1,$2,$3,$4,$5,'text','inbound','delivered','Quero fazer a matrícula','external_device',now())`, [inbound, org, conversation, session, contact]);
  await pool.query(`with v as (insert into playbook_versions(organization_id,layer,content)
    select null,'platform','Assistente de teste. Responda por ferramenta.'
    where not exists(select 1 from playbook_pointers where organization_id is null and layer='platform') returning id)
    insert into playbook_pointers(organization_id,layer,version_id) select null,'platform',id from v`);
  const { job } = await enqueueJob(pool, org, { kind: 'inbound_turn', leadId: contact,
    payload: { conversation_id: conversation, contact_id: contact, channel_session_id: session, inbound_message_id: inbound, crm_event_id: randomUUID() } });
  const claim = async (worker: string) => {
    const [claimed] = await claimJobs(pool, { workerId: worker, maxConcurrency: 8, jobIds: [job.id] });
    expect(claimed?.id).toBe(job.id);
    return claimed!;
  };
  const retry = async (worker: string) => {
    await failJob(pool, job.id, worker, 'falha de teste');
    await pool.query(`update job_queue set run_after=now() where id=$1`, [job.id]);
  };
  const newer = async () => {
    await pool.query(`insert into messages(id,organization_id,conversation_id,channel_session_id,contact_id,type,direction,status,body,sent_via,sent_at)
      values($1,$2,$3,$4,$5,'text','inbound','delivered','NOVA PERGUNTA','external_device',now()+interval '1 second')`, [randomUUID(), org, conversation, session, contact]);
  };
  return { org, contact, session, conversation, job, claim, retry, newer };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function intent(f: Fixture, seq: number, options: {
  phase?: string; status?: string; ledgerStatus?: string; externalId?: string; retryable?: boolean;
  message?: boolean; linked?: boolean; conversationId?: string; organizationId?: string; contactId?: string;
} = {}) {
  const key = randomUUID(), message = randomUUID();
  const org = options.organizationId ?? f.org, contact = options.contactId ?? f.contact;
  await pool.query(`insert into send_ledger(id,organization_id,contact_id,job_id,seq,body_hash,status)
    values($1,$2,$3,$4,$5,$6,$7)`, [key, org, contact, f.job.id, seq, '0'.repeat(64), options.ledgerStatus ?? 'queued']);
  if (options.message !== false) {
    await pool.query(`insert into messages(id,organization_id,conversation_id,channel_session_id,contact_id,type,direction,status,body,sent_via,external_id,metadata)
      values($1,$2,$3,$4,$5,'text','outbound',$6,'Resposta anterior','ai',$7,$8)`,
    [message, org, options.conversationId ?? f.conversation, f.session, contact, options.status ?? 'queued', options.externalId ?? null,
      JSON.stringify({ idempotency_key: key, outbound_attempt: { phase: options.phase ?? 'prepared',
        ...(options.retryable === undefined ? {} : { retryable: options.retryable }),
        input: { conversation_id: f.conversation, type: 'text', body: 'Resposta anterior' } } })]);
    if (options.linked !== false) await pool.query(`update send_ledger set crm_message_id=$2 where id=$1`, [key, message]);
  }
  const state = async () => (await pool.query(`select l.status,l.last_error,l.crm_message_id,m.status as message_status,m.external_id,m.metadata
    from send_ledger l left join messages m on m.id=$2 where l.id=$1`, [key, message])).rows[0];
  return { key, message, state };
}

describe('fechamento não abandona envios de tentativas anteriores', () => {
  it('retoma só o fechamento, dispensa prepared superado e não repete ferramentas nem transporte', async () => {
    const f = await fixture();
    const pending = await intent(f, 99);
    let steps = 0, sends = 0, checkpoints = 0;
    const prompts: string[] = [];
    const registry = createFakeRegistry(async opts => {
      if ((opts.tools?.length ?? 0) > 0) {
        const first = steps++ === 0;
        return { content: first ? [
          { type: 'tool-call', toolCallId: 'nota', toolName: 'save_lead_note', input: JSON.stringify({ headline: 'Matrícula', body: 'Cliente decidiu se matricular.' }) },
          { type: 'tool-call', toolCallId: 'envio', toolName: 'send_message', input: JSON.stringify({ body: 'Podemos continuar a matrícula.' }) },
        ] : [{ type: 'text', text: 'fim' }], finishReason: { unified: first ? 'tool-calls' : 'stop', raw: undefined }, usage, warnings: [] };
      }
      prompts.push(JSON.stringify(opts.prompt));
      return { content: [{ type: 'text', text: ++checkpoints <= 2 ? '{inválido}' : CHECKPOINT }], finishReason: { unified: 'stop', raw: undefined }, usage, warnings: [] };
    });
    const handler = createInboundTurnHandler({ crmCfg: { supabase: {} as never }, llmCfg: { anthropicApiKey: 'fake-test-key' }, registry, log: createLogger(),
      knobs: { historyLimit: 20, maxContextTokens: 2000, notesIndexMaxTokens: 1000, maxSteps: 5, queuedRetryDelayMs: 1000,
        breaker: { exactFailureWarn: 2, exactFailureBlock: 5, sameToolFailureWarn: 3, sameToolFailureHalt: 8, noProgressWarn: 3, noProgressBlock: 5 } },
      channel: () => ({ send: async (input: ChannelSendInput) => {
        sends++;
        await input.beforePersist?.();
        const accepted = await intent(f, input.seq, { status: 'sent', phase: 'confirmed', ledgerStatus: 'accepted', externalId: 'fake-ack' });
        await pool.query(`update messages set body=$2 where id=$1`, [accepted.message, input.body]);
        await pool.query(`update send_ledger set body_hash=$2 where id=$1`, [accepted.key, createHash('sha256').update(input.body).digest('hex')]);
        return { kind: 'sent', messageId: accepted.message, idempotencyKey: accepted.key };
      } }) as never,
      clock: () => new Date('2026-07-28T18:00:00Z'), sleep: async () => {},
    });
    const first = await f.claim('first');
    await expect(handler(first, pool, { workerId: 'first' })).rejects.toThrow('aguarda reconciliação');
    expect(readTurnClosing(first)).not.toBeNull();
    expect(checkpoints).toBe(0);
    expect((await pending.state()).status).toBe('queued'); // Mesma inbound: não descartar resposta válida.
    await f.retry('first');
    await f.newer();
    const retry = await f.claim('retry');
    await expect(handler(retry, pool, { workerId: 'retry' })).rejects.toThrow('checkpoint inválido');
    expect(await pending.state()).toMatchObject({ status: 'vetoed', last_error: 'inbound_superseded', message_status: 'failed',
      metadata: { outbound_attempt: { phase: 'rejected', retryable: false } } });
    await f.retry('retry');
    const final = await f.claim('final');
    await handler(final, pool, { workerId: 'final' });
    await completeJob(pool, f.job.id, 'final');
    expect({ steps, sends, checkpoints }).toEqual({ steps: 2, sends: 1, checkpoints: 3 });
    for (const prompt of prompts) { expect(prompt).toContain('Podemos continuar'); expect(prompt).not.toContain('NOVA PERGUNTA'); }
    expect((await pool.query(`select count(*)::int n from lead_notes where organization_id=$1 and contact_id=$2`, [f.org, f.contact])).rows[0].n).toBe(1);
    expect((await pool.query(`select count(*)::int n from lead_checkpoints where organization_id=$1 and job_id=$2`, [f.org, f.job.id])).rows[0].n).toBe(1);
    expect((await pool.query(`select status from job_queue where id=$1`, [f.job.id])).rows[0].status).toBe('done');
    expect((await pool.query(`select count(*)::int n from send_ledger where job_id=$1 and status in ('requested','queued')`, [f.job.id])).rows[0].n).toBe(0);
  });

  it('reconcilia ACK e rejeição terminal, preserva incerto e não desfaz o descarte seguro se outro envio bloqueia', async () => {
    const f = await fixture();
    const prepared = await intent(f, 1);
    const accepted = await intent(f, 2, { ledgerStatus: 'accepted', status: 'read', phase: 'confirmed', externalId: 'ack-accepted' });
    const ack = await intent(f, 3, { status: 'delivered', phase: 'started', externalId: 'ack-new' });
    const rejected = await intent(f, 4, { ledgerStatus: 'failed', status: 'failed', phase: 'rejected', retryable: false });
    const uncertain = await intent(f, 5, { status: 'sending', phase: 'started' });
    const orphan = await intent(f, 6, { message: false });
    const requested = await intent(f, 7, { message: false, ledgerStatus: 'requested' });
    const unlinked = await intent(f, 8, { linked: false, ledgerStatus: 'requested' });
    const beforeAccepted = await accepted.state(), beforeUncertain = await uncertain.state(), beforeOrphan = await orphan.state();
    const job = await f.claim('owner');
    await f.newer();
    await expect(settleTurnClosingOutbound(pool, job, 'owner', f.conversation)).rejects.toThrow('aguarda reconciliação');
    for (const item of [prepared, requested, unlinked]) expect((await item.state()).status).toBe('vetoed');
    expect(await accepted.state()).toEqual(beforeAccepted);
    expect(await uncertain.state()).toEqual(beforeUncertain);
    expect(await orphan.state()).toEqual(beforeOrphan);
    expect(await ack.state()).toMatchObject({ status: 'accepted', external_id: 'ack-new', message_status: 'delivered' });
    expect(await rejected.state()).toMatchObject({ status: 'vetoed', message_status: 'failed' });
    expect((await pool.query(`select status from job_queue where id=$1`, [job.id])).rows[0].status).toBe('running');
    await pool.query(`update job_queue set max_attempts=1 where id=$1`, [job.id]);
    await failJob(pool, job.id, 'owner', 'fechamento aguarda reconciliação de envio pendente');
    expect((await pool.query(`select status from job_queue where id=$1`, [job.id])).rows[0].status).toBe('dead');
    expect((await pool.query(`select count(*)::int n from agent_inbox_items where organization_id=$1 and kind='job_dead'`, [f.org])).rows[0].n).toBe(1);
  });

  it('não altera pendências sem lease, de outro contato/workspace ou de outra conversa', async () => {
    const f = await fixture(), other = await fixture();
    const own = await intent(f, 1);
    const foreign = await intent(f, 2, { organizationId: other.org, contactId: other.contact, conversationId: other.conversation });
    const elsewhere = randomUUID();
    const otherSession = randomUUID();
    await pool.query(`insert into channel_sessions(id,organization_id,waha_session_name,status,webhook_secret_encrypted)
      values($1::uuid,$2,$1::text,'WORKING','\\x00'::bytea)`, [otherSession, f.org]);
    await pool.query(`insert into conversations(id,organization_id,contact_id,channel_session_id,status,is_group)
      values($1,$2,$3,$4,'ai_handling',false)`, [elsewhere, f.org, f.contact, otherSession]);
    const wrongConversation = await intent(f, 3, { conversationId: elsewhere });
    const snapshots = await Promise.all([own, foreign, wrongConversation].map(x => x.state()));
    const job = await f.claim('owner');
    await f.newer();
    await expect(settleTurnClosingOutbound(pool, job, 'stranger', f.conversation)).rejects.toThrow('outbound_lease_lost');
    expect(await Promise.all([own, foreign, wrongConversation].map(x => x.state()))).toEqual(snapshots);
    await expect(settleTurnClosingOutbound(pool, job, 'owner', f.conversation)).rejects.toThrow('aguarda reconciliação');
    expect((await own.state()).status).toBe('vetoed');
    expect(await foreign.state()).toEqual(snapshots[1]);
    expect(await wrongConversation.state()).toEqual(snapshots[2]);
    await failJob(pool, job.id, 'owner', 'aguarda revisão');
  });

  it('não reconcilia identidades duplicadas nem ponteiro divergente mesmo com ACK', async () => {
    const f = await fixture();
    const duplicate = await intent(f, 1, { status: 'sent', phase: 'confirmed', externalId: 'ack' });
    await pool.query(`insert into messages(id,organization_id,conversation_id,channel_session_id,contact_id,type,direction,status,body,sent_via,metadata)
      values($1,$2,$3,$4,$5,'text','outbound','queued','Outra identidade','ai',$6)`, [randomUUID(), f.org, f.conversation, f.session, f.contact,
      JSON.stringify({ idempotency_key: duplicate.key, outbound_attempt: { phase: 'started' } })]);
    const mismatch = await intent(f, 2, { status: 'sent', phase: 'confirmed', externalId: 'ack-other' });
    await pool.query(`update send_ledger set crm_message_id=$2 where id=$1`, [mismatch.key, duplicate.message]);
    const before = await Promise.all([duplicate, mismatch].map(x => x.state()));
    const job = await f.claim('owner');
    await expect(settleTurnClosingOutbound(pool, job, 'owner', f.conversation)).rejects.toThrow('aguarda reconciliação');
    expect(await Promise.all([duplicate, mismatch].map(x => x.state()))).toEqual(before);
    await failJob(pool, job.id, 'owner', 'identidade divergente');
  });

  it.each(['anonimizado', 'memória avançada', 'checkpoint persistido'])(
    '%s não pula a guarda das pendências', async scenario => {
    const f = await fixture();
    const job = await f.claim('owner');
    await intent(f, 1, { message: false });
    await rememberTurnClosing(pool, job, 'owner', { version: 1, agent: null, previousCheckpointId: null });
    if (scenario === 'anonimizado')
      await pool.query(`update contacts set is_anonymized=true,anonymized_at=now() where id=$1 and organization_id=$2`, [f.contact, f.org]);
    else
      await pool.query(`insert into lead_checkpoints(organization_id,contact_id,job_id,next_action,rolling_summary)
        values($1,$2,$3,'Manter memória recente','Mais recente')`, [f.org, f.contact, scenario === 'checkpoint persistido' ? job.id : null]);
    const handler = createInboundTurnHandler({ crmCfg: { supabase: {} as never }, llmCfg: {}, log: createLogger(),
      registry: createFakeRegistry(async () => { throw new Error('não deve chamar modelo'); }),
      knobs: { historyLimit: 20, maxContextTokens: 2000, notesIndexMaxTokens: 1000, maxSteps: 5, queuedRetryDelayMs: 1000,
        breaker: { exactFailureWarn: 2, exactFailureBlock: 5, sameToolFailureWarn: 3, sameToolFailureHalt: 8, noProgressWarn: 3, noProgressBlock: 5 } },
    });
    await expect(handler(job, pool, { workerId: 'owner' })).rejects.toThrow('aguarda reconciliação');
    await failJob(pool, job.id, 'owner', 'aguarda revisão');
  });
});
