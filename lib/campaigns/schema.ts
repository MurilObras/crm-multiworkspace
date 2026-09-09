import { z } from "zod";

export const campaignFiltersSchema = z.object({
  tag: z.string().trim().min(1).max(100),
  source: z.string().trim().min(1).max(100).optional(),
}).strict();

export const campaignStepSchema = z.object({
  message: z.string().min(1).max(4096).refine((s) => s.trim().length > 0),
  delay_minutes: z.number().int().min(0).max(43200),
}).strict();

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

export interface CampaignStep {
  message: string;
  delay_minutes: number;
}

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
