import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { beforeAll, afterAll, it, expect, vi } from "vitest";
import { acquireActionIntent, freezeEventPlan, actionPlanLive } from "@/lib/automation/action-intent";
import type { EventRow } from "@/lib/event-log/dispatcher";
vi.mock("@/lib/audit",()=>({audit:vi.fn()}));
if (!process.env.TEST_DB_CONTAINER && process.env.KIWIFY_TEST_NATIVE!=="1") throw new Error("Use o harness descartável");
const pool=new pg.Pool({host:"127.0.0.1",port:Number(process.env.TEST_DB_PORT),user:"postgres",password:"postgres",
  database:process.env.KIWIFY_TEST_NATIVE==="1"?"kiwify_test":"postgres",max:8});
const migration=readFileSync("supabase/migrations/20260921120000_0224_automation_plan_redaction.sql","utf8");
beforeAll(()=>pool.query(migration));
afterAll(()=>pool.end());
async function fixture() {
  const org=randomUUID();
  await pool.query("insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$1::text,'Synthetic','Synthetic')",[org]);
  const contact=(await pool.query("insert into contacts(organization_id,name) values($1,'Pessoa sintética') returning id",[org])).rows[0].id;
  const rule=(await pool.query("insert into automation_rules(organization_id,name,trigger_event,conditions,actions,is_active) values($1,'Synthetic','contact.tag_added','[]','[]',true) returning id",[org])).rows[0].id;
  const event=(await pool.query("insert into event_log(organization_id,event_type,entity_kind,entity_id,payload) values($1,'contact.tag_added','contact',$2,'{}') returning *",[org,contact])).rows[0] as EventRow;
  const rules=[{id:rule,actions:[{type:"send_whatsapp_message",config:{template:"Pessoa sintética +12025550100"}}]}];
  return {org,contact,rule,event,rules,ctx:{organizationId:org,ruleId:rule,event}};
}
async function redact(db: pg.Pool | pg.PoolClient, f: Awaited<ReturnType<typeof fixture>>) {
  await db.query("update contacts set is_anonymized=true,anonymized_at=now() where organization_id=$1 and id=$2",[f.org,f.contact]);
}
async function waiting(pid:number) {
  await vi.waitFor(async()=>expect((await pool.query("select wait_event_type from pg_stat_activity where pid=$1",[pid])).rows[0]?.wait_event_type).toBe("Lock"),{timeout:5000});
}
it("excluir regra não apaga plano válido; anonimizar mantém identidade e proíbe restaurar/adquirir",async()=>{
  const f=await fixture();await freezeEventPlan(pool,f.org,f.event.id,f.rules);
  const run=await acquireActionIntent(pool,f.ctx,0,"send_whatsapp_message",true);
  await pool.query("delete from automation_rules where id=$1",[f.rule]);
  expect(await freezeEventPlan(pool,f.org,f.event.id,[])).toEqual(f.rules);
  await redact(pool,f);await redact(pool,f);
  expect(await freezeEventPlan(pool,f.org,f.event.id,f.rules)).toEqual([]);
  expect(await acquireActionIntent(pool,f.ctx,1,"send_whatsapp_message",true)).toBeNull();
  expect(await actionPlanLive(pool,f.org,f.event.id)).toBe(false);
  expect((await pool.query("select id,rule_identity,rule_id,plan_redacted_at from automation_rule_runs where id=$1",[run])).rows[0])
    .toMatchObject({id:run,rule_identity:f.rule,rule_id:null,plan_redacted_at:expect.any(Date)});
  await pool.query("update automation_event_plans set rules=$2,redacted_at=null where event_id=$1",[f.event.id,JSON.stringify(f.rules)]);
  expect((await pool.query("select rules,redacted_at from automation_event_plans where event_id=$1",[f.event.id])).rows[0])
    .toMatchObject({rules:[],redacted_at:expect.any(Date)});
});
it("plano realmente órfão vira tombstone e continua vazio mesmo se o vínculo reaparece",async()=>{
  const f=await fixture();await pool.query("update event_log set entity_id=null where id=$1",[f.event.id]);
  expect(await freezeEventPlan(pool,f.org,f.event.id,f.rules)).toEqual([]);
  await pool.query("update event_log set entity_id=$2 where id=$1",[f.event.id,f.contact]);
  expect(await freezeEventPlan(pool,f.org,f.event.id,f.rules)).toEqual([]);
  expect(await acquireActionIntent(pool,f.ctx,0,"send_whatsapp_message",true)).toBeNull();
});
it("anonimização de outro tenant não toca o plano válido",async()=>{
  const a=await fixture(),b=await fixture();
  await freezeEventPlan(pool,a.org,a.event.id,a.rules);await freezeEventPlan(pool,b.org,b.event.id,b.rules);
  await redact(pool,b);
  expect(await freezeEventPlan(pool,a.org,a.event.id,[])).toEqual(a.rules);
  expect(await actionPlanLive(pool,b.org,a.event.id)).toBe(false);
});
it.each(["freeze","acquire","start"])("anonimização ganha a corrida com %s: nenhum conteúdo ou permissão retorna",async(kind)=>{
  const f=await fixture();if(kind!=="freeze")await freezeEventPlan(pool,f.org,f.event.id,f.rules);
  const anonymizer=await pool.connect(),worker=await pool.connect();
  try {
    await anonymizer.query("begin");await redact(anonymizer,f);
    const pid=(await worker.query("select pg_backend_pid() pid")).rows[0].pid;
    const work=kind==="freeze"?freezeEventPlan(worker,f.org,f.event.id,f.rules)
      :kind==="acquire"?acquireActionIntent(worker,f.ctx,0,"send_whatsapp_message",true)
      :actionPlanLive(worker,f.org,f.event.id);
    // Adquire/freeze esperam o contato; start também revalida depois da espera.
    try {await waiting(pid);} finally {await anonymizer.query("commit");}
    expect(await work).toEqual(kind==="freeze"?[]:kind==="acquire"?null:false);
    expect(await freezeEventPlan(pool,f.org,f.event.id,f.rules)).toEqual([]);
  } finally {await anonymizer.query("rollback");anonymizer.release();worker.release();}
});
it("criação ganha primeiro: anonimização espera e limpa o plano recém-confirmado",async()=>{
  const f=await fixture(),worker=await pool.connect(),anonymizer=await pool.connect();
  try {
    await worker.query("begin");expect(await freezeEventPlan(worker,f.org,f.event.id,f.rules)).toEqual(f.rules);
    const pid=(await anonymizer.query("select pg_backend_pid() pid")).rows[0].pid;
    const work=redact(anonymizer,f);
    try {await waiting(pid);} finally {await worker.query("commit");}
    await work;expect(await freezeEventPlan(pool,f.org,f.event.id,f.rules)).toEqual([]);
  } finally {await worker.query("rollback");worker.release();anonymizer.release();}
});
it("upgrade recupera titular mesmo sem regra; saneia já anonimizado/órfão e é reaplicável",async()=>{
  const valid=await fixture(),anonymous=await fixture(),orphan=await fixture();
  await redact(pool,anonymous);
  await pool.query("delete from automation_rules where id=$1",[valid.rule]);
  await pool.query("update event_log set entity_id=null where id=$1",[orphan.event.id]);
  const client=await pool.connect();
  try {
    await client.query("begin");
    // Representa as linhas 0223, anteriores ao vínculo/tombstone.
    await client.query("drop trigger trg_guard_automation_plan_payload on automation_event_plans; drop trigger trg_redact_automation_plan_effects on automation_event_plans; alter table automation_event_plans drop constraint automation_plan_redacted_payload");
    for(const f of [valid,anonymous,orphan])await client.query("insert into automation_event_plans(organization_id,event_id,rules) values($1,$2,$3)",[f.org,f.event.id,JSON.stringify(f.rules)]);
    await client.query(migration);await client.query(migration);
    for(const f of [valid,anonymous,orphan]) {
      const p=(await client.query("select * from automation_event_plans where event_id=$1",[f.event.id])).rows[0];
      expect(p.rules).toEqual(f===valid?f.rules:[]);
      expect(p.subject_contact_id).toBe(f===orphan?null:f.contact);
      expect(p.redacted_at===null).toBe(f===valid);
    }
  } finally {await client.query("rollback");client.release();}
});
