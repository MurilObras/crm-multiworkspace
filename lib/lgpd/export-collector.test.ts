import { expect, it } from "vitest";
import { plannedMessageContent } from "./export-collector";

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
