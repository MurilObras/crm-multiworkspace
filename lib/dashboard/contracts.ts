import { z } from 'zod';
export type PaymentSource = 'manual' | 'integration';
export type AttributionMethod = 'referral' | 'tracking_link' | 'manual' | 'inbound';
export type CampaignLinkKind = 'whatsapp' | 'website';
export type CommercialEventKind = 'lead_registered' | 'first_payment_received';

export const dashboardQuerySchema = z.object({
  from: z.iso.date(),
  to: z.iso.date(),
  view: z.enum(['payments', 'acquisition']).default('acquisition'),
  pipeline_id: z.uuid().optional(),
  owner_user_id: z.uuid().optional(),
  owner_agent_id: z.uuid().optional(),
  source: z.string().trim().min(1).max(100).optional(),
  account_id: z.string().regex(/^act_\d+$/).optional(),
  campaign_id: z.string().regex(/^\d+$/).optional(),
}).strict().refine(q => q.from <= q.to, { message: 'Período inválido.' })
  .refine(q => Date.parse(q.to) - Date.parse(q.from) <= 365 * 86_400_000, { message: 'Selecione até 366 dias.' })
  .refine(q => !q.owner_user_id || !q.owner_agent_id, { message: 'Escolha um responsável por vez.' });
export type DashboardQuery = z.infer<typeof dashboardQuerySchema>;
export const pipelineDashboardSchema = z.object({
  qualified_stage_ids:z.array(z.uuid()).default([]),
  quantity_label:z.string().trim().min(1).max(50).default('Unidades vendidas'),
  qualification_started_at:z.iso.datetime({offset:true}).nullable().default(null),
});
export type PipelineDashboardSettings = z.infer<typeof pipelineDashboardSchema>;
export interface DashboardSettingsResponse {
  pipelines:Array<{id:string;name:string;is_archived:boolean;dashboard:PipelineDashboardSettings|null;config_error:boolean}>;
  stages:Array<{id:string;name:string;pipeline_id:string;is_archived:boolean;is_won:boolean;is_lost:boolean}>;
  campaigns:Array<{account_id:string;campaign_id:string;campaign_name:string;currency:string;account_timezone:string;enabled:boolean}>;
  agents:Array<{id:string;name:string}>;
  ad_sync_status:Array<{account_id:string;last_attempt_at:string|null;last_success_at:string|null;failed:boolean}>;
  timezone:string; confirmed_payment_conversions:boolean; conversions_configured:boolean;
}

export const firstPaymentSchema = z.object({
  amount_cents: z.number().int().positive().max(2_147_483_647),
  currency: z.string().regex(/^[A-Z]{3}$/).default('BRL'),
  paid_at: z.iso.datetime({ offset: true }),
  quantity: z.number().int().min(1).max(10_000).default(1),
  note: z.string().trim().max(1000).default(''),
}).strict().refine(p => Date.parse(p.paid_at) <= Date.now() + 300_000,
  { path: ['paid_at'], message: 'O pagamento não pode estar no futuro.' });

export const dashboardSettingsSchema = z.object({
  pipeline_id: z.uuid(),
  qualified_stage_ids: z.array(z.uuid()).max(100).refine(ids => new Set(ids).size === ids.length),
  quantity_label: z.string().trim().min(1).max(50).default('Unidades vendidas'),
  confirmed_payment_conversions: z.boolean().default(true),
}).strict();

export interface DashboardLead {
  id: string; title: string; created_at: string; pipeline_id: string; stage_id: string;
  status: string; value_cents: number | null; currency: string | null;
  owner_user_id: string | null; owner_agent_id: string | null;
  source: string; source_metadata: Record<string, unknown>;
}
export interface FirstPayment {
  lead_id: string; amount_cents: number; currency: string; paid_at: string;
  quantity: number; voided_at: string | null;
}
export interface LeadAttribution {
  lead_id: string; source: string; account_id: string | null; campaign_id: string | null;
  campaign_name: string | null; captured_at: string;
}
export interface DailySpend {
  account_id: string; campaign_id: string; campaign_name: string; day: string;
  currency: string; amount_cents: number; updated_at: string;
}
export interface SpendCoverage {
  account_id:string;campaign_id:string;campaign_name:string;currency:string;account_timezone:string;
  covered_days:number;oldest_sync_at:string|null;
}
export interface Qualification { lead_id: string; qualified_at: string }
export interface CampaignMetric {
  account_id: string | null; campaign_id: string | null; label: string; currency: string;
  spend_cents: number | null; leads: number; qualified: number; sales: number;
  quantity: number; revenue_cents: number; cpl_cents: number | null;
  cplq_cents: number | null; cost_per_sale_cents: number | null; roas: number | null;
  qualification_complete: boolean; currency_conflict: boolean;
  spend_complete:boolean;timezone_comparable:boolean;oldest_sync_at:string|null;
}
export interface PipelineMeasurement {
  id: string;
  dashboard_settings: { qualification_started_at?: string | null; qualified_stage_ids?: string[] } | null;
}
