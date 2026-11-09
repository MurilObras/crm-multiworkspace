import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sendMessageSchema } from "@/lib/schemas/messaging";
import { listarChamados } from "@/lib/escalacao/chamados";

const org = "11111111-1111-4111-8111-111111111111";
const conv = "22222222-2222-4222-8222-222222222222";
const caseId = "33333333-3333-4333-8333-333333333333";

describe("consulta associada ao envio", () => {
  it("preserva a escolha explícita no texto e no áudio", () => {
    expect(sendMessageSchema.parse({ conversation_id: conv, type: "text", body: "Pode seguir", resolve_case_id: caseId })).toMatchObject({ resolve_case_id: caseId });
    expect(sendMessageSchema.parse({ conversation_id: conv, type: "audio", media_storage_path: "audio.ogg", resolve_case_id: caseId })).toMatchObject({ resolve_case_id: caseId });
  });
  it("recusa associação inválida ou tentativa de concluir com mídia não autorizada", () => {
    expect(sendMessageSchema.safeParse({ conversation_id: conv, body: "ok", resolve_case_id: "errado" }).success).toBe(false);
    expect(sendMessageSchema.safeParse({ conversation_id: conv, type: "image", media_storage_path: "foto.jpg", resolve_case_id: caseId }).success).toBe(false);
    expect(sendMessageSchema.safeParse({ conversation_id: conv, type: "text", body: "   ", resolve_case_id: caseId }).success).toBe(false);
  });
  it("a lista da resposta contém somente consultas da conversa e organização atuais", async () => {
    const rows = [
      { id: caseId, organization_id: org, conversation_id: conv, status: "awaiting_human", conversations: null },
      { id: "other-conv", organization_id: org, conversation_id: "other", status: "awaiting_human", conversations: null },
      { id: "other-org", organization_id: "other", conversation_id: conv, status: "awaiting_human", conversations: null },
    ];
    const db = { from: () => {
      let selected = rows.slice();
      const chain = {
        select: () => chain,
        eq: (key: string, value: unknown) => { selected = selected.filter(row => row[key as keyof typeof row] === value); return chain; },
        in: (key: string, values: unknown[]) => { selected = selected.filter(row => values.includes(row[key as keyof typeof row])); return chain; },
        order: () => chain, limit: () => chain,
        then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: selected, count: selected.length, error: null }).then(resolve),
      };
      return chain;
    } } as unknown as SupabaseClient;
    const result = await listarChamados(db, org, { estado: "abertos", conversationId: conv } as Parameters<typeof listarChamados>[2]);
    expect(result.chamados.map(row => row.id)).toEqual([caseId]);
    expect(result.abertos).toBe(1);
  });
});
