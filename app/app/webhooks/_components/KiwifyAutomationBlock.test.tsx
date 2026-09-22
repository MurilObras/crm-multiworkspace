import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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
    expect(screen.queryByRole("button", { name: "Criar automação de compra" })).toBeNull();

    await user.click(screen.getByRole("switch", { name: "Ligar Aviso de compra" }));
    await waitFor(() => expect(apiClient.patch).toHaveBeenCalledTimes(1));
    const [rota, corpo] = vi.mocked(apiClient.patch).mock.calls[0]!;
    expect(rota).toBe("/api/v1/automation-rules/rule-1");
    expect(corpo).toEqual({ is_active: true });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Automação ligada."));
  });
});
