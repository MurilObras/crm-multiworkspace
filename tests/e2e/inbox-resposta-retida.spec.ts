import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import {test,expect} from '@playwright/test';
import {createClient} from '@supabase/supabase-js';
import {carregarEnvLocal} from '../../scripts/lib/env-de-teste';
import {loginComoAdmin,lerCreds} from './helpers/login-admin';
const env=carregarEnvLocal();
const admin=createClient(env.NEXT_PUBLIC_SUPABASE_URL!,env.SUPABASE_SERVICE_ROLE_KEY!,{auth:{persistSession:false,autoRefreshToken:false}});
let creds=lerCreds();
const evidence='.superpowers/evidence/inbox-delivery-finalization';
test.use({locale:'pt-BR'});test.describe.configure({mode:'serial',timeout:240000});
test.beforeAll(()=>{execFileSync('npx',['tsx','scripts/seed-e2e-capacidades.ts'],{stdio:'inherit'});creds=lerCreds();fs.mkdirSync(evidence,{recursive:true});});
async function insert(table:string,value:Record<string,unknown>){const r=await admin.from(table).insert(value);if(r.error)throw Error(table+': '+r.error.code);}
test('aviso acompanha a resposta exata, some após confirmação e mantém histórico',async({page})=>{
 creds=await loginComoAdmin(page,creds);const org=(creds as typeof creds & {org_id:string}).org_id;
 const contact=randomUUID(),session=randomUUID(),conv=randomUUID(),job=randomUUID(),response=randomUUID();
 await insert('contacts',{id:contact,organization_id:org,name:'Retenção E2E',phone_number:'+5511999912345'});
 await insert('channel_sessions',{id:session,organization_id:org,waha_session_name:'retention-'+session,status:'WORKING',webhook_secret_encrypted:'e2e'});
 await insert('conversations',{id:conv,organization_id:org,contact_id:contact,channel_session_id:session,status:'open'});
 await insert('job_queue',{id:job,organization_id:org,contact_id:contact,kind:'inbound_turn',status:'done',payload:{conversation_id:conv,channel_session_id:session}});
 await insert('before_send_traces',{organization_id:org,contact_id:contact,job_id:job,channel_session_id:session,conversation_id:conv,response_key:response,trace:[],vetoed_gate:'pacing',vetoed_code:'warmup_cap'});
 await page.goto('/app/inbox?id='+conv);const notice=page.getByTestId('retention-notice');
 await expect(notice).toContainText('aquecimento',{timeout:60000});
 // Outro envio no mesmo contato não é prova de recuperação.
 await insert('messages',{organization_id:org,contact_id:contact,channel_session_id:session,conversation_id:conv,direction:'outbound',type:'text',status:'sent',external_id:'unrelated-'+randomUUID(),body:'Mensagem sem relação'});
 await page.reload();await expect(notice).toContainText('aquecimento',{timeout:60000});
 async function part(seq:number,status:string){const id=randomUUID(),key=randomUUID();
 const metadata={idempotency_key:key,response_key:response,response_part_count:2,outbound_attempt:{phase:status==='sending'?'uncertain':'prepared'}};
 await insert('messages',{id,organization_id:org,contact_id:contact,channel_session_id:session,conversation_id:conv,direction:'outbound',type:'text',status,external_id:status==='sent'?'ack-'+id:null,body:'Parte '+seq,metadata});
 await insert('send_ledger',{id:key,organization_id:org,contact_id:contact,job_id:job,seq,body_hash:'e2e',status:status==='sent'?'accepted':'failed',crm_message_id:id});return {id,key,metadata};}
 await part(1,'sent');await page.reload();await expect(notice).toContainText('parcialmente',{timeout:60000});
 const second=await part(2,'sending');await page.reload();await expect(notice).toContainText('Entrega sem confirmação',{timeout:60000});
 const update=await admin.from('messages').update({status:'sent',external_id:'ack-second',metadata:{...second.metadata,outbound_attempt:{phase:'confirmed'}}}).eq('organization_id',org).eq('id',second.id);expect(update.error).toBeNull();
 await expect(notice).toHaveCount(0,{timeout:45000});
 const loadedRetention=page.waitForResponse(r=>r.url().includes('/conversations/'+conv+'/retention')&&r.request().method()==='GET'&&r.status()===200);
 await page.reload();const retention=await loadedRetention;
 expect((await retention.json()).data.retentions).toEqual([]);
 await expect(page.getByTestId('chat-thread').getByText('Parte 2',{exact:true})).toBeVisible({timeout:60000});
 await expect(page.getByRole('textbox',{name:'Mensagem',exact:true})).toBeVisible();
 await expect(notice).toHaveCount(0,{timeout:60000});
 const history=await admin.from('before_send_traces').select('id').eq('organization_id',org).eq('job_id',job);expect(history.error).toBeNull();expect(history.data).toHaveLength(1);
 await page.screenshot({path:evidence+'/retencao-resolvida.png',fullPage:true});
});
test('tempo mínimo salva, relê e não depende de alteração de prompt',async({page})=>{
 creds=await loginComoAdmin(page,creds);const agent=creds.capacidades?.agent_id;if(!agent)throw Error('Missing seeded mcp_agent');
 const before=await admin.from('ai_agents').select('config').eq('id',agent).single();expect(before.error).toBeNull();
 try{
 await page.goto('/app/ai/agents/'+agent);const section=page.getByRole('region',{name:'Tempo mínimo de resposta'});
 const toggle=section.getByRole('switch');await expect(toggle).toBeEnabled({timeout:60000});await toggle.setChecked(true);
 await section.getByRole('spinbutton',{name:'Mínimo em segundos',exact:true}).fill('20');await section.getByRole('spinbutton',{name:'Máximo em segundos',exact:true}).fill('30');
 await section.getByRole('button',{name:'Salvar tempo de resposta',exact:true}).click();await expect(section.getByRole('status')).toContainText('salvo e conferido',{timeout:60000});
 await page.reload();await expect(section.getByRole('switch')).toBeChecked({timeout:60000});await expect(section.getByRole('spinbutton',{name:'Mínimo em segundos',exact:true})).toHaveValue('20');await expect(section.getByRole('spinbutton',{name:'Máximo em segundos',exact:true})).toHaveValue('30');
 await section.screenshot({path:evidence+'/tempo-salvo.png'});
 }finally{await admin.from('ai_agents').update({config:before.data?.config??{}}).eq('id',agent);}
});
