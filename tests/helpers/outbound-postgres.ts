import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import type pg from 'pg';
import type { SupabaseClient } from '@supabase/supabase-js';

export const ORG = '10000000-0000-4000-8000-000000000001';
export const CONTACT = '10000000-0000-4000-8000-000000000002';
export const JOB = '10000000-0000-4000-8000-000000000003';
export const CONV = '10000000-0000-4000-8000-000000000004';
export const SESSION = '10000000-0000-4000-8000-000000000005';
export const ENROLLMENT = '10000000-0000-4000-8000-000000000006';
const VERSION = '10000000-0000-4000-8000-000000000008';

/** PostgreSQL embarcado para provar os SQLs/CAS reais sem depender de Docker.
 * PGlite é single-connection: connect serializa transações, como o lock de job;
 * não pretende medir throughput nem SKIP LOCKED entre servidores. */
export async function outboundPostgres() {
  const sql = new PGlite();
  await sql.exec(`
    create table job_queue(id uuid primary key, organization_id uuid not null, contact_id uuid,
      kind text default 'followup_turn', status text default 'pending', payload jsonb default '{}',
      priority smallint default 100, run_after timestamptz default now(), attempts smallint default 0,
      max_attempts smallint default 5, locked_by text, locked_at timestamptz, last_error text,
      created_at timestamptz default now(), source_event_id uuid);
    create unique index lane on job_queue(contact_id) where status='running';
    create table send_ledger(id uuid primary key default gen_random_uuid(), organization_id uuid,
      contact_id uuid, job_id uuid references job_queue(id), seq smallint, body_hash text,
      status text default 'requested', crm_message_id uuid, last_error text,
      created_at timestamptz default now(), updated_at timestamptz default now(), unique(job_id,seq));
    create table automation_rule_runs(id uuid primary key,organization_id uuid);
    create table messages(id uuid primary key default gen_random_uuid(), organization_id uuid,
      conversation_id uuid, contact_id uuid, channel_session_id uuid, status text, external_id text,
      type text, body text, media_derived_text text, direction text, metadata jsonb default '{}', ack int,
      error_code text, error_message text, sent_via text, sent_by_user_id uuid, sent_at timestamptz,
      delivered_at timestamptz, read_at timestamptz, updated_at timestamptz default now(), created_at timestamptz default now(),
      reply_to_message_id uuid, media_url text, media_mime text, media_storage_path text, media_size_bytes bigint,
      template_name text, template_language text);
    create table channel_sessions(id uuid primary key, organization_id uuid, provider text default 'waha',
      status text default 'WORKING', archived_at timestamptz, waha_session_name text default 'default');
    create table contacts(id uuid primary key, organization_id uuid, phone_number text,
      is_blocked boolean default false, is_anonymized boolean default false, consent jsonb default '{}',
      force_human boolean default false,is_merged_into uuid,
      last_activity_at timestamptz, wa_identity text, wa_lid text);
    create table conversations(id uuid primary key, organization_id uuid, contact_id uuid, channel_session_id uuid,
      status text default 'open', is_group boolean default false, group_chat_id text, bot_silenced_until timestamptz,
      provider_conversation_id text, last_inbound_at timestamptz, last_outbound_at timestamptz,
      last_message_at timestamptz, last_message_preview text, unread_count_for_assignee int,
      created_at timestamptz default now(), updated_at timestamptz default now());
    create table followup_enrollments(id uuid primary key, organization_id uuid, contact_id uuid, conversation_id uuid,
      current_node_id text, status text default 'active', version_id uuid, pointer_id uuid, steps_taken int default 0,
      attempts int default 0,max_attempts int default 5, next_eval_at timestamptz,claimed_until timestamptz,
      started_at timestamptz default now(),updated_at timestamptz default now());
    create table followup_flow_versions(id uuid primary key,organization_id uuid,graph jsonb);
    create table followup_enrollment_events(organization_id uuid,enrollment_id uuid,node_id text,event_type text,
      payload jsonb,idempotency_key text,unique(enrollment_id,idempotency_key));
    create table agent_inbox_items(organization_id uuid,kind text,severity text,title text,body text,ref_kind text,ref_id uuid);
    create table obra_access_integrations(id uuid primary key,organization_id uuid,pipeline_id uuid,
      lifecycle_enabled boolean default false,is_active boolean default false,outreach_enabled boolean default false,
      outreach_channel_id uuid,recovery_pointer_id uuid);
    create table obra_subscription_states(id uuid primary key,organization_id uuid,integration_id uuid,contact_id uuid,
      lead_id uuid,checked_at timestamptz,trial_started_at timestamptz,trial_ends_at timestamptz,
      converted_at timestamptz,recovery_started_at timestamptz,decision text,em_trial boolean);
    create table obra_subscription_outreach(organization_id uuid,state_id uuid,kind text,due_at timestamptz,
      event_id uuid,rule_id uuid,recovery_armed_at timestamptz);
    create table crm_pipelines(id uuid primary key,organization_id uuid,name text,is_archived boolean default false,position numeric default 0);
    create table crm_stages(id uuid primary key,organization_id uuid,pipeline_id uuid,name text,is_archived boolean default false,position numeric default 0);
    create table crm_leads(id uuid,organization_id uuid,contact_id uuid,pipeline_id uuid,status text,
      stage_id uuid,last_activity_at timestamptz,created_at timestamptz default now());
    create table event_log(id uuid,organization_id uuid,entity_id uuid);
    create table automation_rules(id uuid,organization_id uuid,is_active boolean,trigger_event text,actions jsonb);
  `);
  // A fixture do ledger usa as guardas SQL reais. Nenhum vínculo Obra por padrão:
  // as provas antigas continuam exercitando contatos/workspaces sem a integração.
  const outreachMigration = readFileSync('supabase/migrations/20261008230000_0231_obra_subscription_outreach.sql', 'utf8');
  for (const name of ['fn_obra_outreach_send_live', 'fn_obra_followup_live']) {
    const definition = outreachMigration.match(new RegExp(`create or replace function public\\.${name}\\([\\s\\S]+?\\$\\$;`))?.[0];
    if (!definition) throw new Error(`Guarda SQL ausente na migration: ${name}`);
    await sql.exec(definition);
  }
  let tail = Promise.resolve();
  async function lock() { let release!: () => void; const next = new Promise<void>((r) => { release = r; }); const old = tail; tail = next; await old; return release; }
  const query = async (text: string, values: unknown[] = []) => {
    const r = await sql.query(text, values);
    return { rows: r.rows, rowCount: r.rows.length || r.affectedRows || 0 };
  };
  const pool = {
    async query(text: string, values?: unknown[]) { const release = await lock(); try { return await query(text, values); } finally { release(); } },
    async connect() { const release = await lock(); return { query, release }; },
  } as unknown as pg.Pool;

  const supabase = { from(table: string) {
    const filters: string[] = []; const values: unknown[] = []; let mode = 'select'; let payload: Record<string, unknown> = {};
    const col = (key: string) => key === 'metadata->>idempotency_key' ? "metadata->>'idempotency_key'" : `"${key}"`;
    const where = () => filters.length ? ` where ${filters.join(' and ')}` : '';
    const execute = async () => {
      try {
        let result;
        if (mode === 'select') result = await pool.query(`select * from ${table}${where()}`, values);
        else if (mode === 'delete') result = await pool.query(`delete from ${table}${where()} returning *`, values);
        else {
          const keys = Object.keys(payload).filter((k) => payload[k] !== undefined);
          const vals = keys.map((k) => typeof payload[k] === 'object' && payload[k] !== null ? JSON.stringify(payload[k]) : payload[k]);
          if (mode === 'insert') result = await pool.query(`insert into ${table}(${keys.map(col).join(',')}) values (${keys.map((_,i)=>`$${i+1}`).join(',')}) returning *`, vals);
          else result = await pool.query(`update ${table} set ${keys.map((k,i)=>`${col(k)}=$${values.length+i+1}`).join(',')}${where()} returning *`, [...values,...vals]);
        }
        if (table === 'conversations' && mode === 'select') for (const r of result.rows) {
          r.contacts = (await pool.query('select * from contacts where id=$1',[r.contact_id])).rows[0];
          r.channel_sessions = (await pool.query('select * from channel_sessions where id=$1',[r.channel_session_id])).rows[0];
        }
        return { data: result.rows, error: null };
      } catch (error) { return { data: null, error: error as { code?: string; message: string } }; }
    };
    const q = {
      select: () => q, order: () => q, limit: () => q,
      eq(k: string,v: unknown) { values.push(v); filters.push(`${col(k)}=$${values.length}`); return q; },
      filter(k: string, op: string, v: unknown) { if (op !== 'eq') throw new Error('unsupported filter'); return q.eq(k, v); },
      neq(k: string,v: unknown) { values.push(v); filters.push(`${col(k)}<>$${values.length}`); return q; },
      lt(k: string,v: unknown) { values.push(v); filters.push(`${col(k)}<$${values.length}`); return q; },
      lte(k: string,v: unknown) { values.push(v); filters.push(`${col(k)}<=$${values.length}`); return q; },
      is(k: string,_v: null) { filters.push(`${col(k)} is null`); return q; },
      in(k: string,v: unknown[]) { values.push(v); filters.push(`${col(k)}=any($${values.length})`); return q; },
      insert(p: Record<string,unknown>) { mode='insert';payload=p;return q; },
      update(p: Record<string,unknown>) { mode='update';payload=p;return q; },
      delete() { mode='delete';return q; },
      async maybeSingle() { const r=await execute(); return {...r,data:r.data?.[0]??null}; },
      async single() { return q.maybeSingle(); },
      async then(resolve: (v: Awaited<ReturnType<typeof execute>>)=>unknown) { return resolve(await execute()); },
    };return q;
  }, rpc: async (name: string) => ({data:name==='fn_automation_message_live'?true:name==='fn_automation_message_preview'?false:null,error:null}) } as unknown as SupabaseClient;

  async function seed() {
    await sql.exec('truncate send_ledger,messages,job_queue,channel_sessions,contacts,conversations,followup_enrollments,agent_inbox_items,followup_flow_versions,followup_enrollment_events,obra_access_integrations,obra_subscription_states,obra_subscription_outreach,crm_leads,crm_pipelines,crm_stages,event_log,automation_rules cascade');
    await pool.query('insert into job_queue(id,organization_id,contact_id,payload) values ($1,$2,$3,$4)',[JOB,ORG,CONTACT,JSON.stringify({fixed_body:'Oi',followup_enrollment_id:ENROLLMENT,node_id:'node'})]);
    await pool.query('insert into contacts(id,organization_id,phone_number) values ($1,$2,$3)',[CONTACT,ORG,'+5511000000000']);
    await pool.query('insert into channel_sessions(id,organization_id) values ($1,$2)',[SESSION,ORG]);
    await pool.query('insert into conversations(id,organization_id,contact_id,channel_session_id) values ($1,$2,$3,$4)',[CONV,ORG,CONTACT,SESSION]);
    await pool.query('insert into followup_enrollments(id,organization_id,contact_id,conversation_id,current_node_id,version_id) values ($1,$2,$3,$4,$5,$6)',[ENROLLMENT,ORG,CONTACT,CONV,'node',VERSION]);
    await pool.query('insert into followup_flow_versions(id,organization_id,graph) values($1,$2,$3)',[VERSION,ORG,JSON.stringify({nodes:[
      {id:'node',type:'action',label:'Envio',position:{x:0,y:0},config:{mode:'text',body:'Oi'}},
      {id:'end',type:'end',label:'Fim',position:{x:0,y:0},config:{outcome:'exhausted'}},
    ],edges:[{id:'edge',source:'node',target:'end',priority:0,condition:{type:'always'}}]})]);
  }
  return { pool, supabase, seed, close: () => sql.close() };
}
