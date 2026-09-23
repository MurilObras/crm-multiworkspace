import { describe, expect, it } from "vitest";
import { desfechoDoEnvio } from "./desfecho-do-envio";

const base = {
  status: "sent",
  external_id: "wamid-1",
  error_code: null,
  error_message: null,
};

describe("desfechoDoEnvio", () => {
  it("sent com external_id é sucesso (confirmed)", () => {
    expect(desfechoDoEnvio(base)).toEqual({ variant: "success", text: "Mensagem enviada.", state: "confirmed" });
  });

  it("queued é aviso INCERTO, nunca sucesso/confirmado", () => {
    expect(desfechoDoEnvio({ ...base, status: "queued", external_id: null })).toEqual({
      variant: "warning",
      text: "Mensagem na fila. Será enviada quando o número estiver disponível.",
      state: "uncertain",
    });
  });

  it("sending é incerto", () => {
    expect(desfechoDoEnvio({ ...base, status: "sending", external_id: null })).toEqual({
      variant: "warning",
      text: "Aguardando resposta do provedor.",
      state: "uncertain",
    });
  });

  it("failed usa o motivo do canal/erro (estado failed)", () => {
    expect(
      desfechoDoEnvio({ ...base, status: "failed", external_id: null, error_code: "channel_session_not_working" }),
    ).toEqual({ variant: "error", text: expect.stringContaining("não está conectado"), state: "failed" });
    // Código sem frase traduzida cai no error_message, e sem ele no fallback.
    expect(
      desfechoDoEnvio({ ...base, status: "failed", external_id: null, error_code: "messaging_window_closed", error_message: "Janela de atendimento encerrada." }),
    ).toEqual({ variant: "error", text: "Janela de atendimento encerrada.", state: "failed" });
    expect(
      desfechoDoEnvio({ ...base, status: "failed", external_id: null, error_code: null, error_message: null }),
    ).toEqual({ variant: "error", text: "A mensagem falhou antes de sair.", state: "failed" });
  });

  it("sent sem external_id é incerto, não confirmado", () => {
    expect(desfechoDoEnvio({ ...base, external_id: null })).toEqual({
      variant: "warning",
      text: "Mensagem enviada, aguardando confirmação do provedor.",
      state: "uncertain",
    });
  });

  it("resposta incompleta/desconhecida nunca vira sucesso", () => {
    expect(desfechoDoEnvio(null)).toEqual({
      variant: "error",
      text: "Não foi possível confirmar o envio. Confira a conversa.",
      state: "unknown",
    });
    expect(desfechoDoEnvio(undefined)).toMatchObject({ variant: "error", state: "unknown" });
    expect(desfechoDoEnvio({ ...base, status: "weird" })).toMatchObject({ variant: "error", state: "unknown" });
  });
});
