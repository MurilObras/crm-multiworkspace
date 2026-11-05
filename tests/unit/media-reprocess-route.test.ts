import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const m=vi.hoisted(()=>({role:vi.fn(),row:null as null|{id:string},retry:vi.fn(),pool:vi.fn(),audit:vi.fn()}));
vi.mock("@/lib/auth/require-role",()=>({requireRole:m.role}));
vi.mock("@/lib/supabase/server",()=>({createClient:async()=>{const c={select:()=>c,eq:()=>c,maybeSingle:async()=>({data:m.row,error:null})};return {from:()=>c};}}));
vi.mock("@/lib/agent-engine/db/request-pool",()=>({getRequestPool:m.pool}));
vi.mock("@/lib/messaging/media/reprocess",()=>({reprocessMedia:m.retry}));
vi.mock("@/lib/audit",()=>({audit:m.audit}));
import { POST } from "@/app/api/v1/messages/[id]/reprocess/route";
const id="11111111-1111-4111-8111-111111111111";
const request=()=>new NextRequest("http://localhost/api/v1/messages/"+id+"/reprocess",{method:"POST"});
beforeEach(()=>{vi.clearAllMocks();m.role.mockResolvedValue({ok:true,user:{id:"user"},org:{orgId:"org"}});m.row={id};m.pool.mockReturnValue({scoped:true});m.retry.mockResolvedValue("queued");});
describe("recuperação da mídia não contorna autorização",()=>{
 it("viewer barrado não chega ao pool nem ao arquivo",async()=>{
  const {fail}=await import("@/lib/api/wrappers");m.role.mockResolvedValue({ok:false,response:fail("forbidden_role","Sem permissão.",403)});
  expect((await POST(request(),{params:Promise.resolve({id})})).status).toBe(403);expect(m.pool).not.toHaveBeenCalled();
 });
 it("mensagem invisível pela sessão não é exposta pelo acesso privilegiado",async()=>{
  m.row=null;expect((await POST(request(),{params:Promise.resolve({id})})).status).toBe(404);expect(m.retry).not.toHaveBeenCalled();
 });
 it("solicitação permitida é auditada e informa pendente, sem prometer resposta automática",async()=>{
  expect((await POST(request(),{params:Promise.resolve({id})})).status).toBe(200);
  expect(m.retry).toHaveBeenCalledWith({scoped:true},"org",id);expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({action:"message.media_reprocess_requested",resourceId:id,actorUserId:"user"}));
 });
 it("processamento concorrente é conflito e não uma nova tarefa",async()=>{
  m.retry.mockResolvedValue("busy");expect((await POST(request(),{params:Promise.resolve({id})})).status).toBe(409);expect(m.audit).not.toHaveBeenCalled();
 });
});
