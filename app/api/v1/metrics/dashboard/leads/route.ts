import { randomUUID } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { requireRole } from '@/lib/auth/require-role';
import { workspaceRequestGuard } from '@/lib/auth/workspace-request';
import { createClient } from '@/lib/supabase/server';
import { ok,fail } from '@/lib/api/wrappers';

export const dynamic='force-dynamic';
const querySchema=z.object({search:z.string().trim().max(80).default(''),pipeline_id:z.uuid().optional()}).strict();
export async function GET(req:NextRequest) {
  const requestId=randomUUID();
  const auth=await requireRole('agent',{requestId,resource:'dashboard_leads'});
  if(!auth.ok) return auth.response;
  const workspaceError=workspaceRequestGuard(req,auth.org.orgId,requestId);if(workspaceError)return workspaceError;
  const parsed=querySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if(!parsed.success) return fail('validation_failed','Busca inválida.',422,{requestId});
  const db=await createClient();
  let query=db.from('crm_leads').select('id,title,pipeline_id,status').eq('organization_id',auth.org.orgId).order('created_at',{ascending:false}).limit(50);
  if(parsed.data.pipeline_id) query=query.eq('pipeline_id',parsed.data.pipeline_id);
  if(parsed.data.search) query=query.ilike('title',`%${parsed.data.search.replace(/[\\%_]/g,'\\$&')}%`);
  const result=await query;
  if(result.error) return fail('internal_error','Não foi possível buscar os negócios.',500,{requestId});
  return ok(result.data??[],{requestId});
}
