import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks=vi.hoisted(()=>({tables:{} as Record<string,Record<string,unknown>[]>,calls:[] as unknown[][]}));
vi.mock("@/lib/supabase/server",()=>({createClient:async()=>({from:(table:string)=>{
 const chain:Record<string,unknown>={}; for(const name of ["select","eq","in","order","limit"])chain[name]=(...args:unknown[])=>{mocks.calls.push([table,name,...args]);return chain;};
 chain.then=(resolve:(v:unknown)=>unknown)=>Promise.resolve({data:mocks.tables[table]??[],error:null}).then(resolve);return chain;
}})}));
import { inboxOrigins } from "@/lib/ai/inbox-origins";
beforeEach(()=>{mocks.tables={};mocks.calls=[];});
describe("origem dos avisos respeita a sessão",()=>{
 it("não revela link de conversa que a sessão não pode ler",async()=>{
  mocks.tables.job_queue=[{id:"job",status:"dead",contact_id:"contact",payload:{conversation_id:"private"}}];
  expect((await inboxOrigins("org",[{id:"notice",ref_kind:"job",ref_id:"job"}])).size).toBe(0);
 });
 it("abre o atendimento da mensagem e informa estado atual sem reescrever o alerta",async()=>{
  mocks.tables.messages=[{id:"message",conversation_id:"conv",media_derived_status:"ready"}];mocks.tables.conversations=[{id:"conv",contact_id:"contact",status:"ai_handling"}];
  expect((await inboxOrigins("org",[{id:"notice",ref_kind:"message",ref_id:"message"}])).get("notice")).toMatchObject({href:"/app/inbox?id=conv",state:"ready"});
  for(const table of ["messages","conversations"])expect(mocks.calls).toContainEqual([table,"eq","organization_id","org"]);
 });
});
