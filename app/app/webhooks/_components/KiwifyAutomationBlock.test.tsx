import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/lib/api/client", () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));

import { apiClient } from "@/lib/api/client";
import { toast } from "sonner";
import { KiwifyAutomationBlock } from "./KiwifyAutomationBlock";
import type { AutomationRuleRow } from "@/hooks/webhooks/useAutomationRules";

// Polyfills que o Radix Select exige e o jsdom não tem.
window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
window.HTMLElement.prototype.setPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();

const PRODUCT_ID = "33333333-3333-4333-8333-333333333333";
const CHANNEL_ID = "44444444-4444-4444-8444-444444444444";

const purchaseRule: AutomationRuleRow = {
  id: "rule-1",
  organization_id: "org",
  name: "Aviso de compra",
  trigger_event: "lead.created",
  conditions: [
    { field: "event.kiwify_event_type", op: "eq", value: "order_approved" },
    { field: "event.product_id", op: "eq", value: PRODUCT_ID },
  ],
  actions: [{ type: "send_whatsapp_message", config: { channel_session_id: CHANNEL_ID, template: "Oi!" } }],
  is_active: false,
  last_run_at: null,
  run_count: 0,
  created_at: "2026-09-20T10:00:00Z",
  updated_at: "2026-09-20T10:00:00Z",
  last_change_actor_kind: null,
  last_change_at: null,
};

function mockGet(rules: AutomationRuleRow[] = []) {
  vi.mocked(apiClient.get).mockImplementation(async (path: string) => {
    if (path === "/api/v1/integrations/kiwify") return { data: { integrations: [], products: [], links: [] } };
    if (path === "/api/v1/integrations/kiwify/options") return { data: { agents: [], followups: [] } };
    if (path === "/api/v1/automation-rules") return { data: rules };
    if (path === "/api/v1/channel-sessions") return { data: [] };
    if (path === "/api/v1/products") return { data: [] };
    if (path.includes("/board")) return { data: { stages: [] } };
    if (path === "/api/v1/pipelines") return { data: [] };
    return { data: [] };
  });
}

function mount() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}>
      <KiwifyAutomationBlock />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("KiwifyAutomationBlock", () => {
  it("sem automação de compra, oferece o botão de criar", async () => {
    mockGet([]);
    mount();
    expect(await screen.findByRole("button", { name: "Criar automação de compra" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Gerenciar automação" })).toBeNull();
  });

  it("com automação de compra existente, mostra status e permite gerenciar", async () => {
    const user = userEvent.setup({ delay: null });
    mockGet([purchaseRule]);
    vi.mocked(apiClient.patch).mockResolvedValue({ data: { ...purchaseRule, is_active: true } });
    mount();

    expect(await screen.findByText("Aviso de compra")).toBeVisible();
    expect(screen.getByText("Pausada")).toBeVisible();
    expect(screen.getByRole("button", { name: "Gerenciar automação" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Criar automação de compra" })).toBeVisible();

    await user.click(screen.getByRole("switch", { name: "Ligar Aviso de compra" }));
    await waitFor(() => expect(apiClient.patch).toHaveBeenCalledTimes(1));
    const [rota, corpo] = vi.mocked(apiClient.patch).mock.calls[0]!;
    expect(rota).toBe("/api/v1/automation-rules/rule-1");
    expect(corpo).toEqual({ is_active: true });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Automação ligada."));
  });

  it("criação gera uma única regra pausada, mesmo com duplo clique", async () => {
    const user = userEvent.setup({ delay: null });
    vi.mocked(apiClient.get).mockImplementation(async (path: string) => {
      if (path === "/api/v1/integrations/kiwify") return { data: { integrations: [{ id: "integration-1", name: "Loja", pipeline_id: "pipeline-1" }], products: [{ integration_id: "integration-1", product_id: PRODUCT_ID }] } };
      if (path === "/api/v1/integrations/kiwify/options") return { data: { agents: [], followups: [] } };
      if (path === "/api/v1/automation-rules") return { data: [] };
      if (path === "/api/v1/channel-sessions") return { data: [{ id: CHANNEL_ID, display_name: "Número 1", phone_number: null, status: "WORKING" }] };
      if (path === "/api/v1/products") return { data: [{ id: PRODUCT_ID, nome: "Produto interno", ativo: true }] };
      if (path.includes("/board")) return { data: { stages: [] } };
      if (path === "/api/v1/pipelines") return { data: [] };
      return { data: [] };
    });
    vi.mocked(apiClient.post).mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 50));
      return { data: { id: "rule-new" } };
    });
    mount();

    await user.click(await screen.findByRole("button", { name: "Criar automação de compra" }));
    await user.type(screen.getByLabelText("Nome da automação"), "Aviso de compra");
    await user.click(screen.getByRole("combobox", { name: "Produto" }));
    await user.click(await screen.findByRole("option", { name: "Produto interno" }));
    await user.click(screen.getByRole("combobox", { name: "Número de WhatsApp" }));
    await user.click(await screen.findByRole("option", { name: "Número 1" }));
    await user.type(screen.getByRole("textbox", { name: "Texto da mensagem" }), "Oi!");

    const btn = screen.getByRole("button", { name: "Criar automação" });
    fireEvent.click(btn);
    fireEvent.click(btn);

    await waitFor(() => expect(apiClient.post).toHaveBeenCalled());
    await waitFor(() => expect(vi.mocked(apiClient.post).mock.calls.filter((c) => c[0] === "/api/v1/automation-rules").length).toBe(1));
    const [rota, corpo] = vi.mocked(apiClient.post).mock.calls[0]!;
    expect(rota).toBe("/api/v1/automation-rules");
    // Chave de idempotência enviada para reconciliar resposta perdida.
    expect((vi.mocked(apiClient.post).mock.calls[0]![2] as { idempotencyKey?: string } | undefined)?.idempotencyKey).toBeTruthy();
    // Regra nasce pausada: is_active nunca vai no create (schema não aceita).
    expect(corpo).not.toHaveProperty("is_active");
    expect(corpo).toMatchObject({
      trigger_event: "lead.created",
      conditions: [
        { field: "event.kiwify_event_type", op: "eq", value: "order_approved" },
        { field: "event.product_id", op: "eq", value: PRODUCT_ID },
      ],
    });
    expect((corpo as { actions: Array<{ type: string }> }).actions).toHaveLength(1);
    expect((corpo as { actions: Array<{ type: string }> }).actions[0]!.type).toBe("send_whatsapp_message");
    await waitFor(() => expect(apiClient.put).toHaveBeenCalledWith("/api/v1/integrations/kiwify/integration-1/automations", { rule_id: "rule-new" }));
    // Drena o fluxo assíncrono do submit para não vazar toast para o teste seguinte.
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Automação criada — ligue quando estiver pronta."));
  });
});
