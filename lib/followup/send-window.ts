import { z } from "zod";

import { instanteDe, partesNoFuso } from "@/lib/agenda/fuso";
import { fusoValido } from "@/lib/tempo/fusos";

/** Regra explícita do operador. Não interpretar horários escritos em prompts. */
export const sendWindowSchema = z
  .strictObject({
    timezone: z.string().max(100).refine(fusoValido, "Informe um fuso válido."),
    days: z
      .array(z.number().int().min(0).max(6))
      .min(1)
      .max(7)
      .refine((days) => new Set(days).size === days.length, "Não repita dias."),
    start_hour: z.number().int().min(0).max(23),
    end_hour: z.number().int().min(1).max(24),
  })
  .refine((v) => v.start_hour < v.end_hour, "O fim deve ser depois do início.");

export type SendWindow = z.infer<typeof sendWindowSchema>;

/** Primeiro instante permitido >= alvo. Fim exclusivo; domingo = 0. */
export function nextInSendWindow(target: Date, window: SendWindow): Date {
  const initial = partesNoFuso(target, window.timezone);
  for (let offset = 0; offset <= 8; offset++) {
    // Aritmética de data CIVIL: somar 24h ao instante erraria na troca de horário de verão.
    const civil = new Date(Date.UTC(initial.ano, initial.mes - 1, initial.dia + offset));
    if (!window.days.includes(civil.getUTCDay())) continue;
    const date = {
      ano: civil.getUTCFullYear(),
      mes: civil.getUTCMonth() + 1,
      dia: civil.getUTCDate(),
    };
    const start = instanteDe({ ...date, hora: window.start_hour }, window.timezone);
    const end = instanteDe({ ...date, hora: window.end_hour }, window.timezone);
    const candidate = new Date(Math.max(target.getTime(), start.getTime()));
    if (candidate < end) return candidate;
  }
  throw new Error("Não foi possível calcular a próxima janela de envio.");
}
