import { beforeEach,it,expect,vi } from "vitest";
import { NextRequest } from "next/server";
import * as route from "./route";
const state=vi.hoisted(()=>({allowed:true,queries:vi.fn(async()=>({rows:[]})),release:vi.fn(),connect:vi.fn()}));
vi.mock("@/lib/auth/require-role",()=>({requireRole:vi.fn(async(role:string)=>{
  expect(role).toBe("manager");return state.allowed?{ok:true,user:{id:"synthetic-user"},org:{orgId:"synthetic-org"}}
    :{ok:false,response:Response.json({error:{code:"forbidden_role"}},{status:403})};
})}));
vi.mock("@/lib/agent-engine/db/request-pool",()=>({getRequestPool:()=>({connect:state.connect})}));
beforeEach(()=>{vi.clearAllMocks();state.allowed=true;state.connect.mockResolvedValue({query:state.queries,release:state.release});});
it("somente GET, manager obrigatório antes de tocar no banco",async()=>{
  expect("POST" in route).toBe(false);expect("PATCH" in route).toBe(false);expect("DELETE" in route).toBe(false);
  state.allowed=false;expect((await route.GET(new NextRequest("http://localhost/api/v1/integrations/kiwify/history"))).status).toBe(403);
  expect(state.connect).not.toHaveBeenCalled();
});
it("valida paginação e datas antes de consultar",async()=>{
  expect((await route.GET(new NextRequest("http://localhost/api/v1/integrations/kiwify/history?page=-1"))).status).toBe(400);
  expect(state.connect).not.toHaveBeenCalled();
});
it("consulta somente leitura com identidade da sessão e organização confiável",async()=>{
  const response=await route.GET(new NextRequest("http://localhost/api/v1/integrations/kiwify/history?organization_id=forged"));
  expect(response.status).toBe(200);
  expect(state.queries).toHaveBeenCalledWith("begin read only");
  expect(state.queries).toHaveBeenCalledWith("select set_config('request.jwt.claim.sub',$1,true)",["synthetic-user"]);
  expect(state.queries).toHaveBeenCalledWith("set local role authenticated");
  expect(state.release).toHaveBeenCalledOnce();
});
it("erro de conexão não expõe URL ou segredo",async()=>{
  state.connect.mockRejectedValueOnce(new Error("postgres://synthetic-secret"));
  const response=await route.GET(new NextRequest("http://localhost/api/v1/integrations/kiwify/history"));
  expect(response.status).toBe(500);expect(await response.text()).not.toContain("synthetic-secret");
});
