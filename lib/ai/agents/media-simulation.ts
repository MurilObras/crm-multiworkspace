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
