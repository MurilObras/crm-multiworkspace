// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { outboundPostgres, ORG, CONTACT, JOB, CONV, ENROLLMENT } from '../helpers/outbound-postgres';
import { sendTurnMessage } from '@/lib/agent-engine/edge/crm/send-message';
import { claimJobs, type JobRow } from '@/lib/agent-engine/queue/queue';
import { createFollowupTurnHandler } from '@/lib/agent-engine/agent/followup-turn';
import { discardPreparedOutbound } from '@/lib/agent-engine/edge/crm/discard-superseded-outbound';
import { getAdapter } from '@/lib/channels';
import { followupJobGate } from '@/lib/agent-engine/edge/crm/followup-job-gate';
import { guardCurrentInboundTools } from '@/lib/agent-engine/agent/current-inbound-tools';
import { tool } from 'ai';
import { z } from 'zod';

vi.mock('@/lib/audit', () => ({ audit: vi.fn(async () => {}) }));
let db: Awaited<ReturnType<typeof outboundPostgres>>;
let transport: ReturnType<typeof vi.spyOn>;
beforeAll(async () => { db = await outboundPostgres(); }, 30_000);
afterAll(async () => { vi.restoreAllMocks(); await db.close(); });
beforeEach(async () => {
  vi.restoreAllMocks();
  await db.seed();
  vi.spyOn(getAdapter('waha'), 'isConfigured').mockReturnValue(true);
  transport = vi.spyOn(getAdapter('waha'), 'send').mockResolvedValue({ externalId: 'controlled-transport' });
  await claimJobs(db.pool, { workerId: 'owner', maxConcurrency: 1, jobIds: [JOB] });
});
const input = () => ({ tenantId: ORG, leadId: CONTACT, jobId: JOB, workerId: 'owner', seq: 1,
  conversationId: CONV, body: 'Retorno comercial de teste' });
async function attempt() {
  return (await db.pool.query(`select m.status,m.metadata,m.external_id,m.error_code,l.status as ledger_status
    from messages m join send_ledger l on l.crm_message_id=m.id where l.job_id=$1`, [JOB])).rows[0];
}

describe('última barreira antes da rede usa estado real do banco', () => {
  it('prazo distante conserva o job com recheck curto, sem gastar tentativa ou chamar o modelo', async () => {
    await db.pool.query(`insert into followup_enrollment_events(organization_id,enrollment_id,node_id,event_type,payload,created_at)
      values($1,$2,'node','snoozed_manual',jsonb_build_object('next_eval_at',now()+interval '7 days'),now()+interval '1 second')`,
    [ORG, ENROLLMENT]);
    const job = (await db.pool.query<JobRow>('select * from job_queue where id=$1', [JOB])).rows[0]!;
    const before = Date.now();
    await createFollowupTurnHandler({} as never)(job, db.pool, { workerId: 'owner' });
    const pending = (await db.pool.query<JobRow>('select * from job_queue where id=$1', [JOB])).rows[0]!;
    expect(pending.status).toBe('pending');
    expect(pending.attempts).toBe(0);
    expect(pending.run_after.getTime()).toBeLessThanOrEqual(before + 61_000);
    expect(transport).not.toHaveBeenCalled();
  });
  it('SDK que continua após encerrar o job não executa outra ferramenta mutante', async () => {
    const mutate = vi.fn(async () => 'não deve executar');
    const execution = guardCurrentInboundTools({
      send: tool({ inputSchema: z.object({}), execute: async () => {
        await db.pool.query("update job_queue set status='done',locked_by=null where id=$1", [JOB]);
        return 'turno encerrado';
      } }),
      update_lead_state: tool({ inputSchema: z.object({}), execute: mutate }),
    }, async () => { await followupJobGate(db.pool, ORG, JOB, CONTACT, 'owner'); });
    const options = { toolCallId: 'controlled', messages: [], context: {} };
    await execution.tools.send!.execute!({}, options);
    await expect(execution.tools.update_lead_state!.execute!({}, options)).rejects.toMatchObject({ name: 'OutboundLeaseLostError' });
    await execution.drain();
    expect(mutate).not.toHaveBeenCalled();
  });
  it('controle positivo envia uma vez e conserva identidade no replay', async () => {
    expect((await sendTurnMessage(db.pool, { supabase: db.supabase }, input())).kind).toBe('sent');
    expect((await sendTurnMessage(db.pool, { supabase: db.supabase }, input())).kind).toBe('already_sent');
    expect(transport).toHaveBeenCalledOnce();
  });
  it.each(['manual', 'handoff'] as const)('intervenção %s depois do pré-voo segura prepared e permite retomada sem duplicar', async (kind) => {
    let calls = 0;
    const request = { ...input(), beforePersist: async () => {
      if (++calls !== 2) return;
      if (kind === 'manual') await db.pool.query("update followup_enrollments set status='paused_manual' where id=$1", [ENROLLMENT]);
      else await db.pool.query("update conversations set bot_silenced_until='infinity' where id=$1", [CONV]);
    } };
    expect((await sendTurnMessage(db.pool, { supabase: db.supabase }, request)).kind).toBe('queued');
    expect(transport).not.toHaveBeenCalled();
    expect(await attempt()).toMatchObject({ status: 'queued', external_id: null,
      ledger_status: 'queued', metadata: { outbound_attempt: { phase: 'prepared' } } });
    await db.pool.query("update followup_enrollments set status='active' where id=$1", [ENROLLMENT]);
    await db.pool.query("update conversations set bot_silenced_until=null where id=$1", [CONV]);
    expect((await sendTurnMessage(db.pool, { supabase: db.supabase }, request)).kind).toBe('sent');
    expect(transport).toHaveBeenCalledOnce();
  });
  it.each(['cancelled', 'dead', 'node', 'same_node_again'] as const)('%s entre pré-voo e CAS encerra a intenção sem transportar', async (change) => {
    let calls = 0;
    const request = { ...input(), beforePersist: async () => {
      if (++calls !== 2) return;
      if (change === 'same_node_again') {
        await db.pool.query("update followup_enrollments set current_node_id='outro' where id=$1", [ENROLLMENT]);
        await db.pool.query("update followup_enrollments set current_node_id='node' where id=$1", [ENROLLMENT]);
        return;
      }
      if (change === 'node') await db.pool.query("update followup_enrollments set current_node_id='outro' where id=$1", [ENROLLMENT]);
      else await db.pool.query("update followup_enrollments set status=$2 where id=$1", [ENROLLMENT, change]);
    } };
    expect((await sendTurnMessage(db.pool, { supabase: db.supabase }, request)).kind).toBe('failed');
    expect(transport).not.toHaveBeenCalled();
    expect(await attempt()).toMatchObject({ status: 'failed', ledger_status: 'failed',
      metadata: { outbound_attempt: { phase: 'rejected', retryable: false } } });
  });
  it('descarte de job obsoleto preserva entrega incerta', async () => {
    vi.mocked(transport).mockRejectedValueOnce(new Error('network timeout'));
    await sendTurnMessage(db.pool, { supabase: db.supabase }, input());
    const before = await attempt();
    // O desfecho incerto não é prova para limpar/repetir a rede.
    await db.pool.query("update job_queue set status='running',locked_by='owner' where id=$1", [JOB]);
    await discardPreparedOutbound(db.pool, { organizationId: ORG, contactId: CONTACT, jobId: JOB,
      workerId: 'owner', conversationId: '', kind: 'followup_turn' }, { code: 'followup_inactive' });
    expect(await attempt()).toEqual(before);
    expect(transport).toHaveBeenCalledOnce();
  });
  it('descarte de job obsoleto encerra prepared com ledger na mesma operação', async () => {
    vi.spyOn(getAdapter('waha'), 'isConfigured').mockReturnValue(false);
    expect((await sendTurnMessage(db.pool, { supabase: db.supabase }, input())).kind).toBe('queued');
    await discardPreparedOutbound(db.pool, { organizationId: ORG, contactId: CONTACT, jobId: JOB,
      workerId: 'owner', conversationId: '', kind: 'followup_turn' }, { code: 'followup_inactive' });
    expect(await attempt()).toMatchObject({ status: 'failed', ledger_status: 'vetoed', error_code: 'followup_inactive',
      metadata: { outbound_attempt: { phase: 'rejected', retryable: false } } });
    expect(transport).not.toHaveBeenCalled();
  });
});
