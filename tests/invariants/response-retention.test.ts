import {afterAll,describe,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {recordDeliveryRetention} from '@/lib/agent-engine/edge/crm/delivery-retention';
import {saveDelivery,readDelivery,type DeliverySnapshot} from '@/lib/agent-engine/agent/response-delivery';
import {enqueueJob,claimJobs} from '@/lib/agent-engine/queue/queue';
if(!process.env.TEST_DB_CONTAINER)throw Error('Use pnpm test:db com banco descartável');
const pool=new pg.Pool({connectionString:`postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT??54329}/postgres`,max:3});
afterAll(()=>pool.end());
async function fixture(){
 const org=randomUUID(),contact=randomUUID(),session=randomUUID(),conv=randomUUID();
 await pool.query(`insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$1::text,'Teste','Teste')`,[org]);
 await pool.query(`insert into contacts(id,organization_id,name,phone_number) values($1,$2,'Teste','+5511999991234')`,[contact,org]);
 await pool.query(`insert into channel_sessions(id,organization_id,waha_session_name,status,webhook_secret_encrypted) values($1::uuid,$2,$1::text,'WORKING','\\x00'::bytea)`,[session,org]);
 await pool.query(`insert into conversations(id,organization_id,contact_id,channel_session_id,status) values($1,$2,$3,$4,'open')`,[conv,org,contact,session]);
 const {job}=await enqueueJob(pool,org,{kind:'inbound_turn',leadId:contact,payload:{conversation_id:conv,channel_session_id:session,inbound_message_id:randomUUID()}});
 const response=randomUUID();
 await pool.query(`insert into before_send_traces(organization_id,job_id,contact_id,channel_session_id,conversation_id,response_key,trace,vetoed_gate,vetoed_code) values($1,$2,$3,$4,$5,$6,'[]','promise','promise_semantic')`,[org,job.id,contact,session,conv,response]);
 return {org,contact,session,conv,job,response};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
async function notices(f:Fixture,role='service_role',org=f.org,user:string|null=null){const c=await pool.connect();try{
 await c.query('begin');await c.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({role,sub:user})]);
 await c.query("select set_config('request.jwt.claim.sub',$1,true)",[user??'']);
 return (await c.query('select * from fn_conversation_retentions($1,$2)',[org,f.conv])).rows;
 }finally{await c.query('rollback');c.release();}}
async function message(f:Fixture,status='sent',response=f.response,count=1){
 const mid=randomUUID(),key=randomUUID();const seq=Number((await pool.query('select coalesce(max(seq),0)+1 n from send_ledger where job_id=$1',[f.job.id])).rows[0].n);
 await pool.query(`insert into messages(id,organization_id,conversation_id,channel_session_id,contact_id,type,direction,status,external_id,body,metadata)
 values($1,$2,$3,$4,$5,'text','outbound',$6,$7,'Resposta',$8)`,[mid,f.org,f.conv,f.session,f.contact,status,status==='sent'?'fake-'+mid:null,JSON.stringify({idempotency_key:key,response_key:response,response_part_count:count,outbound_attempt:{phase:status==='sending'?'uncertain':'prepared'}})]);
 await pool.query(`insert into send_ledger(id,organization_id,contact_id,job_id,seq,body_hash,status,crm_message_id) values($1,$2,$3,$4,$5,'hash',$6,$7)`,[key,f.org,f.contact,f.job.id,seq,status==='sent'?'accepted':'failed',mid]);return mid;
}
describe('aviso corresponde à resposta e ao canal',()=>{
 it('exibe pendente; envio sem relação não resolve; confirmação relacionada resolve sem apagar auditoria',async()=>{
 const f=await fixture();expect((await notices(f))[0].delivery_state).toBe('pending');
 await message(f,'sent',randomUUID());expect((await notices(f))[0].delivery_state).toBe('pending');
 await message(f);expect(await notices(f)).toEqual([]);
 expect((await pool.query('select count(*)::int n from before_send_traces where job_id=$1',[f.job.id])).rows[0].n).toBe(1);
 });
 it('uma parte enviada não resolve a parte pendente; entrega incerta continua explícita',async()=>{
 const f=await fixture();await message(f,'sent',f.response,2);expect((await notices(f))[0].delivery_state).toBe('partial');
 const second=await message(f,'sending',f.response,2);expect((await notices(f))[0].delivery_state).toBe('uncertain');
 await pool.query("update messages set status='sent',external_id='fake-confirmed',metadata=jsonb_set(metadata,'{outbound_attempt,phase}',$2::jsonb) where id=$1",[second,JSON.stringify('uncertain')]);
 expect(await notices(f)).toEqual([]);
 });
 it('outro workspace e usuário sem associação não leem avisos; anon não executa RPC',async()=>{
 const f=await fixture(),other=await fixture();expect(await notices(f,'service_role',other.org)).toEqual([]);
 expect(await notices(f,'authenticated')).toEqual([]);
 expect((await pool.query("select has_function_privilege('anon','fn_conversation_retentions(uuid,uuid)','execute') allowed")).rows[0].allowed).toBe(false);
 });
 it('respeita visibilidade por atendente mesmo quando chamado diretamente por membro da organização',async()=>{
 const f=await fixture(),user=randomUUID();
 await pool.query('insert into auth.users(id,email) values($1,$2)',[user,user+'@example.test']);
 await pool.query(`insert into user_organizations(user_id,organization_id,role,accepted_at) values($1,$2,'agent',now())`,[user,f.org]);
 await pool.query(`update organizations set settings=jsonb_build_object('visibility_mode','own') where id=$1`,[f.org]);
 expect(await notices(f,'authenticated',f.org,user)).toEqual([]);
 await pool.query('update conversations set assigned_to_user_id=$1 where id=$2 and organization_id=$3',[user,f.conv,f.org]);
 expect((await notices(f,'authenticated',f.org,user))[0].delivery_state).toBe('pending');
 });
 it('não mistura canais do mesmo contato nem inventa resolução para legado',async()=>{
 const f=await fixture();const otherSession=randomUUID(),otherConv=randomUUID();
 await pool.query(`insert into channel_sessions(id,organization_id,waha_session_name,status,webhook_secret_encrypted) values($1::uuid,$2,$1::text,'WORKING','\\x00'::bytea)`,[otherSession,f.org]);
 await pool.query(`insert into conversations(id,organization_id,contact_id,channel_session_id,status) values($1,$2,$3,$4,'open')`,[otherConv,f.org,f.contact,otherSession]);
 expect(await notices({...f,conv:otherConv})).toEqual([]);
 await pool.query('update before_send_traces set response_key=null,conversation_id=null where job_id=$1',[f.job.id]);
 expect((await notices(f))[0].delivery_state).toBe('historical');
 });
 it('a falha de transporte alimenta o aviso mesmo se nenhum gate havia vetado',async()=>{
 const f=await fixture();await pool.query('delete from before_send_traces where job_id=$1',[f.job.id]);
 await message(f,'sent',f.response,2);await message(f,'failed',f.response,2);
 await recordDeliveryRetention(pool,{tenantId:f.org,leadId:f.contact,jobId:f.job.id,workerId:'owner',seq:2,conversationId:f.conv,body:'Resposta',responseKey:f.response,responsePartCount:2});
 expect((await notices(f))[0]).toMatchObject({vetoed_gate:'delivery',delivery_state:'partial'});
 });
 it('remove o texto privado do plano ao anonimizar e protege o lease na gravação',async()=>{
 const f=await fixture();const [job]=await claimJobs(pool,{workerId:'owner',maxConcurrency:1,jobIds:[f.job.id]});
 const snapshot:DeliverySnapshot={version:1,responseKey:f.response,agentId:null,agentVersionId:null,firstSeq:1,body:'Texto privado',bubbles:[],approved:false,waitUntil:null};
 await saveDelivery(pool,job!,'owner',snapshot);expect(readDelivery(job!)?.body).toBe('Texto privado');
 await expect(saveDelivery(pool,job!,'outro',snapshot)).rejects.toThrow();
 await pool.query('update contacts set is_anonymized=true,anonymized_at=now() where organization_id=$1 and id=$2',[f.org,f.contact]);
 expect((await pool.query('select payload from job_queue where id=$1',[f.job.id])).rows[0].payload.response_delivery).toBeUndefined();
 await expect(saveDelivery(pool,job!,'owner',snapshot)).rejects.toThrow();
 });
});
