/**
 * Bloco de Integração Kiwify — o que ele envia e o que NUNCA reaparece.
 *
 * O segredo é write-only: entra no POST e não volta em lista, estado ou resposta.
 * A URL do webhook é montada da origem do navegador e oferecida para copiar.
 */
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
import { KiwifyIntegrationBlock } from "./KiwifyIntegrationBlock";

// Polyfills que o Radix Select exige e o jsdom não tem.
window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
window.HTMLElement.prototype.setPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();

const PIPELINE = { id: "11111111-1111-4111-8111-111111111111", name: "Funil A" };
const STAGE = { id: "22222222-2222-4222-8222-222222222222", name: "Etapa A" };
const PRODUCT = { id: "33333333-3333-4333-8333-333333333333", nome: "Produto interno", ativo: true };
const INTEGRATION = {
  id: "integration", name: "Minha integração", store_id: "store-1",
  path_token: "token-abc", pipeline_id: PIPELINE.id, stage_id: STAGE.id, is_active: true,
};

window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
window.HTMLElement.prototype.setPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();

function mockGet() {
  vi.mocked(apiClient.get).mockImplementation(async (path: string) => {
    if (path.includes("/board")) return { data: { stages: [STAGE] } };
    if (path === "/api/v1/pipelines") return { data: [PIPELINE] };
    if (path === "/api/v1/products") return { data: [PRODUCT] };
    if (path === "/api/v1/integrations/kiwify") return { data: { integrations: [], products: [] } };
    return { data: [] };
  });
}

function mount() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}>
      <KiwifyIntegrationBlock />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGet();
});

describe("KiwifyIntegrationBlock", () => {
  it("regra genérica nova permanece visível com motivo e instrução de compatibilidade", async () => {
    vi.mocked(apiClient.get).mockImplementation(async path => {
      if (path === "/api/v1/integrations/kiwify") return { data: { integrations: [INTEGRATION], products: [], links: [] } };
      if (path === "/api/v1/automation-rules") return { data: [{id:"generic-rule",name:"Boas-vindas geral",trigger_event:"lead.created",conditions:[],actions:[]}] };
      return { data: [] };
    });
    mount();
    await userEvent.setup().click(await screen.findByRole("button",{name:"Gerenciar automações"}));
    expect(await screen.findByText("Boas-vindas geral")).toBeVisible();
    expect(screen.getByText(/Regra genérica não vinculada/)).toHaveTextContent("event.kiwify_event_type = order_approved");
    expect(screen.queryByRole("button",{name:"Vincular",exact:true})).toBeNull();
    expect(apiClient.put).not.toHaveBeenCalled();
  });
  it("lista vazia convida a configurar, sem expor segredo", async () => {
    mount();
    expect(await screen.findByText("Nenhuma integração Kiwify configurada ainda.")).toBeVisible();
    expect(screen.queryByText(/secret/i)).toBeNull();
  });

  it("cria integração via POST com mapeamento de produto e mostra URL para copiar", async () => {
    const user = userEvent.setup({ delay: null });
    vi.mocked(apiClient.post).mockResolvedValue({
      data: { integration_id: "integration", endpoint: "/api/v1/webhooks/kiwify/token-abc" },
    });
    mount();
    await screen.findByText("Nenhuma integração Kiwify configurada ainda.");

    await user.click(screen.getByRole("button", { name: "Nova integração" }));
    await user.type(screen.getByLabelText("Nome"), "Minha integração");
    await user.type(screen.getByLabelText("Store ID"), "store-1");
    await user.type(screen.getByLabelText("Secret / token da Kiwify"), "secret-super-secreto");

    await user.click(screen.getByRole("combobox", { name: "Funil" }));
    await user.click(await screen.findByRole("option", { name: "Funil A" }));

    await user.click(screen.getByRole("combobox", { name: "Etapa" }));
    await user.click(await screen.findByRole("option", { name: "Etapa A" }));

    await user.type(screen.getByPlaceholderText("external_product_id"), "product-test");
    await user.click(screen.getByRole("combobox", { name: "Produto interno" }));
    await user.click(await screen.findByRole("option", { name: "Produto interno" }));

    await user.click(screen.getByRole("button", { name: "Salvar integração" }));

    await waitFor(() => expect(apiClient.post).toHaveBeenCalledTimes(1));
    const [rota, corpo] = vi.mocked(apiClient.post).mock.calls[0]!;
    expect(rota).toBe("/api/v1/integrations/kiwify");
    expect(corpo).toEqual({
      name: "Minha integração",
      store_id: "store-1",
      secret: "secret-super-secreto",
      pipeline_id: PIPELINE.id,
      stage_id: STAGE.id,
      products: [{ external_product_id: "product-test", product_id: PRODUCT.id }],
    });

    // Depois de salvar: URL completa visível + botão de copiar.
    const urlInput = await screen.findByLabelText("URL do webhook");
    const urlValue = (urlInput as HTMLInputElement).value;
    expect(urlValue).toContain("/api/v1/webhooks/kiwify/token-abc");
    await user.click(screen.getByRole("button", { name: "Copiar URL do webhook" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("URL copiada."));
    // O segredo não reaparece em lugar nenhum do DOM depois de salvar.
    expect(document.body.textContent).not.toContain("secret-super-secreto");
  });

  it("clipboard.writeText recebe a URL exata", async () => {
    const user = userEvent.setup({ delay: null });
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    vi.mocked(apiClient.get).mockImplementation(async (path: string) => {
      if (path === "/api/v1/integrations/kiwify") return { data: { integrations: [INTEGRATION], products: [] } };
      return { data: [] };
    });
    mount();
    await screen.findByText("Minha integração");
    await user.click(screen.getByRole("button", { name: "Copiar URL do webhook" }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(writeText.mock.calls[0]![0]).toBe(`${window.location.origin}/api/v1/webhooks/kiwify/token-abc`);
  });

  it("falha de cópia não mostra sucesso", async () => {
    const user = userEvent.setup({ delay: null });
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("denied"));
    vi.mocked(apiClient.get).mockImplementation(async (path: string) => {
      if (path === "/api/v1/integrations/kiwify") return { data: { integrations: [INTEGRATION], products: [] } };
      return { data: [] };
    });
    mount();
    await screen.findByText("Minha integração");
    await user.click(screen.getByRole("button", { name: "Copiar URL do webhook" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("não submete sem funil/etapa/produto — segredo fica fora do corpo", async () => {
    const user = userEvent.setup({ delay: null });
    mount();
    await screen.findByText("Nenhuma integração Kiwify configurada ainda.");
    await user.click(screen.getByRole("button", { name: "Nova integração" }));
    await user.type(screen.getByLabelText("Nome"), "X");
    await user.type(screen.getByLabelText("Store ID"), "s");
    await user.type(screen.getByLabelText("Secret / token da Kiwify"), "segredo");
    await user.click(screen.getByRole("button", { name: "Salvar integração" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(apiClient.post).not.toHaveBeenCalled();
  });
});
