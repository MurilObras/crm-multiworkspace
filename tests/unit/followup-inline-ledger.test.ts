// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { outboundPostgres, ORG, CONTACT, JOB, CONV, SESSION } from '../helpers/outbound-postgres';
import { redriveQueued, type WatchdogConfig } from '@/lib/agent-engine/edge/crm/session-reconciler';
import { claimJobs, completeJob, reapExpiredJobs, rescheduleJob, withJobLease } from '@/lib/agent-engine/queue/queue';
import { sendTurnMessage } from '@/lib/agent-engine/edge/crm/send-message';
import { sendInlineTurnMessage } from '@/lib/agent-engine/edge/crm/inline-send';
import { getAdapter } from '@/lib/channels';
import { DeliveryRejectedError } from '@/lib/channels/delivery-error';
import { recoverStuckMessages } from '@/app/api/v1/cron/recover-stuck-messages/route';
import { decideOutboundRecovery } from '@/lib/agent-engine/edge/crm/outbound-recovery';
import { enviarTextoFixoPendente } from '@/lib/followup/enviar-texto-fixo';
import type { SupabaseClient } from '@supabase/supabase-js';

vi.mock('@/lib/audit', () => ({ audit: vi.fn(async () => {}) }));
vi.mock('@/lib/ai/elegibilidade/consulta-supabase', () => ({ decidirElegibilidadeDaConversaViaSupabase: async () => ({ permite:true }) }));
let db: Awaited<ReturnType<typeof outboundPostgres>>;
let transport: ReturnType<typeof vi.spyOn>;
const KEY = '10000000-0000-4000-8000-000000000007';
beforeAll(async () => { db = await outboundPostgres(); }, 60_000);
afterAll(async () => { vi.restoreAllMocks(); await db.close(); });
beforeEach(async () => {
  vi.restoreAllMocks(); await db.seed();
  vi.spyOn(getAdapter('waha'), 'isConfigured').mockReturnValue(true);
  transport = vi.spyOn(getAdapter('waha'), 'send').mockResolvedValue({ externalId: 'confirmed-id' });
});
const claim = async (workerId: string) => claimJobs(db.pool, { workerId, maxConcurrency: 8, jobIds: [JOB] });
const input = (workerId: string) => ({ workerId, tenantId: ORG, leadId: CONTACT, jobId: JOB, seq: 1, conversationId: CONV, body: 'Oi' });
const worker = (owner: string) => sendTurnMessage(db.pool, { supabase: db.supabase }, input(owner));
const inline = (owner: string) => sendInlineTurnMessage(db.pool, db.supabase, {
  organization_id: ORG, actor: { type: 'webhook_source', id: JOB }, requestId: 'test',
}, JOB, CONTACT, owner, async () => ({ conversation_id: CONV, type: 'text', body: 'Oi' }));
const runInline = (workerId: string) => enviarTextoFixoPendente(db.supabase,undefined,{pool:db.pool,workerId,maxConcurrency:8,queuedRetryDelayMs:10});
async function snapshot(status?: string, phase?: string, ledgerStatus = 'requested') {
  await db.pool.query('insert into send_ledger(id,organization_id,contact_id,job_id,seq,body_hash,status) values($1,$2,$3,$4,1,$5,$6)',
    [KEY,ORG,CONTACT,JOB,'hash',ledgerStatus]);
  if (status) await db.pool.query(`insert into messages(id,organization_id,contact_id,conversation_id,status,type,body,direction,metadata,external_id,channel_session_id)
    values($1,$2,$3,$4,$5,'text','Oi','outbound',$6,$7,$8)`, [KEY,ORG,CONTACT,CONV,status,JSON.stringify({
      idempotency_key:KEY,outbound_attempt:{phase,retryable:phase==='rejected',input:{conversation_id:CONV,type:'text',body:'Oi'}},
    }), ['sent','delivered','read'].includes(status)?'confirmed-id':null,SESSION]);
}
async function expire() { await db.pool.query("update job_queue set locked_at=now()-interval '1 hour' where id=$1",[JOB]); return reapExpiredJobs(db.pool,{visibilityTimeoutMs:1000}); }

function signal() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

async function stalePreflightScenario(requeue = false) {
  await db.pool.query('alter table channel_sessions add column if not exists zernio_account_id text');
  await db.pool.query('update channel_sessions set provider=$1,zernio_account_id=$2', ['zernio','account']);
  await db.pool.query(`create table if not exists meta_templates(organization_id uuid,channel_session_id uuid,
    name text,language text,status text,contract_hash text,components jsonb,parameter_format text)`);
  await db.pool.query('truncate meta_templates');
  const definition = { name:'template',language:'pt_BR',status:'APPROVED',contract_hash:'hash',components:[{type:'BODY',text:'Oi'}] };
  await db.pool.query('insert into meta_templates values($1,$2,$3,$4,$5,$6,$7,$8)',
    [ORG,SESSION,definition.name,definition.language,definition.status,definition.contract_hash,JSON.stringify(definition.components),'POSITIONAL']);
  const aGate = signal(); const aReady = signal(); const bGate = signal(); const bReady = signal();
  const adapter = getAdapter('zernio');
  vi.spyOn(adapter,'isConfigured').mockReturnValue(true);
  let calls = 0;
  const remote = vi.spyOn(adapter,'sendTemplate').mockImplementation(async () => {
    const id = `network-${++calls}`;
    if (calls === 1) { bReady.release(); await bGate.promise; }
    return { externalId:id };
  });
  const aDb = { ...db.supabase, from(table: string) {
    const q = db.supabase.from(table) as unknown as {
      maybeSingle: () => Promise<{data: typeof definition | null; error: null}>;
    };
    if (table === 'meta_templates') q.maybeSingle = async () => {
      aReady.release(); await aGate.promise;
      if (requeue) throw new Error(adapter.codes.notConfigured);
      return {data:{...definition,status:'PENDING'},error:null};
    };
    return q;
  } } as unknown as SupabaseClient;
  const attempt = (owner: string, supabase = db.supabase) => sendTurnMessage(db.pool,{supabase},{
    ...input(owner),template:{name:'template',language:'pt_BR',values:{}},
  });
  const readState = async () => ({
    messages:(await db.pool.query('select id,status,metadata,error_code,error_message,external_id from messages')).rows,
    ledger:(await db.pool.query('select id,status,crm_message_id,body_hash,last_error from send_ledger')).rows,
  });
  return {aDb,aGate,aReady,bGate,bReady,remote,attempt,readState};
}

describe('N1 — owner expirado não reclassifica a tentativa atual', () => {
  it.each([false,true])('A → B → A tardio → C mantém um único transporte (requeue=%s)', async (requeue) => {
    const s = await stalePreflightScenario(requeue);
    await claim('A');
    const a = s.attempt('A',s.aDb).catch((error: Error) => error);
    let b: Promise<unknown> | undefined;
    try {
      await s.aReady.promise;
      await expire(); await claim('B');
      b = s.attempt('B').catch((error: Error) => error);
      await s.bReady.promise; // B já chamou a rede; sua confirmação ainda está pendente.
      const started = await s.readState();
      expect(started.messages[0]).toMatchObject({status:'sending',metadata:{outbound_attempt:{phase:'started'}}});
      s.aGate.release();
      expect(await a).toMatchObject({message:'outbound_lease_lost'});
      expect(await s.readState()).toEqual(started); // A não escreveu message nem ledger.
      expect((await db.pool.query('select status,locked_by from job_queue')).rows[0]).toEqual({status:'running',locked_by:'B'});
      await expire(); await claim('C');
      expect((await s.attempt('C')).kind).toBe('failed');
      expect(s.remote).toHaveBeenCalledOnce();
      const uncertain = await s.readState();
      expect(uncertain.messages[0]).toMatchObject({status:'failed',metadata:{outbound_attempt:{phase:'uncertain'}}});
      expect(uncertain.ledger[0]?.last_error).toBe('outbound_delivery_uncertain');
      // Nem o sucesso tardio de B pode escrever sobre a execução de C.
      s.bGate.release();
      expect(await b).toMatchObject({message:'outbound_lease_lost'});
      expect(await s.readState()).toEqual(uncertain);
    } finally {
      s.aGate.release(); s.bGate.release(); await Promise.allSettled([a,...(b?[b]:[])]);
    }
  });

  it('owner antigo não escreve mesmo quando a fase ainda é prepared', async () => {
    const s = await stalePreflightScenario(); await claim('A');
    const a = s.attempt('A',s.aDb).catch((error: Error) => error);
    try {
      await s.aReady.promise; await expire(); await claim('B');
      const before = await s.readState(); s.aGate.release();
      expect(await a).toMatchObject({message:'outbound_lease_lost'});
      expect(await s.readState()).toEqual(before); expect(s.remote).not.toHaveBeenCalled();
    } finally { s.aGate.release(); s.bGate.release(); await a; }
  });

  it('fase alterada para started impede escrita pré-rede mesmo com owner igual', async () => {
    const s = await stalePreflightScenario(); await claim('A');
    const a = s.attempt('A',s.aDb).catch((error: Error) => error);
    try {
      await s.aReady.promise;
      await db.pool.query(`update messages set status='sending',metadata=jsonb_set(metadata,'{outbound_attempt,phase}','"started"'::jsonb)`);
      const before = await s.readState(); s.aGate.release();
      expect(await a).toMatchObject({message:'outbound_lease_lost'});
      expect(await s.readState()).toEqual(before); expect(s.remote).not.toHaveBeenCalled();
    } finally { s.aGate.release(); s.bGate.release(); await a; }
  });
});

describe('protocolo único sobre snapshots persistidos no PostgreSQL', () => {
  it('watchdog não disputa transporte de mensagens que pertencem ao ledger', async () => {
    await snapshot('queued','prepared');
    await db.pool.query("update messages set created_at=now()-interval '1 hour',sent_via='ai'");
    const fetch = vi.spyOn(globalThis,'fetch').mockResolvedValue(Response.json({key:{id:'legacy-id'}}));
    const cfg = {redriveMinAgeMs:1,redriveBatchSize:10,redriveSpacingMs:0,wahaBaseUrl:'http://test.invalid',wahaApiKey:'synthetic'} as WatchdogConfig;
    const log = {info:vi.fn(),warn:vi.fn(),error:vi.fn(),debug:vi.fn()};
    expect(await redriveQueued(db.pool,cfg,log)).toBe(0); expect(fetch).not.toHaveBeenCalled();
    // Controle positivo do filtro: a mensagem legada sem ledger continua visível.
    await db.pool.query("update messages set metadata='{}'::jsonb");
    expect(await redriveQueued(db.pool,cfg,log)).toBe(1); expect(fetch).toHaveBeenCalledOnce();
  });
  it('executor inline usa claim canônico e completa grafo/job atomicamente', async () => {
    expect(await runInline('inline-owner')).toBe(1);
    expect((await db.pool.query('select status,locked_by from job_queue')).rows[0]).toEqual({status:'done',locked_by:null});
    expect((await db.pool.query('select current_node_id from followup_enrollments')).rows[0]?.current_node_id).toBe('end');
    expect(transport).toHaveBeenCalledOnce();
  });
  it('falha ao finalizar depois da rede mantém estado retomável sem repetir envio', async () => {
    await db.pool.query(`create or replace function refuse_done() returns trigger language plpgsql as $$ begin
      if new.status='done' then raise exception 'injected crash before commit'; end if; return new; end $$`);
    await db.pool.query('create trigger refuse_done before update on job_queue for each row execute function refuse_done()');
    try {
      await runInline('first');
      expect((await db.pool.query('select current_node_id from followup_enrollments')).rows[0]?.current_node_id).toBe('node');
      expect((await db.pool.query('select status from job_queue')).rows[0]?.status).toBe('pending');
    } finally { await db.pool.query('drop trigger refuse_done on job_queue'); }
    await db.pool.query('update job_queue set run_after=now()');
    await runInline('second'); expect(transport).toHaveBeenCalledOnce();
    expect((await db.pool.query('select status from job_queue')).rows[0]?.status).toBe('done');
  });
  it('crash após claim é recuperável pelo reaper canônico', async () => {
    const [job] = await claim('dead-owner'); expect(job?.locked_at).toBeTruthy(); expect(job?.locked_by).toBe('dead-owner');
    expect(await expire()).toEqual({revived:1,dead:0});
    expect((await claim('new-owner'))[0]?.locked_by).toBe('new-owner');
  });
  it.each(['inline','worker'])('crash após requested sem message retoma mesma identidade via %s', async (consumer) => {
    await claim('old'); await snapshot(); await expire(); await claim('new');
    const result = consumer==='inline'?await inline('new'):await worker('new');
    expect('kind' in result?result.kind:result.status).toBe('sent');
    expect(transport).toHaveBeenCalledOnce();
    expect((await db.pool.query('select id from messages')).rows).toEqual([{id:KEY}]);
  });
  it.each(['queued','sending','unknown'])('%s sem confirmação nunca significa sent', async (status) => {
    expect(decideOutboundRecovery('requested',{id:KEY,status,external_id:null,metadata:{outbound_attempt:{phase:status==='queued'?'prepared':'started'}}})).not.toBe('confirmed');
  });
  it('crash antes do marcador de rede permite retomada da mensagem preparada', async () => {
    await snapshot('queued','prepared'); await claim('worker');
    expect((await worker('worker')).kind).toBe('sent'); expect(transport).toHaveBeenCalledOnce();
    expect((await db.pool.query('select count(*)::int as n from messages')).rows[0]?.n).toBe(1);
  });
  it('rejeição comprovada retentável preserva a key e permite nova chamada', async () => {
    await claim('worker'); transport.mockRejectedValueOnce(new DeliveryRejectedError('rate_limited',true));
    expect((await worker('worker')).kind).toBe('failed');
    expect((await worker('worker')).kind).toBe('sent'); expect(transport).toHaveBeenCalledTimes(2);
    expect((await db.pool.query('select count(*)::int as n from messages')).rows[0]?.n).toBe(1);
  });
  it('timeout é incerto, termina o job e não autoriza reenvio', async () => {
    await claim('worker'); transport.mockRejectedValueOnce(new Error('timeout after possible accept'));
    expect((await worker('worker')).kind).toBe('failed');
    expect((await db.pool.query('select status,last_error from job_queue')).rows[0]).toMatchObject({status:'failed',last_error:'outbound_delivery_uncertain'});
    await expect(worker('worker')).rejects.toThrow('outbound_lease_lost'); expect(transport).toHaveBeenCalledOnce();
  });
  it.each(['inline','worker'])('started + requested após crash nunca confirma nem reenvia via %s', async (consumer) => {
    await snapshot('sending','started'); await claim('worker');
    const result=consumer==='inline'?await inline('worker'):await worker('worker');
    expect('kind' in result?result.kind:result.status).toBe('failed'); expect(transport).not.toHaveBeenCalled();
    expect((await db.pool.query('select status,last_error from send_ledger')).rows[0]).toMatchObject({status:'failed',last_error:'outbound_delivery_uncertain'});
  });
  it('cron stuck + engine não transforma timeout em autorização de envio', async () => {
    await snapshot('sending','started');
    await db.pool.query("update messages set created_at=now()-interval '1 hour'");
    expect((await recoverStuckMessages(db.supabase,new Date(),'test')).failed).toBe(1);
    await claim('worker'); expect((await worker('worker')).kind).toBe('failed'); expect(transport).not.toHaveBeenCalled();
  });
  it.each(['inline','worker'])('confirmação persistida por %s é reconciliada pelo outro consumidor', async (first) => {
    await claim('old');
    if(first==='inline')await inline('old');else await worker('old');
    // Snapshot de crash antes de finalizar job; o reaper troca o proprietário.
    await expire(); await claim('new');
    const r=first==='inline'?await worker('new'):await inline('new');
    expect('kind' in r?r.kind:r.status).toBe(first==='inline'?'already_sent':'sent');
    expect(transport).toHaveBeenCalledOnce();
  });
  it('dois consumidores concorrentes: CAS permite no máximo um transporte', async () => {
    await claim('worker');
    await Promise.allSettled([worker('worker'),inline('worker')]);
    expect(transport).toHaveBeenCalledOnce();
    expect((await db.pool.query('select count(*)::int as n from messages')).rows[0]?.n).toBe(1);
  });
  it('concorrência não troca o corpo da identidade já persistida', async () => {
    await claim('worker');
    await Promise.allSettled([
      sendTurnMessage(db.pool,{supabase:db.supabase},{...input('worker'),body:'Corpo original'}), inline('worker'),
    ]);
    expect(transport).toHaveBeenCalledOnce();
    const persisted = (await db.pool.query('select body from messages')).rows[0]?.body;
    expect(transport.mock.calls[0]?.[0].body).toBe(persisted);
  });
  it('owner antigo não envia, não finaliza efeitos e não requeueia lease novo', async () => {
    await claim('old'); await expire(); await claim('new');
    await expect(worker('old')).rejects.toThrow('outbound_lease_lost');
    await expect(withJobLease(db.pool,JOB,'old',ORG,async()=>{ throw new Error('must not execute'); })).rejects.toThrow('outbound_lease_lost');
    await expect(completeJob(db.pool,JOB,'old',async(tx)=>{
      await tx.query('insert into agent_inbox_items(organization_id) values($1)',[ORG]);
    })).rejects.toThrow(/lease/);
    expect((await db.pool.query('select * from agent_inbox_items')).rows).toEqual([]);
    expect(await rescheduleJob(db.pool,JOB,'old',{delayMs:1,reason:'wrong owner'})).toBeNull();
    expect((await db.pool.query('select locked_by from job_queue')).rows[0]?.locked_by).toBe('new');
    expect(transport).not.toHaveBeenCalled();
    expect(await withJobLease(db.pool,JOB,'new',ORG,async()=> 'owned')).toBe('owned');
  });
  it('tenant diferente não adota lease/ledger', async () => {
    await claim('worker');
    await expect(sendTurnMessage(db.pool,{supabase:db.supabase},{...input('worker'),tenantId:'20000000-0000-4000-8000-000000000001'})).rejects.toThrow('outbound_lease_lost');
    expect(transport).not.toHaveBeenCalled();
  });
});
