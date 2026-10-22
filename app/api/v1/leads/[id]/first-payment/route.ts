import { randomUUID } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { requireRole } from '@/lib/auth/require-role';
import { workspaceRequestGuard } from '@/lib/auth/workspace-request';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { ok, fail } from '@/lib/api/wrappers';
import { firstPaymentSchema } from '@/lib/dashboard/contracts';
import { audit } from '@/lib/audit';
import { logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ id: string }> };
const correctionSchema = firstPaymentSchema.safeExtend({ expected_updated_at:z.iso.datetime({ offset:true }) });
const voidSchema = z.object({ reason:z.string().trim().min(3).max(1000), expected_updated_at:z.iso.datetime({ offset:true }) }).strict();
const projection = 'id,lead_id,amount_cents,currency,paid_at,quantity,source,note,voided_at,updated_at';

export async function GET(req:NextRequest, ctx:Context) {
  const requestId = randomUUID();
  const auth = await requireRole('agent',{ requestId,resource:'first_payment' });
  if (!auth.ok) return auth.response;
  const workspaceError=workspaceRequestGuard(req,auth.org.orgId,requestId);if(workspaceError)return workspaceError;
  const {id} = await ctx.params;
  if (!z.uuid().safeParse(id).success) return fail('validation_failed','Negócio inválido.',422,{requestId});
  const db = await createClient();
  const lead = await db.from('crm_leads').select('id').eq('organization_id',auth.org.orgId).eq('id',id).maybeSingle();
  if (lead.error) return fail('internal_error','Não foi possível consultar o negócio.',500,{requestId});
  if (!lead.data) return fail('not_found','Negócio não encontrado.',404,{requestId});
  const payment = await db.from('crm_first_payments').select(projection).eq('organization_id',auth.org.orgId).eq('lead_id',id).maybeSingle();
  if (payment.error) return fail('internal_error','Não foi possível consultar o pagamento.',500,{requestId});
  return ok(payment.data,{requestId});
}

async function write(req:NextRequest,ctx:Context, mode:'create'|'correct'|'void') {
  const requestId = randomUUID();
  const auth = await requireRole('manager',{requestId,resource:'first_payment'});
  if (!auth.ok) return auth.response;
  const workspaceError=workspaceRequestGuard(req,auth.org.orgId,requestId);if(workspaceError)return workspaceError;
  const {id} = await ctx.params;
  if (!z.uuid().safeParse(id).success) return fail('validation_failed','Negócio inválido.',422,{requestId});
  let raw:unknown;
  try { raw = await req.json(); } catch { return fail('validation_failed','JSON inválido.',422,{requestId}); }
  const body = (mode==='void' ? voidSchema : mode==='correct' ? correctionSchema : firstPaymentSchema).safeParse(raw);
  if (!body.success) return fail('validation_failed','Confira os dados do pagamento.',422,{requestId});
  const userDb = await createClient();
  const lead = await userDb.from('crm_leads').select('id').eq('organization_id',auth.org.orgId).eq('id',id).maybeSingle();
  if (lead.error) return fail('internal_error','Não foi possível consultar o negócio.',500,{requestId});
  if (!lead.data) return fail('not_found','Negócio não encontrado.',404,{requestId});
  const admin = createAdminClient();
  const p = body.data;
  const result = 'reason' in p ? await admin.rpc('fn_void_crm_first_payment',{
    p_org:auth.org.orgId,p_lead:id,p_actor:auth.user.id,p_reason:p.reason,p_expected_at:p.expected_updated_at,
  }) : await admin.rpc('fn_record_crm_first_payment',{
    p_org:auth.org.orgId,p_lead:id,p_amount:p.amount_cents,p_currency:p.currency,p_paid_at:p.paid_at,p_quantity:p.quantity,
    p_source:'manual',p_external_id:null,p_actor:auth.user.id,p_note:p.note,
    p_expected_at:'expected_updated_at' in p ? p.expected_updated_at : null,
  });
  if (result.error) {
    if (result.error.code==='40001' || result.error.code==='23505')
      return fail('state_conflict','O pagamento já foi registrado ou mudou. Atualize antes de corrigir.',409,{requestId});
    if (result.error.code==='P0002') return fail('not_found','Registro não encontrado.',404,{requestId});
    if (result.error.code==='22023') return fail('validation_failed','Confira os dados do pagamento.',422,{requestId});
    logger.error('[dashboard] payment failed',{requestId,code:result.error.code});
    return fail('internal_error','Não foi possível registrar o pagamento.',500,{requestId});
  }
  const data = result.data as {changed:boolean;payment:Record<string,unknown>;funnel_closed?:boolean};
  if (data.changed) await audit({ action:mode==='void'?'dashboard.payment_voided':mode==='correct'?'dashboard.payment_corrected':'dashboard.payment_confirmed',
    actorUserId:auth.user.id,organizationId:auth.org.orgId,resourceType:'crm_lead',resourceId:id,requestId,
    metadata:{payment_id:data.payment.id,source:'manual'},bypassedRls:true });
  return ok({changed:data.changed,funnel_closed:data.funnel_closed,payment:Object.fromEntries(projection.split(',').map(k=>[k,data.payment[k]]))},{requestId});
}
export const POST = (req:NextRequest,ctx:Context) => write(req,ctx,'create');
export const PATCH = (req:NextRequest,ctx:Context) => write(req,ctx,'correct');
export const DELETE = (req:NextRequest,ctx:Context) => write(req,ctx,'void');
