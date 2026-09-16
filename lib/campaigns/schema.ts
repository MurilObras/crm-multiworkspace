import { z } from "zod";

export const campaignFiltersSchema = z.object({
  tag: z.string().trim().min(1).max(100),
  source: z.string().trim().min(1).max(100).optional(),
}).strict();

const textStepSchema = z.object({
  message: z.string().min(1).max(4096).refine((s) => s.trim().length > 0),
  delay_minutes: z.number().int().min(0).max(43200),
}).strict();

const templateStepSchema = z.object({
  type: z.literal("template"),
  template_id: z.uuid(),
  language: z.string().trim().min(1).max(35),
  values: z.record(z.string(), z.string()).default({}),
  delay_minutes: z.number().int().min(0).max(43200),
  // Snapshot renderizado pelo servidor: mantém o contrato JSON das RPCs 0218/0219
  // e a leitura do histórico atual. Nunca é o payload do transporte oficial.
  message: z.string().min(1).max(4096).optional(),
}).strict();
export const campaignStepSchema = z.union([textStepSchema, templateStepSchema]);

export const campaignCreateSchema = z.object({
  id: z.uuid(),
  name: z.string().trim().min(1).max(120),
  channel_session_id: z.uuid(),
  steps: z.array(campaignStepSchema).min(1).max(20),
  filters: campaignFiltersSchema.optional(),
  audience: z.array(z.object({ phone_number: z.string().regex(/^\+\d{8,15}$/), name: z.string().trim().max(200).optional() }).strict()).min(1).max(500).optional(),
  scheduled_at: z.iso.datetime({ offset: true }).optional(),
  hourly_limit: z.number().int().min(1).max(10000),
}).strict().refine((p) => Boolean(p.filters) !== Boolean(p.audience), { message: "Escolha um publico." });

export const recipientStatuses = ["pending", "sent", "failed", "skipped_opt_out", "stopped_reply"] as const;
export type RecipientStatus = typeof recipientStatuses[number];

export type CampaignStep = z.infer<typeof campaignStepSchema>;

export interface Campaign {
  id: string;
  name: string;
  channel_session_id: string;
  steps: CampaignStep[];
  filters: z.infer<typeof campaignFiltersSchema> | { mode: "list" };
  hourly_limit: number;
  status: "scheduled" | "running" | "completed";
  scheduled_at?: string | null;
  created_by: string | null;
  created_at: string;
  started_at: string;
}
