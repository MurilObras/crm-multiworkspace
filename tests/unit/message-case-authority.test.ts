import type { SupabaseClient } from "@supabase/supabase-js";
import { expect, it } from "vitest";
import { sendMessageHandler } from "@/app/api/v1/messages/_handler";

const conversation_id = "11111111-1111-4111-8111-111111111111";
const resolve_case_id = "22222222-2222-4222-8222-222222222222";

it("nem a IA nem MCP genérico podem usar o consentimento humano de resolução", async () => {
  await expect(sendMessageHandler({} as SupabaseClient, {
    organization_id: "org", requestId: "test", actor: { type: "ai_agent", id: "agent", role: "agent" },
  }, { conversation_id, resolve_case_id, type: "text", body: "Aprovado" }))
    .rejects.toMatchObject({ status: 403, code: "forbidden" });
});

it("a chamada direta do handler também recusa resolver uma consulta com foto", async () => {
  await expect(sendMessageHandler({} as SupabaseClient, {
    organization_id: "org", requestId: "test", actor: { type: "user", id: "actor" },
  }, { conversation_id, resolve_case_id, type: "image", media_storage_path: "foto.jpg" }))
    .rejects.toMatchObject({ status: 422, code: "validation_failed" });
});
