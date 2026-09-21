import { randomUUID } from "node:crypto";
import pg from "pg";
import { beforeAll,afterAll,it,expect,vi } from "vitest";
import { acquireActionIntent,expireActionIntents,freezeEventPlan } from "@/lib/automation/action-intent";
import type { EventRow } from "@/lib/event-log/dispatcher";
vi.mock("@/lib/audit",()=>({audit:vi.fn()}));
if (!process.env.TEST_DB_CONTAINER && process.env.KIWIFY_TEST_NATIVE!=="1") throw new Error("Use o harness descartável");
const database=process.env.KIWIFY_TEST_NATIVE==="1"?"kiwify_test":"postgres";
const pool=new pg.Pool({host:"127.0.0.1",port:Number(process.env.TEST_DB_PORT),user:"postgres",password:"postgres",database,max:10});
const org=randomUUID(),otherOrg=randomUUID(),rule=randomUUID();
let event: EventRow;
beforeAll(async()=>{
  await pool.query("insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$1::text,'Synthetic','Synthetic')",[org]);
  await pool.query("insert into automation_rules(id,organization_id,name,trigger_event,conditions,actions,is_active) values($1,$2,'Synthetic','lead.created','[]','[]',true)",[rule,org]);
  const contact=(await pool.query("insert into contacts(organization_id,name) values($1,'Synthetic') returning id",[org])).rows[0].id;
  event=(await pool.query("insert into event_log(organization_id,event_type,entity_kind,entity_id,payload) values($1,'contact.tag_added','contact',$2,'{}') returning *",[org,contact])).rows[0];
});
afterAll(()=>pool.end());
const ctx=()=>({organizationId:org,ruleId:rule,event});
it("oito adquirentes concorrentes têm um único vencedor; a posição seguinte é independente",async()=>{
  const gate=await pool.connect();await gate.query("begin");
  await gate.query("lock table automation_rule_runs in share mode");
  const racing=Promise.all(Array.from({length:8},()=>acquireActionIntent(pool,ctx(),0,"send_whatsapp_message")));
  try {await vi.waitFor(async()=>{
    const n=(await pool.query("select count(*)::int n from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like '%insert into automation_rule_runs%'")).rows[0].n;
    expect(n).toBe(8);
  },{timeout:5000});}finally{await gate.query("commit");gate.release();}
  const ids=await racing;expect(ids.filter(Boolean)).toHaveLength(1);
  expect(await acquireActionIntent(pool,ctx(),0,"send_whatsapp_message")).toBeNull();
  expect(await acquireActionIntent(pool,ctx(),1,"send_whatsapp_message")).toBeTruthy();
});
it("organização alheia e regra desligada não adquirem intenção",async()=>{
  expect(await acquireActionIntent(pool,{...ctx(),organizationId:otherOrg},2,"send_whatsapp_message")).toBeNull();
  await pool.query("update automation_rules set is_active=false where id=$1",[rule]);
  expect(await acquireActionIntent(pool,ctx(),2,"send_whatsapp_message")).toBeNull();
  await pool.query("update automation_rules set is_active=true where id=$1",[rule]);
});
it("interrupção antes e depois do início têm desfechos distintos, sem nova aquisição",async()=>{
  await pool.query("update automation_rule_runs set execution_state=case when action_index=0 then 'sending' else 'preparing' end,execution_updated_at=now()-interval '6 minutes' where organization_id=$1",[org]);
  await expireActionIntents(pool);
  const rows=(await pool.query("select execution_state from automation_rule_runs where organization_id=$1 order by action_index",[org])).rows;
  expect(rows.map(r=>r.execution_state)).toEqual(["uncertain","failed_before_send"]);
  expect(await acquireActionIntent(pool,ctx(),0,"send_whatsapp_message")).toBeNull();
  expect(await acquireActionIntent(pool,ctx(),1,"send_whatsapp_message")).toBeNull();
});
it("plano privado é estável, recusa FK alheia e não pode ser lido ou reescrito por usuário",async()=>{
  const original=[{id:rule,actions:[{type:"send_whatsapp_message",config:{template:"Original"}}]}];
  expect(await freezeEventPlan(pool,org,event.id,original)).toEqual(original);
  expect(await freezeEventPlan(pool,org,event.id,[])).toEqual(original);
  await pool.query("insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$1::text,'Synthetic','Synthetic')",[otherOrg]);
  await expect(pool.query("insert into automation_event_plans(organization_id,event_id,rules) values($1,$2,'[]')",[otherOrg,event.id])).rejects.toMatchObject({code:"23503"});
  const actor=randomUUID();await pool.query("insert into auth.users(id,email) values($1,'plan@example.invalid')",[actor]);
  await pool.query("insert into user_organizations(user_id,organization_id,role,accepted_at) values($1,$2,'manager',now())",[actor,org]);
  const client=await pool.connect();
  try {
    for(const role of ["anon","authenticated","service_role"]){
      await client.query("begin");await client.query(`set local role ${role}`);
      await client.query("select set_config('request.jwt.claim.sub',$1,true)",[actor]);
      if(role!=="service_role")await expect(client.query("select rules from automation_event_plans")).rejects.toMatchObject({code:"42501"});
      else {expect((await client.query("select rules from automation_event_plans where organization_id=$1",[org])).rows[0].rules).toEqual(original);
        await expect(client.query("update automation_event_plans set rules='[]'")).rejects.toMatchObject({code:"42501"});}
      await client.query("rollback");
    }
  }finally{await client.query("rollback");client.release();}
});
