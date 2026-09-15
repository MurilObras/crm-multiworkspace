import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FollowupTurnDeps } from "@/lib/agent-engine/agent/followup-turn";
import type { JobRow } from "@/lib/agent-engine/queue/queue";
import type { RunBeforeSendArgs } from "@/lib/agent-engine/guardrails/before-send";

const agent = vi.hoisted(() => vi.fn(async () => {}));
const send = vi.fn(async (..._args: unknown[]) => ({ kind: "sent", messageId: "msg-1", idempotencyKey: "ledger-1" }));
const complete = vi.fn(async () => {});
const chain = vi.fn(async (input: RunBeforeSendArgs) => ({ status: "sent", outcome: await input.send(input.body) }));
vi.mock("@/lib/agent-engine/agent/inbound-turn", () => ({ runAgentTurn: agent, ritualBlocks: () => [], JobSettledError: class extends Error {} }));
vi.mock("@/lib/agent-engine/guardrails/before-send", () => ({ runBeforeSend: (input: RunBeforeSendArgs) => chain(input) }));
vi.mock("@/lib/agent-engine/agent/human-handoff", () => ({ isLeadInHandoff: async () => false }));
vi.mock("@/lib/agent-engine/edge/crm/get-lead-context", () => ({ getLeadContext: async () => ({
  ok: true, context: { contact: { is_blocked: false } }, lgpd: {},
}) }));

import { createFollowupTurnHandler } from "@/lib/agent-engine/agent/followup-turn";
const now = new Date("2026-09-15T12:00:00Z");
const fallback = "11111111-1111-4111-8111-111111111111";
function setup(provider: string, inbound: Date | null, payload: Record<string, unknown> = {}) {
  const conversation = { id: "conv-1", channel_session_id: "s-1", channel_archived_at: null,
    resolved_session_id: "s-1", organization_id: "org-1", provider, channel_status: "WORKING", last_inbound_at: inbound };
  const ledger = { id: 'ledger-1', status: 'accepted', crm_message_id: 'msg-1' };
  const pool = { query: async (sql: string) => ({ rows: /from conversations/.test(sql) ? [conversation]
    : /from send_ledger/.test(sql) ? [ledger] : [] }) };
  const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: {
    name: "retorno", language: "pt_BR", status: "APPROVED", parameter_format: "POSITIONAL",
    components: [{ type: "BODY", text: "Olá!" }],
  }, error: null }) };
  const deps = { crmCfg: { supabase: { from: () => q } }, clock: () => now,
    channel: () => ({ send }), completeFollowupTurn: complete, knobs: {},
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as unknown as FollowupTurnDeps;
  const job = { id: "job-1", organization_id: "org-1", contact_id: "contact-1", payload: {
    followup_enrollment_id: fallback, node_id: "node-1", purpose: "send_message", prompt_hint: "retome", ...payload,
  } } as unknown as JobRow;
  return { run: () => createFollowupTurnHandler(deps)(job, pool as never, { workerId: "worker-1" }), conversation, ledger };
}
beforeEach(() => vi.clearAllMocks());
describe("agent-engine usa o fallback oficial pinado no fluxo", () => {
  it("template queued não conclui o passo; confirmação posterior permite avançar", async () => {
    const s = setup('meta_cloud', null, { fallback_template_id: fallback });
    send.mockResolvedValueOnce({ kind: 'queued', messageId: 'msg-1', idempotencyKey: 'ledger-1' });
    await expect(s.run()).rejects.toThrow(/aguardando confirmação/);
    expect(complete).not.toHaveBeenCalled();
    await s.run();
    expect(complete).toHaveBeenCalledOnce();
  });
  it("turno de IA com ledger queued não conclui o passo", async () => {
    const s = setup('meta_cloud', now);
    s.ledger.status = 'queued';
    await expect(s.run()).rejects.toThrow(/aguardando confirmação/);
    expect(complete).not.toHaveBeenCalled();
    s.ledger.status = 'accepted';
    await s.run();
    expect(complete).toHaveBeenCalledOnce();
  });
  it("turno de IA com envio failed não confirma sucesso", async () => {
    const s = setup('meta_cloud', now); s.ledger.status = 'failed';
    await expect(s.run()).rejects.toThrow('followup_send_not_confirmed');
    expect(complete).not.toHaveBeenCalled();
  });
  it.each(["waha", "meta_cloud"])("%s dentro da janela usa IA normal", async (provider) => {
    await setup(provider, now, { fallback_template_id: fallback }).run();
    expect(agent).toHaveBeenCalledOnce(); expect(send).not.toHaveBeenCalled();
  });
  it("WAHA após 24h não exige fallback", async () => {
    await setup("waha", new Date("2026-09-01")).run();
    expect(agent).toHaveBeenCalledOnce();
  });
  it.each([{}, { fixed_body: "texto fixo" }])("Meta fora da janela usa template sem LLM (%j)", async (payload) => {
    await setup("meta_cloud", null, { fallback_template_id: fallback, ...payload }).run();
    expect(agent).not.toHaveBeenCalled();
    expect(chain.mock.calls[0]?.[0]).toMatchObject({ isTemplate: true, body: "Olá!" });
    expect(send.mock.calls[0]?.[0]).toMatchObject({ conversationId: "conv-1", template: { name: "retorno", language: "pt_BR", values: {} } });
    expect(complete).toHaveBeenCalledOnce();
  });
  it("sem fallback bloqueia explicitamente e não conclui o passo", async () => {
    await expect(setup("meta_cloud", null).run()).rejects.toThrow("messaging_window_closed");
    expect(agent).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled(); expect(complete).not.toHaveBeenCalled();
  });
  it("template enviado não abre janela; resposta do cliente faz IA voltar", async () => {
    const s = setup("meta_cloud", null, { fallback_template_id: fallback });
    await s.run(); expect(agent).not.toHaveBeenCalled();
    s.conversation.last_inbound_at = now;
    await s.run(); expect(agent).toHaveBeenCalledOnce(); expect(send).toHaveBeenCalledOnce();
  });
});
