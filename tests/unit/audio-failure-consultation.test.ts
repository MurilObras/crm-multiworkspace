import { beforeEach, describe, expect, it, vi } from "vitest";
import type pg from "pg";
const mocks=vi.hoisted(()=>({open:vi.fn(),exists:vi.fn()}));
vi.mock("@/lib/agent-engine/agent/human-cases",()=>({openCase:mocks.open,hasOpenCaseForContact:mocks.exists}));
import { consultFailedAudio } from "@/lib/agent-engine/agent/audio-failure-consultation";
const ids={tenantId:"org",conversationId:"conv",agentId:"agent"};
beforeEach(()=>{vi.clearAllMocks();mocks.open.mockResolvedValue({ok:true,caseId:"case"});mocks.exists.mockResolvedValue(false);});
function db(row:unknown){ const query=vi.fn().mockResolvedValue({rows:row?[row]:[]});return {pool:{query} as unknown as pg.Pool,query}; }
describe("áudio sem transcrição segura",()=>{
 it("consulta a equipe sem gerar corpo de resposta ao cliente",async()=>{
  const {pool,query}=db({id:"anchor",type:"audio",media_derived_status:"failed"});
  expect(await consultFailedAudio(pool,ids,"anchor")).toBe(true);expect(query).toHaveBeenCalledWith(expect.stringContaining("organization_id=$1 and conversation_id=$2"),["org","conv"]);
  expect(mocks.open).toHaveBeenCalledWith(pool,ids,expect.objectContaining({contextSnapshot:{message_id:"anchor",media_derived_status:"failed"}}));
 });
 it.each([{id:"newer",type:"audio",media_derived_status:"failed"},{id:"anchor",type:"audio",media_derived_status:"pending"},{id:"anchor",type:"text",media_derived_status:"failed"}])("não consulta sobre áudio antigo/pendente ou texto",async row=>{
  expect(await consultFailedAudio(db(row).pool,ids,"anchor")).toBe(false);expect(mocks.open).not.toHaveBeenCalled();
 });
 it("mantém consulta existente e falha fechado se nenhuma consulta abriu",async()=>{
  const {pool}=db({id:"anchor",type:"audio",media_derived_status:"failed"});mocks.open.mockResolvedValue({ok:false});mocks.exists.mockResolvedValue(true);
  expect(await consultFailedAudio(pool,ids,"anchor")).toBe(true);mocks.exists.mockResolvedValue(false);
  await expect(consultFailedAudio(pool,ids,"anchor")).rejects.toThrow("audio_failure_consultation_not_opened");
 });
});

it("processamento atrasado também consulta antes de o modelo alegar que não entendeu",async()=>{
 const now=new Date("2026-11-05T15:00:00Z");
 const {pool}=db({id:"anchor",type:"audio",media_derived_status:"pending",created_at:"2026-11-05T14:57:59Z"});
 expect(await consultFailedAudio(pool,ids,"anchor",now)).toBe(true);
 expect(mocks.open).toHaveBeenCalledWith(pool,ids,expect.objectContaining({contextSnapshot:{message_id:"anchor",media_derived_status:"pending"}}));
});
it("não interpreta lentidão recente como falha terminal",async()=>{
 const now=new Date("2026-11-05T15:00:00Z");
 expect(await consultFailedAudio(db({id:"anchor",type:"audio",media_derived_status:"pending",created_at:"2026-11-05T14:59:30Z"}).pool,ids,"anchor",now)).toBe(false);
 expect(mocks.open).not.toHaveBeenCalled();
});
