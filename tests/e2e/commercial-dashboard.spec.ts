import { test,expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { readFileSync,mkdirSync } from 'node:fs';
import path from 'node:path';
import { carregarEnvLocal } from '../../scripts/lib/env-de-teste';
const env=carregarEnvLocal();
const db=createClient(env.NEXT_PUBLIC_SUPABASE_URL!,env.SUPABASE_SERVICE_ROLE_KEY!,{auth:{persistSession:false,autoRefreshToken:false}});
const suffix=Date.now().toString();
let org='',pipeline='',lead='',stage='',userId='';
const email=`e2e-dashboard-${suffix}@deskcomm.test`;
const creds=JSON.parse(readFileSync(path.join(process.cwd(),'.e2e-creds.json'),'utf8')) as {
  org_id:string;password:string;users:Record<string,{email:string;id:string}>;
};
test.describe('Dashboard: pagamento confirmado e configuração persistida',()=>{
  test.describe.configure({mode:'serial',timeout:180_000});
  test.beforeAll(async()=>{
    const account=await db.auth.admin.createUser({email,password:creds.password,email_confirm:true});
    if(account.error)throw account.error;userId=account.data.user.id;
    const organization=await db.from('organizations').insert({slug:`dashboard-e2e-${suffix}`,legal_name:'Dashboard E2E',display_name:'Dashboard E2E',onboarded_at:new Date().toISOString()}).select('id').single();
    if(organization.error)throw organization.error;org=organization.data.id;
    const membership=await db.from('user_organizations').insert({organization_id:org,user_id:userId,role:'manager'});
    if(membership.error)throw membership.error;
    const p=await db.from('crm_pipelines').insert({organization_id:org,name:`Dashboard E2E ${suffix}`,slug:`dashboard-e2e-${suffix}`}).select('id').single();
    if(p.error)throw p.error;pipeline=p.data.id;
    const s=await db.from('crm_stages').insert([{organization_id:org,pipeline_id:pipeline,name:'Conversa',slug:`conversa-${suffix}`,position:1000,is_won:false,is_lost:false},
      {organization_id:org,pipeline_id:pipeline,name:'Confirmado',slug:`confirmado-${suffix}`,position:2000,is_won:true,is_lost:false}]).select('id,is_won');
    if(s.error)throw s.error;stage=s.data.find(x=>!x.is_won)!.id;
    const l=await db.from('crm_leads').insert({organization_id:org,pipeline_id:pipeline,stage_id:stage,title:`Pagamento E2E ${suffix}`,
      value_cents:25000,currency:'BRL',position_in_stage:1000,source:'manual'}).select('id').single();
    if(l.error)throw l.error;lead=l.data.id;
  });
  test.afterAll(async()=>{
    if(lead) {await db.from('crm_first_payments').delete().eq('organization_id',org).eq('lead_id',lead);
      await db.from('crm_leads').delete().eq('organization_id',org).eq('id',lead);}
    if(pipeline){await db.from('crm_stages').delete().eq('organization_id',org).eq('pipeline_id',pipeline);
      await db.from('crm_pipelines').delete().eq('organization_id',org).eq('id',pipeline);}
    if(org)await db.from('organizations').delete().eq('id',org);
    if(userId)await db.auth.admin.deleteUser(userId);
  });
  test('gestor configura qualificação e registra 1 venda com 2 unidades pela tela',async({page},testInfo)=>{
    await page.goto('/login');await page.locator('#email').fill(email);
    await page.locator('#password').fill(creds.password);await page.getByRole('button',{name:/entrar/i}).click();
    await page.waitForURL(/\/app/);await page.goto('/app/dashboard');
    await expect(page.getByTestId('commercial-dashboard')).toBeVisible();
    await page.getByLabel('Funil',{exact:true}).selectOption(pipeline);
    await page.getByRole('button',{name:'Configurar indicadores',exact:true}).click();
    const config=page.getByRole('dialog');await config.getByLabel('Conversa',{exact:true}).check();
    await config.getByLabel('Nome da quantidade vendida').fill('Matrículas');
    await config.getByRole('button',{name:'Salvar configurações'}).click();await expect(config).not.toBeVisible();
    await page.reload();await page.getByLabel('Funil',{exact:true}).selectOption(pipeline);
    await page.getByRole('button',{name:'Configurar indicadores',exact:true}).click();
    await expect(config.getByLabel('Conversa',{exact:true})).toBeChecked();await expect(config.getByLabel('Nome da quantidade vendida')).toHaveValue('Matrículas');
    await page.keyboard.press('Escape');
    await page.getByRole('button',{name:'Registrar pagamento',exact:true}).click();
    const payment=page.getByRole('dialog');await payment.getByLabel('Negócio',{exact:true}).selectOption(lead);
    await payment.getByLabel('Valor recebido',{exact:true}).fill('250.00');await payment.getByLabel('Quantidade vendida',{exact:true}).fill('2');
    await payment.getByLabel('Conferi e confirmo o recebimento deste valor.').check();
    await payment.getByRole('button',{name:'Confirmar pagamento',exact:true}).click();await expect(payment).not.toBeVisible();
    const row=await db.from('crm_first_payments').select('amount_cents,quantity').eq('organization_id',org).eq('lead_id',lead).single();
    expect(row.error).toBeNull();expect(row.data).toEqual({amount_cents:25000,quantity:2});
    await page.reload();await page.getByLabel('Funil',{exact:true}).selectOption(pipeline);
    await expect(page.getByText('Vendas confirmadas',{exact:true}).locator('..')).toContainText('1');
    await expect(page.getByText('Matrículas',{exact:true}).locator('..')).toContainText('2');
    const evidence=path.join(process.cwd(),'.superpowers/evidence/commercial-dashboard');mkdirSync(evidence,{recursive:true});
    const screenshot=path.join(evidence,'pagamento-quantidade-e-configuracao.png');await page.screenshot({path:screenshot,fullPage:true});
    await testInfo.attach('Dashboard com pagamento confirmado',{path:screenshot,contentType:'image/png'});
  });
});
