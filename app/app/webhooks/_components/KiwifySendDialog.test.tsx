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
import { KiwifySendDialog } from "./KiwifySendDialog";
import type { KiwifyHistoryRow } from "@/lib/automation/kiwify-history";

// Polyfills que o Radix Select exige e o jsdom não tem.
window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
window.HTMLElement.prototype.setPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();

const CHANNEL = {
  id: "44444444-4444-4444-8444-444444444444",
  display_name: "Número 1",
  phone_number: "+5511999999999",
  status: "WORKING",
};

const row: KiwifyHistoryRow = {
  receipt_id: "receipt", run_id: null, order_id: "SYNTHETIC-001", intake_status: "accepted",
  lead_id: "lead", lead_title: "Compra sintética", contact_id: "contact",
  contact_name: "Pessoa sintética", current_phone: "+12025550102", destination_phone: "+12025550101",
  product_id: "product", product_name: "Produto sintético", rule_name: null, action_type: null, action_index: null,
  channel: null, conversation_id: null, message_id: null, provider_id: null, attempted_at: null,
  contact_blocked: false, created_at: "2026-09-20T10:00:00Z", updated_at: "2026-09-20T10:00:00Z",
  status: "not_started", reason: null,
};

function mount() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}>
      <KiwifySendDialog open onOpenChange={() => {}} row={row} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(apiClient.get).mockImplementation(async (path: string) => {
    if (path === "/api/v1/channel-sessions") return { data: [CHANNEL] };
    return { data: [] };
  });
});

describe("KiwifySendDialog", () => {
  it("envia contato e canal corretos pelo caminho canônico (open-with-contact → messages)", async () => {
    const user = userEvent.setup({ delay: null });
    vi.mocked(apiClient.post).mockImplementation(async (path: string) => {
      if (path === "/api/v1/conversations/open-with-contact") {
        return { data: { conversation_id: "conversation", contact_id: "contact" } };
      }
      return { data: {} };
    });
    mount();

    await user.click(await screen.findByRole("combobox", { name: "Número de WhatsApp" }));
    await user.click(await screen.findByRole("option", { name: "Número 1" }));
    await user.type(screen.getByRole("textbox", { name: "Texto da mensagem" }), "Oi, obrigado!");
    await user.click(screen.getByRole("button", { name: "Confirmar envio" }));

    await waitFor(() => expect(apiClient.post).toHaveBeenCalledTimes(2));
    const [openRota, openCorpo] = vi.mocked(apiClient.post).mock.calls[0]!;
    expect(openRota).toBe("/api/v1/conversations/open-with-contact");
    expect(openCorpo).toEqual({ contact_id: "contact", channel_session_id: CHANNEL.id });

    const [msgRota, msgCorpo] = vi.mocked(apiClient.post).mock.calls[1]!;
    expect(msgRota).toBe("/api/v1/messages");
    expect(msgCorpo).toEqual({ conversation_id: "conversation", type: "text", body: "Oi, obrigado!" });
    // Drena o fluxo assíncrono do submit para não vazar toast/sucesso para o teste seguinte.
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Mensagem enviada."));
  });

  it("duplo clique não abre a conversa / envia duas vezes", async () => {
    const user = userEvent.setup({ delay: null });
    vi.mocked(apiClient.post).mockImplementation(async (path: string) => {
      if (path === "/api/v1/conversations/open-with-contact") {
        return { data: { conversation_id: "conversation", contact_id: "contact" } };
      }
      return { data: {} };
    });
    mount();

    await user.click(await screen.findByRole("combobox", { name: "Número de WhatsApp" }));
    await user.click(await screen.findByRole("option", { name: "Número 1" }));
    await user.type(screen.getByRole("textbox", { name: "Texto da mensagem" }), "Oi");

    const btn = screen.getByRole("button", { name: "Confirmar envio" });
    fireEvent.click(btn);
    fireEvent.click(btn);
    await waitFor(() => expect(vi.mocked(apiClient.post).mock.calls.filter((c) => c[0] === "/api/v1/conversations/open-with-contact").length).toBe(1));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Mensagem enviada."));
  });

  it("falha ao abrir a conversa não mostra sucesso nem envia mensagem", async () => {
    const user = userEvent.setup({ delay: null });
    vi.mocked(apiClient.post).mockImplementation(async (path: string) => {
      if (path === "/api/v1/conversations/open-with-contact") throw new Error("synthetic");
      return { data: {} };
    });
    mount();

    await user.click(await screen.findByRole("combobox", { name: "Número de WhatsApp" }));
    await user.click(await screen.findByRole("option", { name: "Número 1" }));
    await user.type(screen.getByRole("textbox", { name: "Texto da mensagem" }), "Oi");
    await user.click(screen.getByRole("button", { name: "Confirmar envio" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(toast.success).not.toHaveBeenCalled();
    expect(vi.mocked(apiClient.post).mock.calls.some((c) => c[0] === "/api/v1/messages")).toBe(false);
  });
});
