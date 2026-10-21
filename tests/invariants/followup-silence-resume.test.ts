import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { pgComoSupabase } from '@/tests/pg-como-supabase';
import { createSupabaseSilenceSweepDb } from '@/lib/followup/silence-sweep';
import { applyReactivityEvent, createSupabaseReactivityClient } from '@/lib/followup/reactivity';

if (!process.env.TEST_DB_CONTAINER) throw new Error('Rode via pnpm test:db');
const pool = new pg.Pool({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 5, application_name: 'silence-resume-invariant' });
const org = randomUUID();
const admin = pgComoSupabase(pool);
let input: { organization_id: string; pointer_id: string; version_id: string; contact_id: string;
  current_node_id: string; next_eval_at: string; agent_id: null };
let enrollment: string;
beforeAll(async () => {
  await pool.query('insert into organizations(id,slug,legal_name,display_name) values($1,$2,$3,$3)',
    [org, `resume-${org}`, 'Empresa sintética']);
});
afterAll(async () => { await pool.query('delete from organizations where id=$1', [org]); await pool.end(); });
beforeEach(async () => {
  const contact = (await pool.query<{ id: string }>("insert into contacts(organization_id,display_name) values($1,'Lead sintético') returning id", [org])).rows[0]!.id;
  const session = (await pool.query<{ id: string }>(`insert into channel_sessions(organization_id,waha_session_name,status,webhook_secret_encrypted)
    values($1,$2,'WORKING','synthetic') returning id`, [org, randomUUID()])).rows[0]!.id;
  const conversation = (await pool.query<{ id: string }>(`insert into conversations(organization_id,contact_id,channel_session_id,status,last_inbound_at)
    values($1,$2,$3,'ai_handling',now()-interval '3 hours') returning id`, [org,contact,session])).rows[0]!.id;
  const graph = { nodes: [{ id: 'pending', type: 'action', config: { mode: 'text', body: 'Etapa pendente' } }], edges: [] };
  const version = (await pool.query<{ id: string }>('insert into followup_flow_versions(organization_id,graph) values($1,$2) returning id', [org,graph])).rows[0]!.id;
  const pointer = (await pool.query<{ id: string }>(`insert into followup_flow_pointers(organization_id,name,status,active_version_id,trigger_config)
    values($1,$2,'active',$3,'{"kind":"silence","params":{"threshold_minutes":120},"cancel_on_reply":true}') returning id`, [org,randomUUID(),version])).rows[0]!.id;
  enrollment = (await pool.query<{ id: string }>(`insert into followup_enrollments(organization_id,pointer_id,version_id,contact_id,current_node_id,
    started_at,next_eval_at,steps_taken) values($1,$2,$3,$4,'pending',now()-interval '1 day',now()-interval '1 minute',14) returning id`,
  [org,pointer,version,contact])).rows[0]!.id;
  await pool.query(`insert into messages(organization_id,contact_id,conversation_id,channel_session_id,type,direction,status,body,sent_at)
    values($1,$2,$3,$4,'text','inbound','received','Ainda avaliando',now()-interval '3 hours')`, [org,contact,conversation,session]);
  input = { organization_id: org, pointer_id: pointer, version_id: version, contact_id: contact,
    current_node_id: 'trigger', next_eval_at: new Date().toISOString(), agent_id: null };
});
const resume = () => createSupabaseSilenceSweepDb(admin).insertEnrollment(input);

describe('continuação automática após resposta contra PostgreSQL real', () => {
  it('o adaptador realmente restringe arrays, inclusive vazios e com IDs de outra organização', async () => {
    const selected = await admin.from('contacts').select('id').eq('organization_id',org).in('id',[input.contact_id,randomUUID()]);
    expect(selected.error).toBeNull(); expect(selected.data).toEqual([{ id:input.contact_id }]);
    expect((await admin.from('contacts').select('id').eq('organization_id',org).in('id',[])).data).toEqual([]);
    expect((await admin.from('contacts').select('id').eq('organization_id',randomUUID()).in('id',[input.contact_id])).data).toEqual([]);
  });
  it('duas varreduras concorrentes retomam uma única inscrição, sem zerar etapas', async () => {
    expect((await Promise.all([resume(),resume()])).map(x => x.inserted).sort()).toEqual([false,true]);
    const rows = await pool.query('select id,status,steps_taken,node_epoch from followup_enrollments where organization_id=$1 and contact_id=$2', [org,input.contact_id]);
    expect(rows.rows).toEqual([{ id: enrollment, status: 'active', steps_taken: 14, node_epoch: 1 }]);
  });
  it('o mesmo contato não permite acesso por outra organização', async () => {
    expect(await createSupabaseSilenceSweepDb(admin).insertEnrollment({ ...input,organization_id: randomUUID() })).toEqual({ inserted: false });
    expect(await resume()).toEqual({ inserted: true });
  });
  it('um replay com snapshot antigo não cancela a inscrição reativada', async () => {
    const reactivity = createSupabaseReactivityClient(admin);
    await pool.query("update followup_enrollments set status='active',next_eval_at=now(),completed_at=null where id=$1", [enrollment]);
    const [old] = await reactivity.loadLiveEnrollmentsForContact(org,input.contact_id);
    expect(old).toBeDefined();
    await pool.query("update followup_enrollments set status='cancelled',outcome='replied',cancel_reason='cancel_on_reply',next_eval_at=null where id=$1", [enrollment]);
    expect(await resume()).toEqual({ inserted: true });
    await reactivity.updateEnrollment(enrollment,org,{ status:'cancelled',outcome:'replied' },old);
    expect((await pool.query('select status from followup_enrollments where id=$1', [enrollment])).rows[0]!.status).toBe('active');
    const [current] = await reactivity.loadLiveEnrollmentsForContact(org,input.contact_id);
    expect(Date.parse(current!.started_at!)).toBeGreaterThan(Date.now()-60_000);
  });
  it('replay anterior à retomada é ignorado, mas uma resposta nova interrompe normalmente', async () => {
    expect(await resume()).toEqual({ inserted:true });
    const reactivity = createSupabaseReactivityClient(admin);
    const event = { id:randomUUID(),organization_id:org,event_type:'message.received',entity_kind:'message',entity_id:randomUUID(),
      payload:{ contact_id:input.contact_id },metadata:{},consumed_by:[],attempts:0,created_at:new Date(Date.now()-3_600_000).toISOString() };
    expect(await applyReactivityEvent(reactivity,()=>new Date(),event)).toEqual({ matched:true,reacted:0 });
    expect(await applyReactivityEvent(reactivity,()=>new Date(),{ ...event,id:randomUUID(),created_at:new Date().toISOString() })).toEqual({ matched:true,reacted:1 });
    expect((await pool.query('select status from followup_enrollments where id=$1', [enrollment])).rows[0]!.status).toBe('cancelled');
  });
  it('reaplicar o baseline completo preserva a inscrição que já retomou', async () => {
    expect(await resume()).toEqual({ inserted:true });
    execFileSync('docker',['exec','-i',process.env.TEST_DB_CONTAINER!,'psql','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1','-q','-f','-'],
      { input:readFileSync('supabase/baseline.sql'),stdio:['pipe','pipe','pipe'],timeout:60_000 });
    const row = (await pool.query('select status,steps_taken,node_epoch,silence_anchor_at from followup_enrollments where id=$1', [enrollment])).rows[0]!;
    expect(row).toMatchObject({ status:'active',steps_taken:14,node_epoch:1 });
    expect(row.silence_anchor_at).not.toBeNull();
  });
  it('uma pausa humana concorrente vence antes da retomada obter o lock', async () => {
    const human = await pool.connect();
    await human.query('begin');
    await human.query('select id from contacts where organization_id=$1 and id=$2 for update', [org,input.contact_id]);
    await human.query('update contacts set force_human=true where organization_id=$1 and id=$2', [org,input.contact_id]);
    const pending = resume();
    try {
      let waiting = false;
      for (let i=0;i<40 && !waiting;i++) {
        waiting = (await pool.query<{ n: number }>(`select count(*)::int n from pg_stat_activity where application_name='silence-resume-invariant'
          and wait_event_type='Lock' and query like '%fn_enroll_silence_episode%'`)).rows[0]!.n>0;
        if (!waiting) await new Promise(resolve => setTimeout(resolve,20));
      }
      expect(waiting).toBe(true);
      await human.query('commit');
      expect(await pending).toEqual({ inserted:false });
    } finally { await human.query('rollback'); human.release(); await pending; }
  });
});
