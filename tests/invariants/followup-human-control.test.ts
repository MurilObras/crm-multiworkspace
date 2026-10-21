import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { createPgAdminClient } from '@/lib/followup/turn-bridge';

if (!process.env.TEST_DB_CONTAINER) throw new Error('Rode via pnpm test:db');
const pool = new pg.Pool({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 4, application_name: 'followup-human-control-invariant' });
const db = createPgAdminClient(pool);
const ORG = randomUUID();
let contact: string, enrollment: string;
beforeAll(async () => {
  await pool.query('insert into organizations(id,slug,legal_name,display_name) values($1,$2,$3,$4)',
    [ORG, `human-control-${ORG}`, 'Organização de teste', 'Organização de teste']);
});
afterAll(async () => { await pool.query('delete from organizations where id=$1', [ORG]); await pool.end(); });
beforeEach(async () => {
  await pool.query('delete from followup_enrollments where organization_id=$1', [ORG]);
  contact = (await pool.query<{ id: string }>("insert into contacts(organization_id,display_name) values($1,'Contato sintético') returning id", [ORG])).rows[0]!.id;
  const graph = { nodes: [
    { id: 'action', type: 'action', label: 'Retorno', position: { x: 0, y: 0 }, config: { mode: 'text', body: 'Olá' } },
    { id: 'end', type: 'end', label: 'Fim', position: { x: 0, y: 100 }, config: { outcome: 'exhausted' } },
  ], edges: [{ id: 'edge', source: 'action', target: 'end', priority: 0, condition: { type: 'always' } }] };
  const version = (await pool.query<{ id: string }>('insert into followup_flow_versions(organization_id,graph) values($1,$2) returning id', [ORG, JSON.stringify(graph)])).rows[0]!.id;
  const pointer = (await pool.query<{ id: string }>(`insert into followup_flow_pointers(organization_id,name,status,active_version_id,trigger_config)
    values($1,$2,'active',$3,'{"kind":"manual","cancel_on_reply":true}') returning id`, [ORG, randomUUID(), version])).rows[0]!.id;
  enrollment = (await pool.query<{ id: string }>(`insert into followup_enrollments(organization_id,pointer_id,version_id,contact_id,
    current_node_id,next_eval_at,started_at) values($1,$2,$3,$4,'action',now()-interval '1 minute',now()-interval '1 day') returning id`,
  [ORG, pointer, version, contact])).rows[0]!.id;
});
const event = { node_id: 'action', event_type: 'action_sent', payload: {}, idempotency_key: 'action:0' };
const patch = () => ({ current_node_id: 'end', status: 'active' as const, next_eval_at: new Date().toISOString(),
  steps_taken: 1, claimed_until: null, updated_at: new Date().toISOString() });

describe('lock/CAS da conclusão contra intervenção humana real', () => {
  it('duas conclusões concorrentes progridem exatamente uma vez', async () => {
    const snap = (await db.loadEnrollmentById(ORG, enrollment))!;
    expect((await Promise.all([db.completeStep(snap, event, patch()), db.completeStep(snap, event, patch())])).sort()).toEqual([false, true]);
    const row = (await db.loadEnrollmentById(ORG, enrollment))!;
    expect(row.current_node_id).toBe('end');
    expect(row.steps_taken).toBe(1);
    const count = await pool.query<{ n: number }>("select count(*)::integer as n from followup_enrollment_events where enrollment_id=$1 and event_type='action_sent'", [enrollment]);
    expect(count.rows[0]!.n).toBe(1);
  });
  it('espera o lock do humano e não sobrescreve sua pausa após o commit', async () => {
    const snap = (await db.loadEnrollmentById(ORG, enrollment))!;
    const human = await pool.connect();
    await human.query('begin');
    await human.query("update followup_enrollments set status='paused_manual',next_eval_at=null,updated_at=clock_timestamp() where organization_id=$1 and id=$2", [ORG, enrollment]);
    const pending = db.completeStep(snap, event, patch());
    let committed = false;
    try {
      let blocked = false;
      for (let i = 0; i < 30 && !blocked; i++) {
        const activity = await pool.query<{ n: number }>(`select count(*)::integer as n from pg_stat_activity
          where application_name='followup-human-control-invariant' and wait_event_type='Lock'
            and query like '%fn_followup_complete_step%'`);
        blocked = activity.rows[0]!.n > 0;
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(blocked, 'a conclusão precisa disputar o mesmo lock da pausa').toBe(true);
      await human.query('commit'); committed = true;
      expect(await pending).toBe(false);
      expect(await db.loadEnrollmentById(ORG, enrollment)).toMatchObject({ status: 'paused_manual', current_node_id: 'action', steps_taken: 0 });
    } finally {
      if (!committed) await human.query('rollback');
      human.release();
      await pending;
    }
  });
  it('não aplica um snapshot de outra organização', async () => {
    const snap = (await db.loadEnrollmentById(ORG, enrollment))!;
    expect(await db.completeStep({ ...snap, organization_id: randomUUID() }, event, patch())).toBe(false);
    expect((await db.loadEnrollmentById(ORG, enrollment))!.current_node_id).toBe('action');
  });
  it('funções de controle não são RPCs disponíveis para visitante/membro', async () => {
    const client = await pool.connect();
    try {
      for (const role of ['anon', 'authenticated']) {
        const grants = await client.query<{ allowed: boolean }>(`select has_function_privilege($1,signature,'EXECUTE') as allowed
          from unnest(array['public.fn_followup_complete_step(uuid,uuid,jsonb,jsonb,jsonb)',
            'public.fn_followup_job_live(uuid,uuid,uuid)','public.fn_enroll_silence_episode(jsonb)']) signature`, [role]);
        expect(grants.rows).toEqual([{ allowed: false }, { allowed: false }, { allowed: false }]);
        await client.query('begin');
        await client.query(`set local role ${role}`);
        await expect(client.query('select public.fn_followup_complete_step($1,$2,$3,$4,$5)', [ORG, enrollment, '{}', '{}', '{}']))
          .rejects.toMatchObject({ code: '42501', message: expect.stringContaining('permission denied for function fn_followup_complete_step') });
        await client.query('rollback');
      }
    } finally { client.release(); }
  });
});
