import { z } from "zod";

/** Configuração própria de cada workspace. Não é conteúdo recebido do cliente. */
export const responsibleSchema = z.object({
  name: z.string().trim().min(1).max(100),
  phone: z.string().trim().regex(/^\+[1-9]\d{7,14}$/, "Informe o número com + e código do país."),
  enabled: z.boolean().default(true),
}).strict();

export const consultationSettingsSchema = z.object({
  enabled: z.boolean(),
  recipient_ids: z.array(z.string().uuid()).max(20),
  conditions: z.string().trim().max(4000),
}).strict().refine(v => !v.enabled || v.recipient_ids.length > 0, {
  message: "Selecione pelo menos um responsável antes de ativar.", path: ["recipient_ids"],
});
export type ConsultationSettings = z.infer<typeof consultationSettingsSchema>;
export const DEFAULT_CONSULTATION: ConsultationSettings = { enabled: false, recipient_ids: [], conditions: "" };

export function consultationInstructions(settings: Pick<ConsultationSettings, "enabled" | "conditions">): string {
  if (!settings.enabled) return "";
  return [
    "## Consulta ao responsável pelo WhatsApp",
    "Quando faltar uma informação aprovada ou a situação abaixo exigir confirmação, use open_human_case antes de responder sobre ela.",
    "Preencha title, summary e blocker com a dúvida exata e o contexto necessário. Não invente uma resposta nem prometa prazo.",
    "Os detalhes internos ficam somente no chamado. Não descreva ferramentas, logs ou diagnósticos técnicos ao cliente.",
    "O sistema avisará o cliente e pausará esta conversa enquanto consulta os responsáveis. Depois de abrir o pedido, encerre o turno sem enviar outras mensagens.",
    "Se o cliente pedir para falar com uma pessoa, use request_human_handoff: isso é transferência de atendimento, não uma consulta temporária.",
    settings.conditions ? `Situações que exigem consulta: ${settings.conditions}` : "",
  ].filter(Boolean).join("\n");
}
