import type { Message } from "@/lib/types/messaging";
import { fraseDaFalhaDeCanal } from "@/lib/channels/frases-de-falha";

/**
 * O que dizer à pessoa depois de `POST /api/v1/messages` devolver a linha.
 *
 * A rota responde HTTP 201 mesmo quando a mensagem ficou `queued` (canal
 * desconectado/fora da janela) ou `failed` (recusada antes do transporte) —
 * então sucesso HTTP NÃO é confirmação de envio/entrega. Aqui o feedback deriva
 * do status real da linha, do `external_id` e do motivo.
 *
 * `variant` é o tom do toast. `state` é o ciclo de vida da OPERAÇÃO — e é ele,
 * não o tom, que decide se a identidade da operação é preservada (incerta) ou
 * encerrada (confirmada/falha).
 */

export type VarianteDeFeedback = "success" | "warning" | "error";

/** Ciclo de vida da operação de envio — separado da variante visual. */
export type EstadoDaOperacao = "confirmed" | "uncertain" | "failed" | "unknown";

export interface DesfechoDoEnvio {
  variant: VarianteDeFeedback;
  text: string;
  state: EstadoDaOperacao;
}

/**
 * Resposta incompleta/desconhecida NUNCA vira sucesso: sem linha, sem status
 * reconhecido, ou `sent` sem o id do provedor, o desfecho é "não confirmado".
 */
export function desfechoDoEnvio(
  message: Pick<Message, "status" | "external_id" | "error_code" | "error_message"> | null | undefined,
): DesfechoDoEnvio {
  if (!message) {
    return { variant: "error", text: "Não foi possível confirmar o envio. Confira a conversa.", state: "unknown" };
  }

  const { status, external_id, error_code, error_message } = message;

  if (status === "failed") {
    const text = fraseDaFalhaDeCanal(error_code) ?? error_message ?? "A mensagem falhou antes de sair.";
    return { variant: "error", text, state: "failed" };
  }

  if (status === "delivered") return { variant: "success", text: "Mensagem entregue.", state: "confirmed" };
  if (status === "read") return { variant: "success", text: "Mensagem lida.", state: "confirmed" };

  if (status === "sent") {
    return external_id
      ? { variant: "success", text: "Mensagem enviada.", state: "confirmed" }
      : { variant: "warning", text: "Mensagem enviada, aguardando confirmação do provedor.", state: "uncertain" };
  }

  if (status === "queued") {
    return { variant: "warning", text: "Mensagem na fila. Será enviada quando o número estiver disponível.", state: "uncertain" };
  }

  if (status === "sending") {
    return { variant: "warning", text: "Aguardando resposta do provedor.", state: "uncertain" };
  }

  return { variant: "error", text: "Não foi possível confirmar o envio. Confira a conversa.", state: "unknown" };
}
