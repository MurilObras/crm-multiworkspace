// @vitest-environment node
import { afterAll,beforeAll,beforeEach,describe,expect,it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

const ORG='10000000-0000-4000-8000-000000000001',OTHER='20000000-0000-4000-8000-000000000001';
const LEAD='10000000-0000-4000-8000-000000000002',CONTACT='10000000-0000-4000-8000-000000000003';
const PIPE='10000000-0000-4000-8000-000000000004',STAGE='10000000-0000-4000-8000-000000000005';
const ACTOR='10000000-0000-4000-8000-000000000006';
const sql=new PGlite();
/** Executa a migration real. Dependências são mínimas; o baseline completo,
 * o trigger de ganho e concorrência multiconexão continuam no gate de banco. */
beforeAll(async()=>{
  await sql.exec(`create role anon;create role authenticated;create role service_role bypassrls;
    create schema auth;create table auth.users(id uuid primary key);
    create table organizations(id uuid primary key,timezone text default 'America/Sao_Paulo',settings jsonb default '{}');
    create table contacts(id uuid primary key default gen_random_uuid(),organization_id uuid,is_anonymized boolean default false,is_blocked boolean default false,
      name text,email text,email_normalized text generated always as(lower(email))stored,phone_number text,source text,is_merged_into uuid);
    create table messages(id uuid,organization_id uuid,contact_id uuid,direction text);
    create table crm_pipelines(id uuid primary key,organization_id uuid,is_archived boolean default false,settings jsonb default '{}');
    create table crm_stages(id uuid primary key,organization_id uuid,pipeline_id uuid,is_archived boolean default false,is_won boolean default false,is_lost boolean default false,position numeric);
    create table crm_leads(id uuid primary key default gen_random_uuid(),organization_id uuid,contact_id uuid,pipeline_id uuid,stage_id uuid,status text default 'open',position_in_stage numeric,
      title text default 'Negócio',created_at timestamptz default now(),closed_at timestamptz,value_cents integer,currency text,
      owner_user_id uuid,owner_agent_id uuid,source text default 'whatsapp');
    create table obra_access_integrations(id uuid primary key,organization_id uuid references organizations(id),pipeline_id uuid,is_active boolean,lifecycle_enabled boolean,secret_encrypted bytea,last_received_at timestamptz);
    create table obra_subscription_states(organization_id uuid,product_user_id uuid,contact_id uuid,lead_id uuid);
    create table obra_access_links(organization_id uuid,product_user_id text,contact_id uuid,lead_id uuid);
    create function fn_user_org_ids() returns setof uuid language sql stable as $$select nullif(current_setting('test.org',true),'')::uuid$$;
    create function fn_role_at_least(p_org uuid,p_min text) returns boolean language sql stable as $$
      select p_org in(select fn_user_org_ids()) and current_setting('test.role',true) in ('agent','manager','admin')
        and (p_min<>'manager' or current_setting('test.role',true) in ('manager','admin'))$$;
    create function emit_event(text,text,uuid,jsonb,jsonb,uuid) returns uuid language sql as $$select gen_random_uuid()$$;
    grant usage on schema public,auth to authenticated,service_role;
    grant all on all tables in schema public,auth to service_role;
    grant select on crm_leads,crm_pipelines to authenticated;
    alter table crm_leads enable row level security;
    create policy test_org on crm_leads for select to authenticated using(organization_id in(select fn_user_org_ids()));`);
  const migration=readFileSync(new URL('../../supabase/migrations/20261022170000_0238_commercial_dashboard.sql',import.meta.url),'utf8');
  await sql.exec(migration);
  await sql.exec(migration); // atualização/reaplicação idempotente da migration nova
  const commercial=readFileSync(new URL('../../supabase/migrations/20261022180000_0239_obra_commercial_events.sql',import.meta.url),'utf8');
  await sql.exec(commercial);await sql.exec(commercial);
},30_000);
beforeEach(async()=>{
  await sql.exec(`reset role;truncate organizations,auth.users,contacts,messages,crm_pipelines,crm_stages,crm_leads,
    crm_first_payments,crm_lead_qualifications,crm_campaign_assignments,crm_ad_sync_accounts cascade;
    insert into organizations(id)values('${ORG}'),('${OTHER}');
    insert into auth.users(id)values('${ACTOR}');
    insert into contacts(id,organization_id,phone_number,email)values('${CONTACT}','${ORG}','+5511999990000','teste@example.invalid');
    insert into crm_pipelines(id,organization_id)values('${PIPE}','${ORG}');
    insert into crm_stages(id,organization_id,pipeline_id,position)values('${STAGE}','${ORG}','${PIPE}',1);
    insert into crm_leads(id,organization_id,contact_id,pipeline_id,stage_id)values('${LEAD}','${ORG}','${CONTACT}','${PIPE}','${STAGE}');
    select set_config('test.org','${ORG}',false),set_config('test.role','manager',false);`);
});
afterAll(()=>sql.close());
async function record(amount=25000,expected:string|null=null) {
  return (await sql.query<{r:{changed:boolean;payment:{updated_at:string};funnel_closed?:boolean}}>(
    'select fn_record_crm_first_payment($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) r',
    [ORG,LEAD,amount,'BRL','2026-10-01T12:00:00Z',2,'manual',null,ACTOR,'Recebido',expected])).rows[0]!.r;
}
describe('fatos financeiros e limites de organização',()=>{
  it('uma venda com duas unidades; duplicata não soma, correção exige CAS',async()=>{
    const first=await record();expect(first.changed).toBe(true);expect(first.funnel_closed).toBe(false);
    expect((await record()).changed).toBe(false);
    await expect(record(27000)).rejects.toThrow('first_payment_exists');
    await expect(record(27000,'2025-01-01T00:00:00Z')).rejects.toThrow('first_payment_changed');
    await record(27000,first.payment.updated_at);
    const row=(await sql.query<{amount_cents:number;quantity:number;history:unknown[]}>('select amount_cents,quantity,history from crm_first_payments')).rows[0]!;
    expect(row).toMatchObject({amount_cents:27000,quantity:2});expect(row.history).toHaveLength(1);
  });
  it('org diferente não consegue registrar o lead',async()=>{
    await expect(sql.query('select fn_record_crm_first_payment($1,$2,100,$3,now(),1,$4,null,$5,$6)',
      [OTHER,LEAD,'BRL','manual',ACTOR,''])).rejects.toThrow('lead_not_found');
    expect((await sql.query('select * from crm_first_payments')).rows).toHaveLength(0);
  });
  it('RLS não expõe receita, referência externa nem histórico de outra organização',async()=>{
    await record();
    await sql.exec('set role authenticated');
    expect((await sql.query('select amount_cents from crm_first_payments')).rows).toHaveLength(1);
    await expect(sql.query('select history from crm_first_payments')).rejects.toThrow(/permission denied/);
    await sql.query("select set_config('test.org',$1,false)",[OTHER]);
    expect((await sql.query('select amount_cents from crm_first_payments')).rows).toHaveLength(0);
    await expect(sql.query('select fn_record_crm_first_payment($1,$2,100,$3,now(),1,$4,null,$5,$6)',
      [ORG,LEAD,'BRL','manual',ACTOR,''])).rejects.toThrow(/permission denied/);
  });
  it('qualificação acontece uma vez e não presume história anterior',async()=>{
    await sql.query('select fn_configure_crm_dashboard($1,$2,$3,$4,true)',[ORG,PIPE,[STAGE],'Matrículas']);
    expect((await sql.query('select * from crm_lead_qualifications')).rows).toHaveLength(0);
    await sql.query('update crm_leads set stage_id=null where id=$1',[LEAD]);
    await sql.query('update crm_leads set stage_id=$1 where id=$2',[STAGE,LEAD]);
    await sql.query('update crm_leads set stage_id=$1 where id=$2',[STAGE,LEAD]);
    expect((await sql.query('select * from crm_lead_qualifications')).rows).toHaveLength(1);
  });
  it('anonimização apaga notas e histórico financeiro e bloqueia reintrodução',async()=>{
    const first=await record();await record(26000,first.payment.updated_at);
    await sql.query('update contacts set is_anonymized=true where id=$1',[CONTACT]);
    expect((await sql.query('select note,history,external_id from crm_first_payments')).rows[0]).toEqual({note:'',history:[],external_id:null});
    await expect(record()).rejects.toThrow('contact_anonymized');
    await expect(sql.query('select fn_void_crm_first_payment($1,$2,$3,$4,$5)',
      [ORG,LEAD,first.payment.updated_at,ACTOR,'Não reintroduzir dados'])).rejects.toThrow('contact_anonymized');
  });
});
describe('gasto: cobertura e lease',()=>{
  beforeEach(async()=>{await sql.query(`insert into crm_campaign_assignments(organization_id,account_id,campaign_id,campaign_name,currency,account_timezone)
    values($1,'act_1','2','Campanha','BRL','America/Sao_Paulo')`,[ORG]);});
  it('consulta vazia completa prova zero e lease antigo não sobrescreve o novo',async()=>{
    const claim=async()=> (await sql.query<{r:{lease_id:string;campaign_ids:string[]}|null}>('select fn_claim_dashboard_ad_sync($1,$2) r',[ORG,'act_1'])).rows[0]!.r;
    const a=(await claim())!;expect(await claim()).toBeNull();
    const finish=async(id:string)=> (await sql.query<{r:boolean}>(`select fn_finish_dashboard_ad_sync($1,'act_1',$2,'2026-10-01','2026-10-02',array['2'],'BRL','America/Sao_Paulo','[]'::jsonb) r`,[ORG,id])).rows[0]!.r;
    await sql.exec("update crm_ad_sync_accounts set locked_until=now()-interval '1 second'");
    const b=(await claim())!;
    expect(await finish(a.lease_id)).toBe(false);expect(await finish(b.lease_id)).toBe(true);
    expect((await sql.query('select * from crm_ad_spend_daily')).rows).toHaveLength(0);
    expect((await sql.query('select * from crm_ad_spend_coverage')).rows).toHaveLength(2);
  });
});

describe('eventos do produto sem interferir nas 96 horas',()=>{
  const integration='10000000-0000-4000-8000-000000000007',product='10000000-0000-4000-8000-000000000008';
  const event='10000000-0000-4000-8000-000000000009';
  const registration=()=>({version:3,event_id:event,product_user_id:product,event_type:'lead_registered',occurred_at:'2026-10-01T12:00:00Z',
    user_created_at:'2026-10-01T12:00:00Z',name:'Teste',email:'teste@example.invalid',phone:'+5511999990000',crm_ref:null,has_trial:true});
  beforeEach(async()=>{await sql.query(`insert into obra_access_integrations(id,organization_id,pipeline_id,is_active,lifecycle_enabled,secret_encrypted)
    values($1,$2,$3,true,true,'\\x00')`,[integration,ORG,PIPE]);});
  const receive=async(payload:unknown,hash='a'.repeat(64))=>(await sql.query<{r:{status:string}}>(
    "select fn_receive_obra_commercial($1,$2,$3::jsonb,$4,array['+5511999990000'],'\\x00') r",[ORG,integration,JSON.stringify(payload),hash])).rows[0]!.r;
  it('vincula cadastro à oportunidade existente; retransmissão é idempotente',async()=>{
    expect(await receive(registration())).toMatchObject({status:'accepted'});
    expect(await receive(registration())).toMatchObject({status:'duplicate'});
    expect(await receive(registration(),'b'.repeat(64))).toMatchObject({status:'conflict'});
    expect((await sql.query('select * from crm_leads')).rows).toHaveLength(1);
  });
  it('pagamento durante teste registra receita sem avançar antecipadamente o card',async()=>{
    await sql.query('insert into crm_stages(id,organization_id,pipeline_id,is_won,position)values($1,$2,$3,true,99)',[ACTOR,ORG,PIPE]);
    const paid={...registration(),event_type:'first_payment_received',payment_id:ACTOR,amount_cents:16990,currency:'BRL',paid_at:'2026-10-01T12:00:00Z'};
    expect(await receive(paid)).toMatchObject({status:'accepted'});
    expect((await sql.query('select status,stage_id from crm_leads where id=$1',[LEAD])).rows[0]).toEqual({status:'open',stage_id:STAGE});
    expect((await sql.query('select amount_cents from crm_first_payments')).rows[0]).toEqual({amount_cents:16990});
  });
  it('contratação direta pode avançar ao ganho sem fabricar período de teste',async()=>{
    await sql.query('insert into crm_stages(id,organization_id,pipeline_id,is_won,position)values($1,$2,$3,true,99)',[ACTOR,ORG,PIPE]);
    expect(await receive({...registration(),event_type:'first_payment_received',has_trial:false,payment_id:ACTOR,
      amount_cents:16990,currency:'BRL',paid_at:'2026-10-01T12:00:00Z'})).toMatchObject({status:'accepted'});
    expect((await sql.query('select stage_id from crm_leads where id=$1',[LEAD])).rows[0]?.stage_id).toBe(ACTOR);
  });
  it('cria cadastro de origem app apenas quando telefone e e-mail não conflitam',async()=>{
    await sql.exec('delete from crm_leads;delete from contacts');
    expect(await receive(registration())).toMatchObject({status:'accepted'});
    expect((await sql.query('select source from crm_leads')).rows).toEqual([{source:'app_registration'}]);
  });
});
