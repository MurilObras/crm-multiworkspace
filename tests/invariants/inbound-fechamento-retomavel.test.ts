import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import pg from 'pg';

import { createInboundTurnHandler } from '@/lib/agent-engine/agent/inbound-turn';
import { createFakeRegistry } from '@/lib/agent-engine/edge/llm/providers';
import { createLogger } from '@/lib/agent-engine/obs/logger';
import type { ChannelSendInput } from '@/lib/agent-engine/channel-adapter';
import { claimJobs, completeJob, enqueueJob, failJob, type JobRow } from '@/lib/agent-engine/queue/queue';
import { closingMessages, readTurnClosing, recoverClosingBeforeMarker, rememberTurnClosing, checkpointSupersededByNewerTurn } from '@/lib/agent-engine/agent/turn-closing';

if (!process.env.TEST_DB_CONTAINER) throw new Error('Rode via pnpm test:db, contra banco descartável');
const pool = new pg.Pool({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`, max: 3 });
const ORG = 'd27b1000-0000-4000-8000-000000000001';
const CONTACT = 'd27b1000-0000-4000-8000-000000000002';
const SESSION = 'd27b1000-0000-4000-8000-000000000003';
const CONV = 'd27b1000-0000-4000-8000-000000000004';
const MSG = 'd27b1000-0000-4000-8000-000000000005';
const CHECKPOINT = JSON.stringify({ commitments: ['Resposta já entregue'], objections: [], next_action: 'Aguardar os dados', rolling_summary: 'Atendimento encerrado sem novo envio' });
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };

beforeAll(async () => {
  await pool.query(`insert into organizations(id,slug,legal_name,display_name) values($1,'closing-retry-test','Teste','Teste')`, [ORG]);
  await pool.query(`insert into contacts(id,organization_id,name,phone_number,source) values($1,$2,'Lead de teste','+5511999900271','whatsapp')`, [CONTACT, ORG]);
  await pool.query(`insert into channel_sessions(id,organization_id,waha_session_name,status,webhook_secret_encrypted)
    values($1,$2,'closing-retry-test','WORKING','\\x00'::bytea)`, [SESSION, ORG]);
  await pool.query(`insert into conversations(id,organization_id,contact_id,channel_session_id,status,is_group)
    values($1,$2,$3,$4,'ai_handling',false)`, [CONV, ORG, CONTACT, SESSION]);
  await pool.query(`insert into messages(id,organization_id,conversation_id,channel_session_id,contact_id,type,direction,status,body,sent_via,sent_at)
    values($1,$2,$3,$4,$5,'text','inbound','delivered','Quero continuar o cadastro','external_device',now())`, [MSG, ORG, CONV, SESSION, CONTACT]);
  await pool.query(`with v as (insert into playbook_versions(organization_id,layer,content)
    select null,'platform','Assistente de teste. Responda por ferramenta.'
    where not exists(select 1 from playbook_pointers where organization_id is null and layer='platform') returning id)
    insert into playbook_pointers(organization_id,layer,version_id) select null,'platform',id from v`);
});
afterAll(async () => { await pool.end(); });

describe('falha de memória não refaz atendimento já concluído', () => {
  it('retry fecha só memória, com o mesmo job, sem repetir mensagem ou nota e sem absorver nova inbound', async () => {
    let mainSteps = 0;
    let checkpoints = 0;
    let sends = 0;
    let retryPrompt = '';
    const registry = createFakeRegistry(async opts => {
      const main = (opts.tools?.length ?? 0) > 0;
      if (main) {
        const first = mainSteps++ === 0;
        return { content: first ? [
          { type: 'tool-call', toolCallId: 'nota', toolName: 'save_lead_note', input: JSON.stringify({ headline: 'Decisão confirmada', body: 'Cliente decidiu continuar o cadastro.' }) },
          { type: 'tool-call', toolCallId: 'envio', toolName: 'send_message', input: JSON.stringify({ body: 'O cadastro pode continuar. O atestado tem prazo de um mês.' }) },
        ] : [{ type: 'text', text: 'fim' }], finishReason: { unified: first ? 'tool-calls' : 'stop', raw: undefined }, usage, warnings: [] };
      }
      checkpoints++;
      if (checkpoints === 2) retryPrompt = JSON.stringify(opts.prompt);
      return { content: [{ type: 'text', text: checkpoints === 1 ? '{"commitments": inválido}' : CHECKPOINT }], finishReason: { unified: 'stop', raw: undefined }, usage, warnings: [] };
    });
    const handler = createInboundTurnHandler({
      crmCfg: { supabase: {} as never }, llmCfg: { anthropicApiKey: 'fake-test-key' }, registry, log: createLogger(),
      knobs: { historyLimit: 20, maxContextTokens: 2000, notesIndexMaxTokens: 1000, maxSteps: 5, queuedRetryDelayMs: 1000,
        breaker: { exactFailureWarn: 2, exactFailureBlock: 5, sameToolFailureWarn: 3, sameToolFailureHalt: 8, noProgressWarn: 3, noProgressBlock: 5 } },
      channel: () => ({ send: async (input: ChannelSendInput) => {
        sends++;
        const id = randomUUID();
        await input.beforePersist?.();
        await pool.query(`insert into messages(id,organization_id,conversation_id,channel_session_id,contact_id,type,direction,status,body,sent_via,sent_at)
          values($1,$2,$3,$4,$5,'text','outbound','sent',$6,'ai',now())`, [id, ORG, CONV, SESSION, CONTACT, input.body]);
        await pool.query(`insert into send_ledger(organization_id,contact_id,job_id,seq,body_hash,status,crm_message_id)
          values($1,$2,$3,$4,$5,'accepted',$6)`, [ORG, CONTACT, input.jobId, input.seq, createHash('sha256').update(input.body).digest('hex'), id]);
        return { kind: 'sent', messageId: id, idempotencyKey: 'test-key' };
      } }) as never,
      clock: () => new Date('2026-07-28T18:00:00Z'), sleep: async () => {},
    });
    const { job } = await enqueueJob(pool, ORG, { kind: 'inbound_turn', leadId: CONTACT,
      payload: { conversation_id: CONV, contact_id: CONTACT, channel_session_id: SESSION, inbound_message_id: MSG, crm_event_id: randomUUID() } });
    const [first] = await claimJobs(pool, { workerId: 'closing-first', maxConcurrency: 1 });
    expect(first?.id).toBe(job.id);
    await expect(handler(first!, pool, { workerId: 'closing-first' })).rejects.toThrow('checkpoint inválido');
    expect(sends).toBe(1);
    await failJob(pool, job.id, 'closing-first', 'checkpoint inválido');
    await pool.query(`update job_queue set run_after=now() where id=$1`, [job.id]);
    // Nova pergunta chegou, mas a recuperação da memória não pode tratá-la nem
    // misturá-la aos fatos do job antigo.
    await pool.query(`insert into messages(id,organization_id,conversation_id,channel_session_id,contact_id,type,direction,status,body,sent_via,sent_at)
      values($1,$2,$3,$4,$5,'text','inbound','delivered','NOVA PERGUNTA FORA DESTE JOB','external_device',now()+interval '1 second')`, [randomUUID(), ORG, CONV, SESSION, CONTACT]);
    const [retry] = await claimJobs(pool, { workerId: 'closing-retry', maxConcurrency: 1 });
    expect(retry?.id).toBe(job.id);
    expect(readTurnClosing(retry!)).not.toBeNull();
    expect(JSON.stringify(retry!.payload)).not.toContain('O atestado');
    expect(JSON.stringify(retry!.payload)).not.toContain('fake-test-key');
    await handler(retry!, pool, { workerId: 'closing-retry' });
    await completeJob(pool, job.id, 'closing-retry');
    expect(sends).toBe(1);
    expect(mainSteps).toBe(2); // SDK: um step com tools + um step de encerramento.
    expect(checkpoints).toBe(2);
    expect(retryPrompt).toContain('O atestado tem prazo de um mês');
    expect(retryPrompt).not.toContain('NOVA PERGUNTA');
    expect((await pool.query(`select count(*)::int n from lead_notes where organization_id=$1 and contact_id=$2`, [ORG, CONTACT])).rows[0].n).toBe(1);
    expect((await pool.query(`select count(*)::int n from lead_checkpoints where organization_id=$1 and contact_id=$2 and job_id=$3`, [ORG, CONTACT, job.id])).rows[0].n).toBe(1);
    expect((await pool.query(`select status from job_queue where id=$1`, [job.id])).rows[0].status).toBe('done');

    // Upgrade: o registro da versão anterior comprova que o checkpoint começou,
    // mas o job ainda não tinha o marcador. Reaproveita inclusive o checkpoint
    // já gravado, sem nova chamada de modelo ou segunda nota.
    await pool.query(`update job_queue set payload=payload-'turn_closing',status='pending',attempts=1,run_after=now() where id=$1`, [job.id]);
    const [legacy] = await claimJobs(pool, { workerId: 'closing-upgrade', maxConcurrency: 1 });
    expect(readTurnClosing(legacy!)).toBeNull();
    await handler(legacy!, pool, { workerId: 'closing-upgrade' });
    await completeJob(pool, job.id, 'closing-upgrade');
    expect(sends).toBe(1);
    expect(mainSteps).toBe(2);
    expect(checkpoints).toBe(2);
    expect((await pool.query(`select count(*)::int n from lead_checkpoints where job_id=$1`, [job.id])).rows[0].n).toBe(1);

    await expect(rememberTurnClosing(pool, legacy!, 'worker-sem-posse', { version: 1, agent: null })).rejects.toThrow('outbound_lease_lost');

    // Não tratar uma entrega ainda queued como conversa encerrada durante upgrade.
    await pool.query(`insert into send_ledger(organization_id,contact_id,job_id,seq,body_hash,status)
      values($1,$2,$3,99,$4,'queued')`, [ORG, CONTACT, job.id, '0'.repeat(64)]);
    await pool.query(`update job_queue set payload=payload-'turn_closing',status='pending',attempts=1,run_after=now() where id=$1`, [job.id]);
    const [pendingTransport] = await claimJobs(pool, { workerId: 'closing-pending', maxConcurrency: 1 });
    expect(await recoverClosingBeforeMarker(pool, pendingTransport!, 'closing-pending')).toBeNull();
    await completeJob(pool, job.id, 'closing-pending');

    // Se outro turno já fechou durante o backoff, não sobrescrever sua memória
    // com o fechamento atrasado. Simula o estado sem checkpoint do job antigo.
    await pool.query(`delete from send_ledger where job_id=$1 and seq=99`, [job.id]);
    await pool.query(`delete from lead_checkpoints where job_id=$1`, [job.id]);
    const { job: newer } = await enqueueJob(pool, ORG, { kind: 'inbound_turn', leadId: CONTACT,
      payload: { contact_id: CONTACT, conversation_id: CONV, channel_session_id: SESSION } });
    await pool.query(`update job_queue set status='done' where id=$1`, [newer.id]);
    await pool.query(`insert into lead_checkpoints(organization_id,contact_id,job_id,next_action,rolling_summary)
      values($1,$2,$3,'Continuar fluxo atual','Memória mais recente')`, [ORG, CONTACT, newer.id]);
    await pool.query(`update job_queue set payload=payload || jsonb_build_object('turn_closing',$2::jsonb),
      status='pending',attempts=1,run_after=now() where id=$1`, [job.id, JSON.stringify(retry!.payload.turn_closing)]);
    const [late] = await claimJobs(pool, { workerId: 'closing-late', maxConcurrency: 1 });
    expect(late?.id).toBe(job.id);
    expect(await checkpointSupersededByNewerTurn(pool, late!, newer.id)).toBe(true);
    await handler(late!, pool, { workerId: 'closing-late' });
    await completeJob(pool, job.id, 'closing-late');
    expect(checkpoints).toBe(2);
    expect(mainSteps).toBe(2);
    expect(sends).toBe(1);
    const current = (await pool.query(`select job_id,next_action from lead_checkpoints
      where organization_id=$1 and contact_id=$2 order by seq desc limit 1`, [ORG, CONTACT])).rows[0];
    expect(current).toMatchObject({ job_id: newer.id, next_action: 'Continuar fluxo atual' });
    expect((await pool.query(`select count(*)::int n from lead_checkpoints where job_id=$1`, [job.id])).rows[0].n).toBe(0);

    // Fixture de anonimização válida, sem desfazê-la depois da prova.
    await pool.query(`update contacts set is_anonymized=true,anonymized_at=now() where organization_id=$1 and id=$2`, [ORG, CONTACT]);
    expect(await closingMessages(pool, legacy!, CONV, null, 'fechar')).toBeNull();
  });

  it('marcador malformado não libera novo atendimento', () => {
    expect(() => readTurnClosing({ payload: { turn_closing: { version: 99 } } } as unknown as JobRow)).toThrow('estado de fechamento inválido');
  });
});
