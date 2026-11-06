import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';

if (!process.env.TEST_DB_CONTAINER) throw new Error('Rode via pnpm test:db (banco descartável)');
const pool = new pg.Pool({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`, max: 3 });
let org: string, session: string, pointer: string, version: string;
beforeEach(async () => {
  org = randomUUID();
  await pool.query('insert into organizations(id,slug,legal_name,display_name) values($1,$2,$3,$3)', [org, org, 'Empresa de teste isolado']);
  session = (await pool.query(`insert into channel_sessions(organization_id,waha_session_name,status,webhook_secret_encrypted)
    values($1,$2,'WORKING','synthetic') returning id`, [org, randomUUID()])).rows[0]!.id;
  const graph = { nodes: [{ id: 'trigger', type: 'trigger', config: {} },
    { id: 'pending', type: 'action', config: { mode: 'text', body: 'Texto sintético' } }], edges: [] };
  version = (await pool.query('insert into followup_flow_versions(organization_id,graph) values($1,$2) returning id', [org, graph])).rows[0]!.id;
  pointer = (await pool.query(`insert into followup_flow_pointers(organization_id,name,status,active_version_id,trigger_config)
    values($1,$2,'active',$3,'{"kind":"silence","params":{"threshold_minutes":120},"cancel_on_reply":true}') returning id`,
  [org, randomUUID(), version])).rows[0]!.id;
});
afterEach(async () => { await pool.query('delete from organizations where id=$1', [org]); });
afterAll(async () => { await pool.end(); });
async function contacts(n: number): Promise<string[]> {
  const rows = await pool.query(`with c as (insert into contacts(organization_id,display_name)
    select $1,'Atleta sintético' from generate_series(1,$2::int) returning id)
    insert into conversations(organization_id,contact_id,channel_session_id,status,last_inbound_at)
    select $1,c.id,$3,'ai_handling',now()-interval '3 hours' from c returning contact_id`, [org,n,session]);
  return rows.rows.map(r => r.contact_id as string).sort();
}
const page = async (after: string | null = null, targetOrg = org) => (await pool.query(
  'select * from public.fn_silence_contact_page($1,now()-interval \'2 hours\',$2::text[],$3,50)', [targetOrg,[],after])).rows as Array<{ contact_id: string }>;
const input = (contact: string) => ({ organization_id: org, pointer_id: pointer, version_id: version, contact_id: contact,
  current_node_id: 'trigger', next_eval_at: new Date().toISOString(), agent_id: null });
const batch = async (ids: string[]) => (await pool.query('select * from public.fn_enroll_silence_batch($1::jsonb)',
  [JSON.stringify(ids.map(input))])).rows as Array<{ contact_id: string; inserted: boolean }>;

describe('seleção e inscrição limitadas contra Postgres real', () => {
  it('pagina 65 contatos, não transfere metadata e exclui quem já está em acompanhamento', async () => {
    const ids = await contacts(65);
    const first = await page(); expect(first.map(r => r.contact_id)).toEqual(ids.slice(0,50));
    const second = await page(first.at(-1)!.contact_id); expect(second.map(r => r.contact_id)).toEqual(ids.slice(50));
    expect((await batch(ids.slice(0,50))).filter(r => r.inserted)).toHaveLength(50);
    expect((await page()).map(r => r.contact_id)).toEqual(ids.slice(50));
    expect((await batch(ids.slice(0,50))).some(r => r.inserted)).toBe(false);
    expect((await pool.query('select count(*)::int n from followup_enrollments where organization_id=$1', [org])).rows[0]!.n).toBe(50);
  });
  it('reduz pela conversa mais recente e respeita encerramento, bloqueio e gate do canal', async () => {
    const ids = await contacts(4);
    await pool.query("update conversations set last_inbound_at=now() where contact_id=$1", [ids[0]]);
    await pool.query("update conversations set status='closed' where contact_id=$1", [ids[1]]);
    await pool.query('update contacts set is_blocked=true where id=$1', [ids[2]]);
    expect((await page()).map(r => r.contact_id)).toEqual([ids[3]]);
    await pool.query('update channel_sessions set metadata=$2 where id=$1', [session, { ai_gate: 'allowlist' }]);
    expect(await page()).toEqual([]);
    await pool.query('update contacts set ai_authorized_at=now() where id=$1', [ids[3]]);
    expect((await page()).map(r => r.contact_id)).toEqual([ids[3]]);
  });
  it('pausa humana entre seleção e lote prevalece; um replay não reinicia o orçamento', async () => {
    const [id] = await contacts(1);
    expect(await page()).toHaveLength(1);
    await pool.query('update contacts set force_human=true where id=$1', [id]);
    expect(await batch([id!])).toEqual([{ contact_id: id, inserted: false }]);
    await pool.query('update contacts set force_human=false where id=$1', [id]);
    expect((await batch([id!]))[0]!.inserted).toBe(true);
    await pool.query(`update followup_enrollments set status='cancelled',outcome='replied',cancel_reason='cancel_on_reply',
      started_at=now()-interval '1 day',silence_anchor_at=now()-interval '1 day',completed_at=now()-interval '4 hours',
      current_node_id='pending',steps_taken=14,next_eval_at=null where organization_id=$1`, [org]);
    expect((await batch([id!]))[0]!.inserted).toBe(true);
    expect((await pool.query('select status,steps_taken from followup_enrollments where organization_id=$1', [org])).rows)
      .toEqual([{ status: 'active', steps_taken: 14 }]);
    expect((await batch([id!]))[0]!.inserted).toBe(false);
  });
  it('não expõe RPC a anon/authenticated nem permite lote misturando organizações', async () => {
    const [id] = await contacts(1);
    expect(await page(null, randomUUID())).toEqual([]);
    const permissions = await pool.query(`select r,has_function_privilege(r,'public.fn_enroll_silence_batch(jsonb)','execute') batch,
      has_function_privilege(r,'public.fn_silence_contact_page(uuid,timestamp with time zone,text[],uuid,integer)','execute') candidates
      from unnest(array['anon','authenticated','service_role']) r`);
    expect(permissions.rows).toEqual([{ r: 'anon', batch: false, candidates: false },
      { r: 'authenticated', batch: false, candidates: false }, { r: 'service_role', batch: true, candidates: true }]);
    await expect(pool.query('select * from public.fn_enroll_silence_batch($1::jsonb)',
      [JSON.stringify([input(id!), { ...input(id!), organization_id: randomUUID() }])])).rejects.toMatchObject({ code: '22023' });
    expect((await pool.query('select count(*)::int n from followup_enrollments where organization_id=$1', [org])).rows[0]!.n).toBe(0);
  });
});
