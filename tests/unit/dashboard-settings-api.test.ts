// @vitest-environment node
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {NextRequest} from 'next/server';
import {requireRole} from '@/lib/auth/require-role';
import {createClient} from '@/lib/supabase/server';
import {GET} from '@/app/api/v1/metrics/dashboard/settings/route';
import {FUSO_PADRAO} from '@/lib/tempo/fusos';
vi.mock('@/lib/auth/require-role',()=>({requireRole:vi.fn()}));
vi.mock('@/lib/supabase/server',()=>({createClient:vi.fn()}));
vi.mock('@/lib/supabase/admin',()=>({createAdminClient:vi.fn()}));
vi.mock('@/lib/audit',()=>({audit:vi.fn()}));
vi.mock('@/lib/logger',()=>({logger:{error:vi.fn()}}));
const ORG='10000000-0000-4000-8000-000000000001';
let timezone='America/Sao_Paulo',truncated=false;
const requested=vi.fn();
function chain(table:string):unknown {
  const result=table==='organizations'?{data:{timezone,settings:{}},error:null}:
    {data:[],count:truncated&&table==='crm_stages'?1001:0,error:null};
  const q={select:requested.mockImplementation(()=>q),eq:()=>q,order:()=>q,limit:()=>q,single:()=>Promise.resolve(result),
    then:(resolve:(v:unknown)=>unknown)=>Promise.resolve(result).then(resolve)};
  return q;
}
const request=()=>new NextRequest('https://crm.example.invalid/api/v1/metrics/dashboard/settings',{headers:{'X-Workspace-Id':ORG}});
beforeEach(()=>{
  vi.clearAllMocks();timezone='America/Sao_Paulo';truncated=false;
  vi.mocked(requireRole).mockResolvedValue({ok:true,user:{id:ORG},org:{orgId:ORG,role:'manager'}} as never);
  vi.mocked(createClient).mockResolvedValue({from:chain} as never);
});
describe('catálogos do dashboard são completos e as datas podem ser renderizadas',()=>{
  it('recusa catálogo truncado pelo teto do PostgREST, em vez de ocultar etapas',async()=>{
    truncated=true;expect((await GET(request())).status).toBe(422);
    expect(requested).toHaveBeenCalledWith('id,name,pipeline_id,is_archived,is_won,is_lost',{count:'exact'});
  });
  it('fuso inválido degrada para o padrão e não quebra o diálogo de campanhas',async()=>{
    timezone='America/invalid';const response=await GET(request());expect(response.status).toBe(200);
    expect((await response.json()).data.timezone).toBe(FUSO_PADRAO);
  });
  it('preserva o fuso válido e os catálogos completos',async()=>{
    timezone='UTC';const response=await GET(request());expect(response.status).toBe(200);
    expect((await response.json()).data.timezone).toBe('UTC');
  });
});
