import { expect, it } from "vitest";
import { plannedMessageContent, responseDeliveryContent, collectResponseDeliveryPlans } from "./export-collector";

it("export entrega texto e parâmetros pessoais sem credenciais de execução",()=>{
  const exported=plannedMessageContent([{id:"synthetic",actions:[{type:"send_whatsapp_message",config:{
    template:"Olá Pessoa Sintética",template_values:{"1":"+12025550100"},
    secret:"synthetic-secret",secret_enc:"synthetic-cipher",url:"https://example.invalid/private",
    headers:{Authorization:"synthetic-token"},
  }}]}]);
  expect(exported).toEqual([{type:"send_whatsapp_message",template:"Olá Pessoa Sintética",template_values:{"1":"+12025550100"}}]);
  expect(JSON.stringify(exported)).not.toMatch(/synthetic-secret|synthetic-cipher|synthetic-token|private/);
});
it("plano redigido não tem conteúdo a entregar",()=>{
  expect(plannedMessageContent([])).toEqual([]);
});

it('export do plano de resposta entrega partes pessoais sem caminhos, chaves ou outro payload',async()=>{
 const plan={body:'Mensagem pendente',approvedBody:'Mensagem aprovada',bubbles:['Mensagem','aprovada'],media:{url:'https://example.invalid/private',agent_id:'internal'},responseKey:'private-key',following:[{body:'Pergunta?',media:{storage_path:'private-path'}}]};
 const filters:unknown[]=[];const query={eq:(...args:unknown[])=>{filters.push(args);return query;},order:()=>query,limit:()=>Promise.resolve({data:[{id:'job',created_at:'date',payload:{response_delivery:plan,secret:'private-secret'}}],error:null})};
 const client={from:(table:string)=>{expect(table).toBe('job_queue');return {select:()=>query};}};
 const exported=await collectResponseDeliveryPlans(client as never,'org','contact');
 expect(filters).toEqual([['organization_id','org'],['contact_id','contact']]);
 expect(exported).toEqual([{job_id:'job',created_at:'date',body:'Mensagem pendente',approved_body:'Mensagem aprovada',parts:['Mensagem','aprovada'],has_media:true,following:[{body:'Pergunta?',has_media:true}]}]);
 expect(JSON.stringify(exported)).not.toMatch(/private|storage_path|agent_id|responseKey/);expect(responseDeliveryContent(undefined)).toBeNull();
});
