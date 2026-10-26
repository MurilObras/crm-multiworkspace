import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

if (!process.env.TEST_DB_CONTAINER) throw new Error('Rode via pnpm test:db: banco efêmero obrigatório.');
const pool = new pg.Pool({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${Number(process.env.TEST_DB_PORT ?? 54329)}/postgres`, max: 1 });
const tables = ['ai_agent_runs','ai_agents','ai_knowledge_sources','calendar_appointments','conversations',
  'crm_lead_activities','crm_lead_reactivations','crm_lead_risk_states','crm_leads','messages'];
const orgs = [randomUUID(), randomUUID()];
const user = randomUUID();
const conversations: string[] = [];

beforeAll(async () => {
  await pool.query('insert into auth.users(id,email) values($1,$2)', [user, `realtime-${user}@qa.local`]);
  for (const org of orgs) {
    const session = randomUUID(), contact = randomUUID(), conversation = randomUUID();
    conversations.push(conversation);
    await pool.query('insert into organizations(id,slug,legal_name,display_name) values($1,$2,$3,$3)', [org, `qa-rt-${org}`, 'QA Realtime']);
    await pool.query('insert into channel_sessions(id,organization_id,waha_session_name,webhook_secret_encrypted) values($1,$2,$3,decode($4,$5))', [session,org,`qa-rt-${session}`,'00','hex']);
    await pool.query('insert into contacts(id,organization_id,name,phone_number) values($1,$2,$3,$4)', [contact,org,'Contato sintético',`+55${String(parseInt(contact.slice(0,8),16)).padStart(11,'0')}`]);
    await pool.query('insert into conversations(id,organization_id,channel_session_id,contact_id) values($1,$2,$3,$4)', [conversation,org,session,contact]);
    await pool.query("insert into messages(organization_id,conversation_id,channel_session_id,contact_id,direction,type,body,status) values($1,$2,$3,$4,'inbound','text','QA: mensagem privada','delivered')", [org,conversation,session,contact]);
  }
  await pool.query("insert into user_organizations(user_id,organization_id,role,accepted_at) values($1,$2,'manager',now())", [user,orgs[0]]);
});
afterAll(() => pool.end());

async function asRole(role: 'anon' | 'authenticated', query: string, params: unknown[] = []) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(`set local role ${role}`);
    await client.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify(role === 'authenticated' ? {sub:user,role} : {role})]);
    return await client.query(query, params);
  } finally { try { await client.query('rollback'); } finally { client.release(); } }
}

describe('políticas privadas: anônimo não aborta a avaliação do Realtime', () => {
  it.each(tables)('%s nega leitura anônima sem executar helpers privados', async table => {
    try {
      const result = await asRole('anon', `select 1 from public.${table} limit 1`);
      expect(result.rows).toHaveLength(0);
    } catch (error) {
      // Algumas tabelas já negam SELECT no próprio GRANT. É uma barreira
      // válida; erro de execução de FUNÇÃO privada nunca é aceito aqui.
      expect(error).toMatchObject({ code: '42501', message: `permission denied for table ${table}` });
    }
  });
  it('o membro autenticado mantém acesso à sua conversa e mensagem, sem ler a outra organização', async () => {
    const conv = await asRole('authenticated', 'select id from conversations where organization_id=any($1::uuid[])', [orgs]);
    expect(conv.rows.map(r=>r.id)).toEqual([conversations[0]]);
    const msg = await asRole('authenticated', 'select conversation_id from messages where organization_id=any($1::uuid[])', [orgs]);
    expect(msg.rows.map(r=>r.conversation_id)).toEqual([conversations[0]]);
  });
  it('os helpers continuam privados: a correção não concede execução ao anônimo', async () => {
    const result = await pool.query("select has_function_privilege('anon','public.fn_can_view_conversation(uuid,uuid)','execute') as anon, has_function_privilege('authenticated','public.fn_can_view_conversation(uuid,uuid)','execute') as authenticated");
    expect(result.rows[0]).toEqual({ anon:false, authenticated:true });
  });
});
