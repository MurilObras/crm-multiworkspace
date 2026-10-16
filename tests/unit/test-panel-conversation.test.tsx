import type { ComponentProps } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { beforeEach, expect, it, vi } from "vitest";
import { TestPanel } from "@/app/app/ai/agents/[id]/_components/TestPanel";
import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/api/client", () => ({ apiClient: { post: vi.fn() } }));
const props = {
  agent: { id: "agent-1" },
  draft: null,
  published: {
    id: "v1",
    status: "published",
    version_number: 1,
    provider: "openai",
    model: "modelo",
  },
} as ComponentProps<typeof TestPanel>;

beforeEach(() => vi.clearAllMocks());

it("mostra a falha no resultado e não repete automaticamente um ensaio cobrado", async () => {
  vi.mocked(apiClient.post).mockRejectedValue(
    new ApiError(
      500,
      "agent_test_result_persist_failed",
      undefined,
      "req-1",
      "Não foi possível salvar o resultado.",
    ),
  );
  render(<TestPanel {...props} />);
  fireEvent.change(screen.getByLabelText("Mensagem do cliente (sample)"), {
    target: { value: "Quanto custa?" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Executar teste" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Não foi possível salvar o resultado.",
  );
  expect(screen.queryByText("Nenhum teste executado ainda.")).not.toBeInTheDocument();
  expect(apiClient.post).toHaveBeenCalledWith(expect.any(String), expect.anything(), {
    timeoutMs: 120_000,
    maxAttempts: 1,
  });
  fireEvent.click(screen.getByRole("button", { name: "Nova conversa de teste" }));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("preserva a mensagem do cliente e respostas parciais quando o turno é abortado", async () => {
  vi.mocked(apiClient.post).mockResolvedValue({
    data: {
      status: "aborted",
      messages: ["Parte aprovada"],
      runtime: "conversation_engine",
    },
  });
  render(<TestPanel {...props} />);
  fireEvent.change(screen.getByLabelText("Mensagem do cliente (sample)"), {
    target: { value: "Meu pedido" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Executar teste" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Nova conversa de teste" })).toBeEnabled(),
  );
  expect(screen.getByTestId("test-conversation-history")).toHaveTextContent("Meu pedido");
  expect(screen.getByTestId("test-conversation-history")).toHaveTextContent("Parte aprovada");
  expect(screen.getByText(/O turno não foi concluído/)).toBeVisible();
});

it("continua o histórico simulado e Nova conversa elimina contexto anterior", async () => {
  vi.mocked(apiClient.post).mockResolvedValue({
    data: {
      run_id: "run",
      runtime: "conversation_engine",
      status: "completed",
      messages: ["Uso individual?", "Ou tem equipe?"],
      final_text: "Uso individual?\n\nOu tem equipe?",
    },
  });
  render(<TestPanel {...props} />);
  fireEvent.change(screen.getByLabelText("Mensagem do cliente (sample)"), {
    target: { value: "Quero organizar obras" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Executar teste" }));
  await waitFor(() => expect(screen.getByTestId("test-message-bubbles")).toBeVisible());
  expect(screen.getByTestId("test-message-bubbles").querySelectorAll("p")).toHaveLength(2);
  fireEvent.change(screen.getByLabelText("Mensagem do cliente (sample)"), {
    target: { value: "Tenho equipe" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Executar teste" }));
  await waitFor(() => expect(apiClient.post).toHaveBeenCalledTimes(2));
  expect(vi.mocked(apiClient.post).mock.calls[1]![1]).toMatchObject({
    sample_message: "Tenho equipe",
    sample_history: [
      { direction: "inbound", body: "Quero organizar obras" },
      { direction: "outbound", body: "Uso individual?" },
      { direction: "outbound", body: "Ou tem equipe?" },
    ],
  });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Nova conversa de teste" })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Nova conversa de teste" }));
  expect(screen.getByTestId("test-conversation-history")).not.toHaveTextContent(
    "Quero organizar obras",
  );
});

it("troca de versão remonta o teste sem reutilizar conversa/resultados", async () => {
  vi.mocked(apiClient.post).mockResolvedValue({
    data: { status: "completed", messages: ["Resposta anterior"], runtime: "conversation_engine" },
  });
  const view = render(<TestPanel {...props} />);
  fireEvent.change(screen.getByLabelText("Mensagem do cliente (sample)"), {
    target: { value: "Dado da versão antiga" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Executar teste" }));
  await waitFor(() => expect(screen.getByTestId("test-message-bubbles")).toBeVisible());
  view.rerender(
    <TestPanel
      {...props}
      published={{ id: "v2", version_number: 2, status: "published" } as never}
    />,
  );
  expect(screen.getByLabelText("Mensagem do cliente (sample)")).toHaveValue("");
  expect(screen.getByTestId("test-conversation-history")).not.toHaveTextContent(
    "Dado da versão antiga",
  );
  expect(screen.queryByTestId("test-message-bubbles")).not.toBeInTheDocument();
});
