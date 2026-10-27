import { afterAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

if (!process.env.TEST_DB_CONTAINER) throw Error('Use pnpm test:db com banco descartável');
const pool = new pg.Pool({connectionString:`postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT??54329}/postgres`,max:3});
afterAll(()=>pool.end());

async function fixture() {
 const org=randomUUID(),contact=randomUUID(),session=randomUUID(),conversation=randomUUID(),job=randomUUID();
 await pool.query(`insert into organizations(id,slug,legal_name,display_name,settings) values($1::uuid,$1::text,'Teste','Teste','{"visibility_mode":"own"}')`,[org]);
 await pool.query(`insert into contacts(id,organization_id,name,phone_number) values($1,$2,'Teste','+5511999991234')`,[contact,org]);
 await pool.query(`insert into channel_sessions(id,organization_id,waha_session_name,status,webhook_secret_encrypted) values($1::uuid,$2,$1::text,'WORKING','\\x00'::bytea)`,[session,org]);
 await pool.query(`insert into conversations(id,organization_id,contact_id,channel_session_id,status) values($1,$2,$3,$4,'open')`,[conversation,org,contact,session]);
 const payload={conversation_id:conversation,channel_session_id:session,response_delivery:{version:1,responseKey:randomUUID(),agentId:null,agentVersionId:null,firstSeq:1,body:'Resposta privada',bubbles:[],approved:false,waitUntil:null}};
 await pool.query(`insert into job_queue(id,organization_id,contact_id,kind,status,payload) values($1,$2,$3,'inbound_turn','done',$4)`,[job,org,contact,JSON.stringify({conversation_id:conversation,channel_session_id:session})]);
 await pool.query('update job_queue set payload=$2 where id=$1',[job,JSON.stringify(payload)]);
 return {org,contact,session,conversation,job,payload};
}
async function member(org:string,role:'agent'|'admin'='agent') {
 const user=randomUUID();await pool.query('insert into auth.users(id,email) values($1,$2)',[user,user+'@example.test']);
 await pool.query('insert into user_organizations(user_id,organization_id,role,accepted_at) values($1,$2,$3,now())',[user,org,role]);return user;
}
async function actor(user:string|null,sql:string,values:unknown[],options:{service?:boolean;grantWrites?:boolean}={}) {
 const db=await pool.connect();try {
  await db.query('begin');
  await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({role:options.service?'service_role':'authenticated',sub:user})]);
  await db.query("select set_config('request.jwt.claim.sub',$1,true)",[user??'']);
  // Só no banco descartável, dentro de rollback: comprova a defesa RLS se
  // uma instalação voltar a conceder privilégios por engano.
  if(options.grantWrites) await db.query('grant all on public.job_queue to authenticated');
  await db.query(options.service?'set local role service_role':'set local role authenticated');
  return await db.query(sql,values);
 } finally {await db.query('rollback');db.release();}
}

it('resposta privada exige acesso à conversa exata; outro workspace não lê',async()=>{
 const f=await fixture(),other=await fixture(),user=await member(f.org),admin=await member(f.org,'admin');
 const read='select payload from job_queue where organization_id=$1 and id=$2';
 expect((await actor(user,read,[f.org,f.job])).rows).toEqual([]);
 await pool.query('update conversations set assigned_to_user_id=$1 where id=$2',[user,f.conversation]);
 expect((await actor(user,read,[f.org,f.job])).rows[0].payload.response_delivery.body).toBe('Resposta privada');
 expect((await actor(admin,read,[f.org,f.job])).rowCount).toBe(1);
 expect((await actor(user,read,[other.org,other.job])).rows).toEqual([]);
 // Mesmo uma conversa autorizada de outro contato não libera este payload.
 const secondContact=randomUUID(),secondConversation=randomUUID();
 await pool.query(`insert into contacts(id,organization_id,name,phone_number) values($1,$2,'Outro contato','+5511999995678')`,[secondContact,f.org]);
 await pool.query(`insert into conversations(id,organization_id,contact_id,channel_session_id,status,assigned_to_user_id) values($1,$2,$3,$4,'open',$5)`,[secondConversation,f.org,secondContact,f.session,user]);
 await pool.query(`update job_queue set payload=jsonb_set(payload,'{conversation_id}',to_jsonb($2::text)) where id=$1`,[f.job,secondConversation]);
 expect((await actor(user,read,[f.org,f.job])).rows).toEqual([]);
});

it('diagnósticos legados sem texto privado mantêm a leitura da organização',async()=>{
 const f=await fixture(),user=await member(f.org);
 await pool.query("update job_queue set payload=payload-'response_delivery' where id=$1",[f.job]);
 expect((await actor(user,'select id from job_queue where organization_id=$1 and id=$2',[f.org,f.job])).rowCount).toBe(1);
});

it('sessão autenticada não pode escrever, forjar fase ou truncar a fila',async()=>{
 const f=await fixture(),user=await member(f.org);
 await pool.query('update conversations set assigned_to_user_id=$1 where id=$2',[user,f.conversation]);
 const grants=await pool.query(`select bool_or(has_table_privilege('authenticated','public.job_queue',privilege)) allowed from unnest(array['INSERT','UPDATE','DELETE','TRUNCATE']) privilege`);
 expect(grants.rows[0].allowed).toBe(false);
 await expect(actor(user,"update job_queue set payload=jsonb_set(payload,'{response_delivery,phase}','\"prelude\"') where id=$1",[f.job]))
  .rejects.toMatchObject({code:'42501'});
});

it('RLS barra mutações mesmo após GRANT acidental e preserva escrita do serviço',async()=>{
 const f=await fixture(),user=await member(f.org);
 await pool.query('update conversations set assigned_to_user_id=$1 where id=$2',[user,f.conversation]);
 expect((await actor(user,'update job_queue set payload=$2 where id=$1 returning id',[f.job,JSON.stringify(f.payload)],{grantWrites:true})).rowCount).toBe(0);
 expect((await actor(user,'delete from job_queue where id=$1 returning id',[f.job],{grantWrites:true})).rowCount).toBe(0);
 await expect(actor(user,`insert into job_queue(organization_id,contact_id,kind,payload) values($1,$2,'inbound_turn',$3)`,[f.org,f.contact,JSON.stringify({conversation_id:f.conversation})],{grantWrites:true}))
  .rejects.toMatchObject({code:'42501'});
 const service=await actor(null,"update job_queue set payload=jsonb_set(payload,'{service_test}','true') where id=$1 returning payload",[f.job],{service:true});
 expect(service.rowCount).toBe(1);expect(service.rows[0].payload.service_test).toBe(true);
 expect(service.rows[0].payload.response_delivery.body).toBe('Resposta privada');
});

it('novo job não recebe plano pronto de cron ou evento, mesmo por um produtor privilegiado',async()=>{
 const f=await fixture();
 await expect(actor(null,`insert into job_queue(organization_id,contact_id,kind,payload) values($1,$2,'inbound_turn',$3)`,[f.org,f.contact,JSON.stringify(f.payload)],{service:true}))
  .rejects.toMatchObject({code:'23514',message:'response_delivery_requires_claimed_job'});
 const valid=await actor(null,`insert into job_queue(organization_id,contact_id,kind,payload) values($1,$2,'inbound_turn',$3) returning id`,[f.org,f.contact,JSON.stringify({conversation_id:f.conversation})],{service:true});
 expect(valid.rowCount).toBe(1);
 expect((await pool.query("select has_function_privilege('anon','fn_job_queue_private_plan_input()','execute') or has_function_privilege('authenticated','fn_job_queue_private_plan_input()','execute') exposed")).rows[0].exposed).toBe(false);
});
