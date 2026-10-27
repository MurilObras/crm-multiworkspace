import { z } from 'zod';
import { declaracaoDoTurnoSchema } from './declaracao';
import { structuredOutputSchema } from '../edge/llm/structured-output-schema';

/** Contrato persistido: ausente significa não avaliado, nunca avaliação positiva. */
export const checkpointContentSchema = z.object({
  commitments: z.array(z.string()).default([]),
  objections: z.array(z.string()).default([]),
  next_action: z.string().nullable().default(null),
  rolling_summary: z.string().default(''),
  declaracao: declaracaoDoTurnoSchema.optional(),
});
export type CheckpointContent = z.infer<typeof checkpointContentSchema>;

/** DTO do provedor: obrigatório e fechado em TODOS os níveis, inclusive listas. */
export const checkpointTransportSchema = z.object({
  commitments: z.array(z.string()),
  objections: z.array(z.string()),
  next_action: z.string().nullable(),
  rolling_summary: z.string(),
  declaracao: z.object({
    intencoes: z.array(z.object({ o_que: z.string().min(1), evidencia: z.string().min(1) }).strict()),
    promessas: z.array(z.object({ o_que: z.string().min(1), prazo: z.string().nullable() }).strict()),
    nada_a_declarar: z.boolean(),
  }).strict().nullable(),
}).strict();

export function parseCheckpoint(value: unknown): CheckpointContent {
  // Memórias antigas/provedores compatíveis podem omitir a declaração. null no
  // transporte tem esse significado; jamais inserir nada_a_declarar.
  if (value && typeof value === 'object' && 'declaracao' in value && value.declaracao === null) {
    return checkpointContentSchema.parse({ ...value, declaracao: undefined });
  }
  return checkpointContentSchema.parse(value);
}

export const checkpointOutputSchema = structuredOutputSchema(checkpointTransportSchema, parseCheckpoint);
