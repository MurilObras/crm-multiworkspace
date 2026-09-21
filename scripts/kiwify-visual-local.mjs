// Preview isolado do COMPONENTE real. Não substitui login/E2E em Supabase Auth.
// Nenhum .env, credencial de integração ou provedor é consultado.
import { createServer } from 'vite';
import { chromium } from '@playwright/test';
import { mkdir,writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const root=process.cwd(), evidence=resolve(root,'.superpowers/evidence/kiwify-stage-two');
await mkdir(evidence,{recursive:true});
const rows=['accepted','failed_before_send','blocked','uncertain','no_phone'].map((status,index)=>({
  receipt_id:`synthetic-${index}`,run_id:status==='no_phone'?null:`run-${index}`,order_id:`KIWIFY-SINTETICO-00${index+1}`,
  intake_status:status==='no_phone'?'accepted_no_phone':'accepted',lead_id:`lead-${index}`,lead_title:'Compra Kiwify',
  contact_id:status==='no_phone'?null:`contact-${index}`,contact_name:status==='no_phone'?null:`Cliente sintético ${index+1}`,
  current_phone:status==='no_phone'?null:'+12025550102',destination_phone:['accepted','uncertain'].includes(status)?'+12025550101':null,
  product_name:'Curso de demonstração',rule_name:status==='no_phone'?null:'Confirmação da compra',action_type:status==='no_phone'?null:'send_whatsapp_message',action_index:status==='no_phone'?null:0,
  channel:status==='no_phone'?null:'waha',conversation_id:['accepted','uncertain'].includes(status)?`conversation-${index}`:null,
  message_id:['accepted','uncertain'].includes(status)?`message-${index}`:null,provider_id:null,
  attempted_at:['accepted','uncertain'].includes(status)?'2026-09-20T14:00:00Z':null,
  created_at:'2026-09-20T14:00:00Z',updated_at:'2026-09-20T14:05:00Z',status,
  reason:status==='blocked'?'consent_declined':status==='failed_before_send'?'template_not_found':null,
}));
const server=await createServer({root,configFile:false,envDir:false,appType:'custom',
  resolve:{alias:[{find:'@/hooks/i18n/useT',replacement:'virtual:kiwify-i18n.ts'},
    {find:'next/link',replacement:'virtual:kiwify-link.tsx'},{find:'@',replacement:root}]},
  plugins:[{name:'isolated-kiwify-preview',resolveId(id){if(id.startsWith('virtual:kiwify-'))return '\0'+id;},
    load(id){
      if(id==='\0virtual:kiwify-i18n.ts')return 'export const useT=()=>text=>text;';
      if(id==='\0virtual:kiwify-link.tsx')return 'import React from "react";export default function Link({href,children,...props}){return React.createElement("a",{href,...props},children)}';
      if(id==='\0virtual:kiwify-preview.tsx')return `import React from 'react';import {createRoot} from 'react-dom/client';
        import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
        import {KiwifyHistoryTab} from '/app/app/webhooks/_components/KiwifyHistoryTab.tsx';
        import {AutomationTemplateFields} from '/app/app/webhooks/_components/AutomationTemplateFields.tsx';
        import '/app/globals.css';
        function Editor(){const [config,setConfig]=React.useState({channel_session_id:'11111111-1111-4111-8111-111111111111'});
          return React.createElement(AutomationTemplateFields,{config,onChange:setConfig});}
        createRoot(document.getElementById('root')).render(React.createElement(QueryClientProvider,{client:new QueryClient({defaultOptions:{queries:{retry:false}}})},
          React.createElement('main',{className:'mx-auto max-w-7xl p-6'},React.createElement('h1',{className:'text-2xl font-semibold'},'Webhooks · Kiwify'),React.createElement(location.search.includes('editor')?Editor:KiwifyHistoryTab,{organizationId:'synthetic-org'}))));`;
    }}],server:{host:'127.0.0.1',port:0}});
server.middlewares.use(async(req,res,next)=>{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname==='/api/v1/channels/templates'){
    assert.equal(req.method,'GET');res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify({data:{waba:'synthetic',templates:[{name:'synthetic_confirmation',language:'pt_BR',status:'APPROVED',
      slots:[{key:'1',value_key:'1',onde:'corpo',expects:'text'}],previews:[]}]}}));return;
  }
  if(url.pathname==='/api/v1/integrations/kiwify/history'){
    assert.equal(req.method,'GET');
    const status=url.searchParams.get('status'),search=url.searchParams.get('search')??'';
    const filtered=rows.filter(r=>(!status||r.status===status)&&(!search||r.order_id.includes(search)||r.contact_name?.includes(search)));
    const page=Number(url.searchParams.get('page')??1),limit=3;
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:{rows:filtered.slice((page-1)*limit,page*limit),has_more:filtered.length>page*limit}}));return;
  }
  if(url.pathname==='/'){
    res.setHeader('Content-Type','text/html');res.end(await server.transformIndexHtml('/',`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/@id/virtual:kiwify-preview.tsx"></script></body></html>`));return;
  }
  next();
});
let browser;
try {
  await server.listen();const port=server.httpServer.address().port;
  browser=await chromium.launch({channel:'msedge',headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:1000}});
  page.setDefaultNavigationTimeout(120000);page.setDefaultTimeout(120000);
  await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${port}/`);await page.getByRole('heading',{name:'Compra KIWIFY-SINTETICO-001'}).waitFor();
  for(const status of rows.map(r=>r.status)){
    await page.getByLabel('Situação').selectOption(status);
    await page.getByRole('heading',{name:`Compra ${rows.find(r=>r.status===status).order_id}`}).waitFor();
    await page.screenshot({path:resolve(evidence,`${status}.png`),fullPage:true});
  }
  assert.equal(await page.getByRole('button',{name:/reenviar|tentar novamente|cancelar|editar/i}).count(),0);
  await page.getByLabel('Situação').selectOption('');
  await page.getByRole('heading',{name:'Compra KIWIFY-SINTETICO-001'}).waitFor();
  await page.getByRole('button',{name:'Próxima'}).click();
  await page.getByRole('heading',{name:'Compra KIWIFY-SINTETICO-004'}).waitFor();
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:resolve(evidence,'mobile.png'),fullPage:true});
  const metrics=await page.evaluate(()=>({viewport:innerWidth,scrollWidth:document.documentElement.scrollWidth,
    links:[...document.querySelectorAll('a')].map(a=>({text:a.textContent,href:a.getAttribute('href')}))}));
  assert(metrics.scrollWidth<=metrics.viewport,'overflow horizontal');assert.deepEqual(errors,[]);
  await page.setViewportSize({width:1440,height:1000});await page.goto(`http://127.0.0.1:${port}/?editor=1`);
  await page.getByRole('combobox').click();await page.getByRole('option',{name:'synthetic_confirmation (pt_BR)'}).click();
  await page.getByRole('textbox').fill('{{nome}}');
  await page.screenshot({path:resolve(evidence,'template-editor.png'),fullPage:true});
  assert.deepEqual(errors,[]);
  await writeFile(resolve(evidence,'preview-report.json'),JSON.stringify({scope:'componente real; dados HTTP sintéticos; sem login/Auth; não é E2E completo',metrics,errors},null,2));
  console.info(`PASS visual preview: cinco situações, paginação, 390px sem overflow; ${evidence}`);
} finally {await browser?.close();await server.close();}
