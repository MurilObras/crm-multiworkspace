/**
 * R1 — o envio INLINE de texto fixo do follow-up (`enviarTextoFixoPendente`, o
 * atalho "sem cron e sem agent-worker") BYPASSA `executarTurnoDoAgente`, então
 * precisa do gate de elegibilidade por conta própria. Sem isto, um fluxo de
 * follow-up com nó de texto fixo mandaria mensagem para uma conversa que o gate
 * `allowlist` barra.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CHANNEL_PROVIDER_META, DEFAULT_CHANNEL_PROVIDER } from "@/lib/channels/capabilities";

const sendMessageHandler = vi.fn(async (..._a: unknown[]) => ({ id: "msg-1", status: "sent", error_code: null as string | null }));
const decidir = vi.fn();
const completeTurnForEnrollment = vi.fn(async (..._a: unknown[]) => {});

vi.mock("@/app/api/v1/messages/_handler", () => ({ sendMessageHandler: (...a: unknown[]) => sendMessageHandler(...a) }));
// Aqui se testa preparação/eligibilidade. A identidade durável e o retry do
// helper real são exercitados por tests/unit/followup-inline-ledger.test.ts.
vi.mock("@/lib/agent-engine/edge/crm/inline-send", () => ({
  sendInlineTurnMessage: async (db: unknown, ctx: unknown, _job: string, _contact: string, prepare: () => Promise<unknown>) =>
    sendMessageHandler(db, ctx, await prepare()),
}));
vi.mock("@/lib/automation/start-conversation", () => ({
  ensureConversation: async () => "conv-1",
  sessaoProntaParaEnvio: async () => "sess-1",
}));
vi.mock("@/lib/ai/elegibilidade/consulta-supabase", () => ({
  decidirElegibilidadeDaConversaViaSupabase: (...a: unknown[]) => decidir(...a),
}));
vi.mock("@/lib/followup/turn-bridge", () => ({
  completeTurnForEnrollment: (...a: unknown[]) => completeTurnForEnrollment(...a),
}));
vi.mock("@/lib/followup/engine", () => ({ createSupabaseAdminClient: () => ({}) }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { enviarTextoFixoPendente } from "./enviar-texto-fixo";

const JOB = {
  id: "job-1",
  organization_id: "org-1",
  contact_id: "contact-1",
  payload: { fixed_body: "Oi, tudo bem?", followup_enrollment_id: "enr-1", node_id: "node-1" },
};

const statusUpdates: string[] = [];

/** Admin stub: job_queue (select pending / claim / status) + followup_enrollments. */
function admin(provider = DEFAULT_CHANNEL_PROVIDER, inbound: string | null = null, fallback = false) {
  const make = (table: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {
      _table: table,
      _upd: null as Record<string, unknown> | null,
      select: () => chain,
      eq: () => chain,
      order: () => chain,
      limit: () => chain,
      update: (p: Record<string, unknown>) => {
        chain._upd = p;
        if (table === "job_queue" && typeof p.status === "string") statusUpdates.push(p.status);
        return chain;
      },
      maybeSingle: () => {
        if (table === "conversations") return Promise.resolve({ data: { last_inbound_at: inbound, channel_sessions: { provider } }, error: null });
        if (table === "meta_templates") return Promise.resolve({ data: { name: "retorno", language: "pt_BR", status: "APPROVED",
          parameter_format: "POSITIONAL", components: [{ type: "BODY", text: "Olá!" }] }, error: null });
        if (table === "job_queue" && chain._upd) return Promise.resolve({ data: { id: JOB.id }, error: null });
        if (table === "followup_enrollments")
          return Promise.resolve({ data: { current_node_id: "node-1" }, error: null });
        return Promise.resolve({ data: null, error: null });
      },
      then: (r: (v: unknown) => unknown) => {
        if (table === "job_queue" && !chain._upd) {
          return Promise.resolve({ data: [{ ...JOB, payload: { ...JOB.payload,
            ...(fallback ? { fallback_template_id: "11111111-1111-4111-8111-111111111111" } : {}) } }], error: null }).then(r);
        }
        return Promise.resolve({ data: null, error: null }).then(r);
      },
    };
    return chain;
  };
  return { from: (t: string) => make(t) } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  statusUpdates.length = 0;
});

describe("enviarTextoFixoPendente · gate de elegibilidade", () => {
  it("Meta fora da janela usa fallback oficial no sink", async () => {
    decidir.mockResolvedValue({ permite: true });
    expect(await enviarTextoFixoPendente(admin(CHANNEL_PROVIDER_META, null, true))).toBe(1);
    expect(sendMessageHandler.mock.calls[0]?.[2]).toMatchObject({ type: "template", template_name: "retorno", template_language: "pt_BR" });
    expect(completeTurnForEnrollment).toHaveBeenCalledOnce();
  });

  it("Meta sem fallback bloqueia explicitamente e não completa o passo", async () => {
    decidir.mockResolvedValue({ permite: true });
    expect(await enviarTextoFixoPendente(admin(CHANNEL_PROVIDER_META))).toBe(0);
    expect(sendMessageHandler).not.toHaveBeenCalled();
    expect(completeTurnForEnrollment).not.toHaveBeenCalled();
    expect(statusUpdates).toContain("dead");
  });

  it("resposta reabre a janela e texto fixo volta ao envio livre", async () => {
    decidir.mockResolvedValue({ permite: true });
    expect(await enviarTextoFixoPendente(admin(CHANNEL_PROVIDER_META, new Date().toISOString(), true))).toBe(1);
    expect(sendMessageHandler.mock.calls[0]?.[2]).toMatchObject({ type: "text", body: JOB.payload.fixed_body });
  });

  it("sink failed não é contado como envio nem completa o passo", async () => {
    decidir.mockResolvedValue({ permite: true });
    sendMessageHandler.mockResolvedValueOnce({ id: "msg-1", status: "failed", error_code: "messaging_window_closed" });
    expect(await enviarTextoFixoPendente(admin())).toBe(0);
    expect(completeTurnForEnrollment).not.toHaveBeenCalled();
    expect(statusUpdates).toContain("dead");
  });
  it("conversa NÃO elegível → NÃO envia, job vira 'done'", async () => {
    decidir.mockResolvedValue({ permite: false, motivo: "sem_autorizacao", bloqueioPorAllowlist: true });
    const enviados = await enviarTextoFixoPendente(admin());
    expect(enviados).toBe(0);
    expect(sendMessageHandler).not.toHaveBeenCalled();
    expect(statusUpdates).toContain("done");
  });

  it("conversa elegível → envia normalmente", async () => {
    decidir.mockResolvedValue({ permite: true, motivo: "autorizado", bloqueioPorAllowlist: false });
    const enviados = await enviarTextoFixoPendente(admin());
    expect(enviados).toBe(1);
    expect(sendMessageHandler).toHaveBeenCalledOnce();
  });

  it("erro ao ler elegibilidade → NÃO envia, job volta pra 'pending' (fail-closed)", async () => {
    decidir.mockRejectedValue(new Error("db down"));
    const enviados = await enviarTextoFixoPendente(admin());
    expect(enviados).toBe(0);
    expect(sendMessageHandler).not.toHaveBeenCalled();
    expect(statusUpdates).toContain("pending");
  });
});
