import type { Message } from "@/lib/types/messaging";
import { fraseDaFalhaDeCanal } from "@/lib/channels/frases-de-falha";

/**
 * O que dizer à pessoa depois de `POST /api/v1/messages` devolver a linha.
 *
 * A rota responde HTTP 201 mesmo quando a mensagem ficou `queued` (canal
 * desconectado/fora da janela) ou `failed` (recusada antes do transporte) —
 * então sucesso HTTP NÃO é confirmação de envio/entrega. Aqui o feedback deriva
 * do status real da linha, do `external_id` e do motivo.
 */

export type VarianteDeFeedback = "success" | "warning" | "error";

export interface DesfechoDoEnvio {
  variant: VarianteDeFeedback;
  text: string;
}

/**
 * Resposta incompleta/desconhecida NUNCA vira sucesso: sem linha, sem status
 * reconhecido, ou `sent` sem o id do provedor, o desfecho é "não confirmado".
 */
export function desfechoDoEnvio(
  message: Pick<Message, "status" | "external_id" | "error_code" | "error_message"> | null | undefined,
): DesfechoDoEnvio {
  if (!message) {
    return { variant: "error", text: "Não foi possível confirmar o envio. Confira a conversa." };
  }

  const { status, external_id, error_code, error_message } = message;

  if (status === "failed") {
    const text = fraseDaFalhaDeCanal(error_code) ?? error_message ?? "A mensagem falhou antes de sair.";
    return { variant: "error", text };
  }

  if (status === "delivered") return { variant: "success", text: "Mensagem entregue." };
  if (status === "read") return { variant: "success", text: "Mensagem lida." };

  if (status === "sent") {
    return external_id
      ? { variant: "success", text: "Mensagem enviada." }
      : { variant: "warning", text: "Mensagem enviada, aguardando confirmação do provedor." };
  }

  if (status === "queued") {
    return { variant: "warning", text: "Mensagem na fila. Será enviada quando o número estiver disponível." };
  }

  if (status === "sending") {
    return { variant: "warning", text: "Aguardando resposta do provedor." };
  }

  return { variant: "error", text: "Não foi possível confirmar o envio. Confira a conversa." };
}
