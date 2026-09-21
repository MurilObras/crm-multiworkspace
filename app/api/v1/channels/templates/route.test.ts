import { beforeEach,it,expect,vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "./route";
const state=vi.hoisted(()=>({roles:[] as string[],allowed:true,filters:[] as Array<[string,unknown]>,reads:0}));
const session="11111111-1111-4111-8111-111111111111";
vi.mock("@/lib/auth/require-role",()=>({requireRole:async(role:string)=>{
  state.roles.push(role);return state.allowed?{ok:true,org:{orgId:"synthetic-org"}}
    :{ok:false,response:Response.json({error:{code:"forbidden_role"}},{status:403})};
}}));
vi.mock("@/lib/channels/meta/session",()=>({metaSessionForOrg:async()=>null}));
vi.mock("@/lib/supabase/admin",()=>({createAdminClient:()=>({from:()=>{
  state.reads++;
  const data=[{organization_id:"synthetic-org",channel_session_id:session,name:"approved",language:"pt_BR",status:"APPROVED",components:[{type:"BODY",text:"Olá {{1}}"}],contract_hash:"synthetic"},
    {organization_id:"other-org",channel_session_id:session,name:"foreign",language:"pt_BR",status:"APPROVED",components:[]},
    {organization_id:"synthetic-org",channel_session_id:session,name:"pending",language:"pt_BR",status:"PENDING",components:[]}];
  class Query {
    select(){return this;}order(){return this;}
    eq(key:string,value:unknown){state.filters.push([key,value]);return this;}
    then(resolve:(value:unknown)=>unknown){return Promise.resolve(resolve({data:data.filter(row=>state.filters.every(([key,value])=>(row as Record<string,unknown>)[key]===value)),error:null}));}
  }
  return new Query();
}})}));
beforeEach(()=>{state.roles=[];state.filters=[];state.allowed=true;state.reads=0;});
it("manager consulta apenas templates aprovados do canal na organização autenticada",async()=>{
  const response=await GET(new NextRequest(`http://localhost/api/v1/channels/templates?channel_session_id=${session}&organization_id=other-org`));
  expect(response.status).toBe(200);expect(state.roles).toEqual(["manager"]);
  const body=await response.json();expect(body.data.templates.map((t:{name:string})=>t.name)).toEqual(["approved"]);
  expect(body.data.templates[0].slots[0]).toMatchObject({key:"1",value_key:"1"});
  expect(state.filters).toContainEqual(["organization_id","synthetic-org"]);
});
it("consulta administrativa sem filtro mantém o papel admin",async()=>{
  await GET();expect(state.roles).toEqual(["admin"]);
});
it("papel insuficiente não consulta o catálogo",async()=>{
  state.allowed=false;expect((await GET(new NextRequest(`http://localhost/api/v1/channels/templates?channel_session_id=${session}`))).status).toBe(403);
  expect(state.reads).toBe(0);
});
it("identificador inválido não chega à query",async()=>{
  expect((await GET(new NextRequest("http://localhost/api/v1/channels/templates?channel_session_id=invalid"))).status).toBe(400);
  expect(state.reads).toBe(0);
});
