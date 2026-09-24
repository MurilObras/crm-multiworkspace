import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import pg from "pg";
import { beforeAll, beforeEach, afterEach, afterAll, it, expect, vi } from "vitest";
import { acquireActionIntent, freezeEventPlan } from "@/lib/automation/action-intent";
import type { EventRow } from "@/lib/event-log/dispatcher";
vi.mock("@/lib/audit",()=>({audit:vi.fn()}));
const native=process.env.KIWIFY_TEST_NATIVE==="1";
const container=process.env.TEST_DB_CONTAINER;
if (!native && !container) throw new Error("Use PostgreSQL descartável do harness");
const port=Number(process.env.TEST_DB_PORT);
if (!Number.isInteger(port) || port<1024 || port===5432) throw new Error("Porta descartável obrigatória");
const name=`kiwify_update_${randomUUID().replaceAll("-","")}`;
const connection={host:"127.0.0.1",port,user:"postgres",password:"postgres"};
const control=new pg.Pool({...connection,database:native?"kiwify_test":"postgres"});
let db: pg.Pool;
const baseline=readFileSync("supabase/baseline.sql","utf8");
const recovery=readFileSync("supabase/migrations/20260921150000_0225_automation_plan_recovery_guard.sql","utf8");
const privacy=readFileSync("supabase/migrations/20260921120000_0224_automation_plan_redaction.sql","utf8");
const identity=readFileSync("supabase/migrations/20260921010000_0222_automation_action_identity.sql","utf8");
const plan=readFileSync("supabase/migrations/20260921030000_0223_automation_event_plan.sql","utf8");
const prelude=readFileSync("scripts/test-db.sh","utf8").split("psql_install <<'SQL'")[1]!.split("\nSQL")[0]!;
const start=baseline.indexOf("-- ---- Identidade de ação de automação (migration 0222) ----");
const end=baseline.indexOf("-- ---- VARREDURA anon:",start);
const oldBaseline=baseline.slice(0,start)+baseline.slice(end);
let created=false;

function psql(text:string,stop:boolean,transaction=false,conflict=false) {
  const args=["-X","-U","postgres","-d",name,"-f","-"];
  // Autocommit reproduz update.sh; --single-transaction reproduz atomicidade do runner.
  if(stop)args.push("-v","ON_ERROR_STOP=1");
  if(transaction)args.push("--single-transaction");
  const result=native
    ?spawnSync(join(process.env.KIWIFY_TEST_PG_BIN!,process.platform==="win32"?"psql.exe":"psql"),["-h","127.0.0.1","-p",String(port),...args],{input:text,encoding:"utf8",maxBuffer:20*1024*1024})
    :spawnSync("docker",["exec","-i",container!,"psql",...args],{input:text,encoding:"utf8",maxBuffer:20*1024*1024});
  expect(result.error).toBeUndefined();expect(result.status).toBe(conflict && stop?3:0);
  return result;
}
beforeAll(async()=>{
  expect(start).toBeGreaterThan(0);expect(end).toBeGreaterThan(start);
  expect(baseline).toContain(recovery.trim());expect(baseline).toContain(privacy.trim());
  expect(privacy.indexOf("create trigger zz_automation_plan_recovery")).toBeLessThan(privacy.indexOf("do $backfill$"));
});
beforeEach(async()=>{
  await control.query(`create database ${name}`);created=true;
  db=new pg.Pool({...connection,database:name});
  psql(prelude,true);psql(oldBaseline,true);
  // Partida anterior à etapa 2; avançar normalmente até 0223 é necessário para
  // existir a tabela de planos onde semeamos o lote anterior ao backfill 0224.
  psql(identity,true);psql(plan,true);
},120000);
afterEach(async()=>{
  if (db) {
    // pg-pool pode resolver end() quando remove o client da lista, antes do
    // callback de client.end() e do fechamento do socket. DROP ... WITH (force)
    // nessa janela manda 57P01 para o pool (erro não tratado fora do teste).
    // 'remove' é emitido somente após client.end() completar. Registre ANTES
    // de end() para não perder nenhum fechamento rápido.
    const total = db.totalCount;
    let removidos = 0;
    const fechados = new Promise<void>((resolve) => {
      if (total === 0) { resolve(); return; }
      db.on("remove", () => { if (++removidos === total) resolve(); });
    });
    await db.end();
    await fechados;
    expect(removidos).toBe(total);
    const { rows } = await control.query<{ n: number }>(
      "select count(*)::int n from pg_stat_activity where datname=$1 and pid<>pg_backend_pid()", [name],
    );
    expect(rows[0]?.n, "o banco ainda tem conexões antes do DROP real").toBe(0);
  }
  if(created)await control.query(`drop database ${name} with (force)`);
  created=false;
});
afterAll(()=>control.end());

it.each([
  {path:"baseline",transaction:false},{path:"chronological",transaction:false},
  {path:"baseline",transaction:true},{path:"chronological",transaction:true},
])("$path / transaction=$transaction: conflito preserva lote; reparo, anonimização e retry seguros",async({path,transaction})=>{
  const update=(conflict=false)=>{
    const results=[];
    // Ordem NORMAL dos arquivos. A 0225 não roda antes nem é antecipada no teste.
    for(const text of path==="baseline"?[baseline]:[privacy,recovery]) {
      const result=psql(text+"\nselect 'continued_after_error';",transaction,transaction,conflict);
      results.push(result);
      if(result.status!==0)break; // Runner transacional interrompe na migration falha.
    }
    return {stdout:results.map(r=>r.stdout).join("\n"),stderr:results.map(r=>r.stderr).join("\n")};
  };
  const org=randomUUID(),a=randomUUID(),b=randomUUID(),rule=randomUUID();
  await db.query("insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$1::text,'Synthetic','Synthetic')",[org]);
  await db.query("insert into contacts(id,organization_id,name) values($1,$3,'Synthetic A'),($2,$3,'Synthetic B')",[a,b,org]);
  const pipeline=(await db.query("insert into crm_pipelines(organization_id,name,slug,position) values($1,'Synthetic','synthetic',1) returning id",[org])).rows[0].id;
  const stage=(await db.query("insert into crm_stages(organization_id,pipeline_id,name,slug,position) values($1,$2,'Synthetic','synthetic',1) returning id",[org,pipeline])).rows[0].id;
  const lead=(await db.query("insert into crm_leads(organization_id,pipeline_id,stage_id,contact_id,title) values($1,$2,$3,$4,'Synthetic') returning id",[org,pipeline,stage,a])).rows[0].id;
  const link=(await db.query("insert into crm_lead_links(organization_id,lead_id,target_kind,target_id,link_kind) values($1,$2,'contact',$3,'related') returning id",[org,lead,b])).rows[0].id;
  await db.query("insert into automation_rules(id,organization_id,name,trigger_event,conditions,actions,is_active) values($1,$2,'Synthetic','contact.tag_added','[]','[]',true)",[rule,org]);
  const makeEvent=async(kind:string,id:string|null)=>(await db.query("insert into event_log(organization_id,event_type,entity_kind,entity_id,payload) values($1,'contact.tag_added',$2,$3,'{}') returning *",[org,kind,id])).rows[0] as EventRow;
  const valid=await makeEvent("contact",a),conflict=await makeEvent("crm_lead",lead),orphan=await makeEvent("contact",null);
  const rules=[{id:rule,actions:[{type:"send_whatsapp_message",config:{template:"Pessoa sintética +12025550100"}}]}];
  for(const event of [valid,conflict,orphan])await freezeEventPlan(db,org,event.id,rules);
  const ctx={organizationId:org,ruleId:rule,event:valid};
  const run=await acquireActionIntent(db,ctx,0,"send_whatsapp_message",true);expect(run).toBeTruthy();
  await db.query("delete from automation_rules where id=$1",[rule]);
  const snapshot=async()=>(await db.query("select event_id,rules,created_at from automation_event_plans where organization_id=$1 order by event_id",[org])).rows;
  const before=await snapshot();

  const failed=update(true);
  expect(failed.stderr).toContain("automation_plan_subject_ambiguous");
  expect(await snapshot()).toEqual(before);
  if(transaction) {
    expect(failed.stdout).not.toContain("continued_after_error");
    // A própria instalação da guarda da 0224 foi revertida; 0225 não executou.
    expect((await db.query("select to_regprocedure('public.fn_guard_automation_plan_recovery()') f")).rows[0].f).toBeNull();
  } else {
    expect(failed.stdout).toContain("continued_after_error");
    expect((await db.query("select count(*)::int n from automation_event_plans where organization_id=$1 and redacted_at is not null",[org])).rows[0].n).toBe(0);
    expect(await acquireActionIntent(db,{...ctx,event:conflict},0,"send_whatsapp_message",true)).toBeNull();
  }

  // Autocommit retoma o upgrade parcial; transacional reaplica a migration revertida.
  await db.query("delete from crm_lead_links where organization_id=$1 and id=$2",[org,link]);
  const repaired=update();expect(repaired.stderr).not.toMatch(/ERROR:/);
  const plans=(await db.query("select * from automation_event_plans where organization_id=$1",[org])).rows;
  for(const event of [valid,conflict]) {
    const p=plans.find(p=>p.event_id===event.id);
    expect(p).toMatchObject({subject_contact_id:a,redacted_at:null,rules});
  }
  expect(plans.find(p=>p.event_id===orphan.id)).toMatchObject({subject_contact_id:null,rules:[],redacted_at:expect.any(Date)});
  expect((await db.query("select id,rule_id,rule_identity from automation_rule_runs where id=$1",[run])).rows[0])
    .toEqual({id:run,rule_id:null,rule_identity:rule});
  expect(await acquireActionIntent(db,ctx,0,"send_whatsapp_message",true)).toBeNull();
  expect(await acquireActionIntent(db,{...ctx,event:orphan},0,"send_whatsapp_message",true)).toBeNull();
  expect(await freezeEventPlan(db,org,orphan.id,rules)).toEqual([]);

  const preserved=await snapshot();expect(update().stderr).not.toMatch(/ERROR:/);
  expect(await snapshot()).toEqual(preserved);
  await db.query("update contacts set is_anonymized=true,anonymized_at=now() where organization_id=$1 and id=$2",[org,a]);
  for(const event of [valid,conflict])expect(await freezeEventPlan(db,org,event.id,rules)).toEqual([]);
},120000);
