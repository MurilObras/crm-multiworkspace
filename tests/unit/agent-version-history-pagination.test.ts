import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const mocks=vi.hoisted(()=>({role:vi.fn(),client:vi.fn(),rows:[] as {id:string;version_number:number}[],calls:[] as unknown[][]}));
vi.mock("@/lib/auth/require-role",()=>({requireRole:mocks.role}));
vi.mock("@/lib/supabase/server",()=>({createClient:mocks.client}));
import { GET } from "@/app/api/v1/ai/agents/[id]/versions/route";
const id="11111111-1111-4111-8111-111111111111";
beforeEach(()=>{
 mocks.calls=[];mocks.rows=[];mocks.role.mockResolvedValue({ok:true,org:{orgId:"workspace"}});
 const chain:Record<string,unknown>={};
 for(const method of ["select","eq","order","limit","lt"]) chain[method]=(...args:unknown[])=>{mocks.calls.push([method,...args]);return chain;};
 chain.then=(resolve:(v:unknown)=>unknown)=>Promise.resolve({data:mocks.rows,error:null}).then(resolve);
 mocks.client.mockResolvedValue({from:()=>chain});
});
describe("histórico paginado do agente",()=>{
 it("limita a página, filtra org/agente e informa cursor sem repetir a borda",async()=>{
  mocks.rows=[{id:"v9",version_number:9},{id:"v8",version_number:8},{id:"v7",version_number:7}];
  const r=await GET(new NextRequest("http://localhost/api/v1/ai/agents/"+id+"/versions?limit=2&before_version=10"),{params:Promise.resolve({id})});
  expect(r.status).toBe(200);expect(await r.json()).toMatchObject({data:[{id:"v9"},{id:"v8"}],meta:{has_more:true,cursor:"8"}});
  expect(mocks.calls).toContainEqual(["eq","organization_id","workspace"]);expect(mocks.calls).toContainEqual(["eq","agent_id",id]);
  expect(mocks.calls).toContainEqual(["limit",3]);expect(mocks.calls).toContainEqual(["lt","version_number",10]);
 });
 it.each(["limit=101","limit=-1","before_version=abc"])("rejeita página inválida %s antes de consultar",async query=>{
  const r=await GET(new NextRequest("http://localhost/api/v1/ai/agents/"+id+"/versions?"+query),{params:Promise.resolve({id})});
  expect(r.status).toBe(422);expect(mocks.calls).toEqual([]);
 });
});
