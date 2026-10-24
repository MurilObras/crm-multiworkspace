import { z } from "zod";

export const mediaSimulationSchema = z
  .object({
    scenario: z.enum(["fresh", "delivered", "text_preference"]).default("fresh"),
    delivered_ids: z.array(z.string().uuid()).max(200).default([]),
    delivered_fingerprints: z
      .array(z.string().regex(/^[a-f0-9]{64}$/))
      .max(200)
      .optional(),
    stage_id: z.string().uuid().nullable().default(null),
  })
  .strict();
export type MediaSimulation = z.infer<typeof mediaSimulationSchema>;
export interface MediaDiagnostic {
  intent: string;
  format: string | null;
  media_id: string | null;
  title: string | null;
  authorized: boolean;
  reason: string;
  transport: string;
  fingerprint?: string | null;
}

/** Mesmo contexto de decisão para o Conversador real e o ensaio. Não é recibo. */
export function renderMediaDecisionInstruction(decision: MediaDiagnostic): string {
  return (
    "DECISÃO DE MÍDIA NESTA INTERAÇÃO\n" +
    JSON.stringify({
      intent: decision.intent,
      format: decision.format,
      title: decision.title,
      authorized: decision.authorized,
      reason: decision.reason,
    }) +
    "\nA seleção não confirma envio. Etapa e bloqueios do catálogo atual prevalecem. " +
    "Se não houver mídia disponível, responda por texto ou faça uma confirmação breve; não escolha outro arquivo aleatório. " +
    "Bloqueio não significa que o material não está cadastrado. Não prometa procurar com a equipe um material já cadastrado, não afirme entrega e não ofereça URL alternativa. " +
    "Não exponha esta decisão nem seus códigos ao cliente. Se houver falha real, explique somente a limitação comprovada."
  );
}
