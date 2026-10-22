// @vitest-environment node
import { beforeEach,describe,expect,it,vi } from 'vitest';
import { NextRequest } from 'next/server';
import { requireRole } from '@/lib/auth/require-role';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { fail } from '@/lib/api/wrappers';
import { GET,POST,PATCH } from '@/app/api/v1/leads/[id]/first-payment/route';
import type { AuthUser } from '@/lib/auth/types';
import { audit } from '@/lib/audit';
vi.mock('@/lib/auth/require-role',()=>({requireRole:vi.fn()}));
vi.mock('@/lib/supabase/server',()=>({createClient:vi.fn()}));
vi.mock('@/lib/supabase/admin',()=>({createAdminClient:vi.fn()}));
vi.mock('@/lib/audit',()=>({audit:vi.fn()}));
vi.mock('@/lib/logger',()=>({logger:{error:vi.fn()}}));
const ORG='10000000-0000-4000-8000-000000000001',LEAD='10000000-0000-4000-8000-000000000002';
const ACTOR='10000000-0000-4000-8000-000000000003',OTHER='20000000-0000-4000-8000-000000000001';
const user:AuthUser={id:ACTOR,email:'teste@example.invalid',full_name:'Teste',avatar_url:null,is_platform_admin:false,idioma:'pt-BR',organizations:[]};
const ctx={params:Promise.resolve({id:LEAD})};
const payment={amount_cents:25000,currency:'BRL',paid_at:'2026-01-01T12:00:00Z',quantity:2};
const rpc=vi.fn();
let leadResult:{data:{id:string}|null;error:null}={data:{id:LEAD},error:null};
const eq=vi.fn();
const db={from:vi.fn(()=>chain)};
const chain={select:vi.fn(()=>chain),eq:eq.mockImplementation(()=>chain),maybeSingle:vi.fn(async()=>leadResult)};
function request(body:unknown,workspace=ORG,method='POST') {
  return new NextRequest(`https://crm.example.invalid/api/v1/leads/${LEAD}/first-payment`,{
    method,headers:{'Content-Type':'application/json','X-Workspace-Id':workspace},body:JSON.stringify(body)});
}
beforeEach(()=>{
  vi.clearAllMocks();leadResult={data:{id:LEAD},error:null};
  vi.mocked(requireRole).mockResolvedValue({ok:true,user,org:{orgId:ORG,name:'Teste',role:'manager'}});
  vi.mocked(createClient).mockResolvedValue(db as never);
  vi.mocked(createAdminClient).mockReturnValue({rpc} as never);
  rpc.mockResolvedValue({data:{changed:true,payment:{...payment,id:ACTOR,lead_id:LEAD,history:['privado'],external_id:'privado'},funnel_closed:true},error:null});
});
describe('pagamentos: fronteira autenticada e proteção de concorrência',()=>{
  it('workspace divergente não acessa dados nem service role',async()=>{
    expect((await POST(request(payment,OTHER),ctx)).status).toBe(409);
    expect(createClient).not.toHaveBeenCalled();expect(createAdminClient).not.toHaveBeenCalled();
  });
  it('sem papel de gestor não escreve',async()=>{
    vi.mocked(requireRole).mockResolvedValue({ok:false,response:fail('forbidden','Sem permissão',403)});
    expect((await POST(request(payment),ctx)).status).toBe(403);expect(rpc).not.toHaveBeenCalled();
    expect(requireRole).toHaveBeenCalledWith('manager',expect.anything());
  });
  it('org/ator externos são recusados e o lead precisa estar visível por RLS',async()=>{
    expect((await POST(request({...payment,organization_id:OTHER}),ctx)).status).toBe(422);
    expect(rpc).not.toHaveBeenCalled();leadResult={data:null,error:null};
    expect((await POST(request(payment),ctx)).status).toBe(404);expect(rpc).not.toHaveBeenCalled();
  });
  it('usa org/ator da sessão, mantém 1 venda de 2 unidades e não expõe campos privados',async()=>{
    const response=await POST(request(payment),ctx);expect(response.status).toBe(200);
    expect(eq).toHaveBeenCalledWith('organization_id',ORG);
    expect(rpc).toHaveBeenCalledWith('fn_record_crm_first_payment',expect.objectContaining({p_org:ORG,p_lead:LEAD,p_actor:ACTOR,p_quantity:2,p_source:'manual'}));
    expect((await response.json()).data.payment).not.toHaveProperty('history');
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({organizationId:ORG,actorUserId:ACTOR,action:'dashboard.payment_confirmed'}));
  });
  it('correção exige versão e converte CAS vencido em conflito, sem auditoria de sucesso',async()=>{
    expect((await PATCH(request(payment),ctx)).status).toBe(422);
    rpc.mockResolvedValue({data:null,error:{code:'40001'}});
    expect((await PATCH(request({...payment,expected_updated_at:'2026-01-01T12:00:00Z'}),ctx)).status).toBe(409);
    expect(audit).not.toHaveBeenCalled();
  });
  it('leitura também exige workspace esperado',async()=>{
    const req=new NextRequest('https://crm.example.invalid/api/v1/leads/payment',{headers:{'X-Workspace-Id':OTHER}});
    expect((await GET(req,ctx)).status).toBe(409);expect(createClient).not.toHaveBeenCalled();
  });
});
