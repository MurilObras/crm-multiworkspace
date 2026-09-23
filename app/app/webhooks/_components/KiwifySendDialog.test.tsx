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
import type { Message } from "@/lib/types/messaging";

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

function msg(status: Message["status"], external_id: string | null): Message {
  return {
    id: "m1", organization_id: "org", conversation_id: "conversation", channel_session_id: CHANNEL.id,
    contact_id: "contact", external_id, type: "text", direction: "outbound", status, ack: 0,
    error_code: null, error_message: null, body: "Oi", media_url: null, media_mime: null,
    media_size_bytes: null, media_storage_path: null, sent_via: "user", sent_by_user_id: null,
    sent_at: "2026-09-20T10:00:00Z", delivered_at: null, read_at: null, metadata: {},
    edited_at: null, revoked_at: null, reply_to_message_id: null, created_at: "2026-09-20T10:00:00Z",
  };
}

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
      return { data: msg("sent", "wamid-1") };
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
      return { data: msg("sent", "wamid-1") };
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

  it("queued não vira sucesso — avisa fila", async () => {
    const user = userEvent.setup({ delay: null });
    vi.mocked(apiClient.post).mockImplementation(async (path: string) => {
      if (path === "/api/v1/conversations/open-with-contact") {
        return { data: { conversation_id: "conversation", contact_id: "contact" } };
      }
      return { data: msg("queued", null) };
    });
    mount();

    await user.click(await screen.findByRole("combobox", { name: "Número de WhatsApp" }));
    await user.click(await screen.findByRole("option", { name: "Número 1" }));
    await user.type(screen.getByRole("textbox", { name: "Texto da mensagem" }), "Oi");
    await user.click(screen.getByRole("button", { name: "Confirmar envio" }));

    await waitFor(() => expect(toast.warning).toHaveBeenCalledWith("Mensagem na fila. Será enviada quando o número estiver disponível."));
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("failed mostra o erro e mantém o diálogo aberto para corrigir", async () => {
    const user = userEvent.setup({ delay: null });
    vi.mocked(apiClient.post).mockImplementation(async (path: string) => {
      if (path === "/api/v1/conversations/open-with-contact") {
        return { data: { conversation_id: "conversation", contact_id: "contact" } };
      }
      return { data: { ...msg("failed", null), error_code: "messaging_window_closed", error_message: "Janela de atendimento encerrada." } };
    });
    mount();

    await user.click(await screen.findByRole("combobox", { name: "Número de WhatsApp" }));
    await user.click(await screen.findByRole("option", { name: "Número 1" }));
    await user.type(screen.getByRole("textbox", { name: "Texto da mensagem" }), "Oi");
    await user.click(screen.getByRole("button", { name: "Confirmar envio" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Janela de atendimento encerrada."));
    expect(toast.success).not.toHaveBeenCalled();
    // Mantém aberto: o botão de confirmar segue presente.
    expect(screen.getByRole("button", { name: "Confirmar envio" })).toBeVisible();
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

  it("reconciliar a MESMA operação reusa a chave; mudar o texto gera chave nova", async () => {
    const user = userEvent.setup({ delay: null });
    vi.mocked(apiClient.post).mockImplementation(async (path: string) => {
      if (path === "/api/v1/conversations/open-with-contact") {
        return { data: { conversation_id: "conversation", contact_id: "contact" } };
      }
      return { data: { ...msg("failed", null), error_code: "messaging_window_closed", error_message: "Janela encerrada." } };
    });
    mount();

    await user.click(await screen.findByRole("combobox", { name: "Número de WhatsApp" }));
    await user.click(await screen.findByRole("option", { name: "Número 1" }));
    await user.type(screen.getByRole("textbox", { name: "Texto da mensagem" }), "Oi");
    await user.click(screen.getByRole("button", { name: "Confirmar envio" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());

    // Recupera a mesma operação (mesmo payload) → mesma chave.
    await user.click(screen.getByRole("button", { name: "Confirmar envio" }));
    await waitFor(() => expect(vi.mocked(apiClient.post).mock.calls.filter((c) => c[0] === "/api/v1/messages").length).toBe(2));
    const chaves = vi.mocked(apiClient.post).mock.calls
      .filter((c) => c[0] === "/api/v1/messages")
      .map((c) => (c[2] as { idempotencyKey?: string } | undefined)?.idempotencyKey);
    expect(chaves[0]).toBeTruthy();
    expect(chaves[0]).toBe(chaves[1]);

    // Muda o texto → operação nova → chave nova.
    await user.type(screen.getByRole("textbox", { name: "Texto da mensagem" }), " (editado)");
    await user.click(screen.getByRole("button", { name: "Confirmar envio" }));
    await waitFor(() => expect(vi.mocked(apiClient.post).mock.calls.filter((c) => c[0] === "/api/v1/messages").length).toBe(3));
    const chavesDepois = vi.mocked(apiClient.post).mock.calls
      .filter((c) => c[0] === "/api/v1/messages")
      .map((c) => (c[2] as { idempotencyKey?: string } | undefined)?.idempotencyKey);
    expect(chavesDepois[2]).not.toBe(chaves[0]);
  });
});
