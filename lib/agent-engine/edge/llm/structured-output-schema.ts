import { jsonSchema } from 'ai';
import { z } from 'zod';

/** Separa JSON enviado ao provedor da normalização do contrato interno/legado. */
export function structuredOutputSchema<T>(transport: z.ZodType, parse: (value: unknown) => T) {
  return jsonSchema<T>(z.toJSONSchema(transport) as Parameters<typeof jsonSchema>[0], {
    validate: async value => {
      try { return { success: true as const, value: parse(value) }; }
      catch (error) { return { success: false as const, error: error instanceof Error ? error : new Error('structured_output_invalid') }; }
    },
  });
}
