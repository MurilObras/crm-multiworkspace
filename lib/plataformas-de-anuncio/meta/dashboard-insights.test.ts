import { afterEach,describe,expect,it,vi } from 'vitest';
import { lerContaDoDashboard,lerGastoDiario,lerIdentidadeDeAnuncio } from '@/lib/plataformas-de-anuncio/meta/insights';
afterEach(()=>vi.unstubAllGlobals());
describe('Meta: dados financeiros completos antes do cache',()=>{
  it('mantém centavos exatos e pede dias separados',async()=>{
    const transport=vi.fn().mockResolvedValue(new Response(JSON.stringify({data:[{campaign_id:'2',campaign_name:'Campanha',date_start:'2026-10-01',spend:'19.99',account_currency:'BRL'}]})));
    vi.stubGlobal('fetch',transport);
    const result=await lerGastoDiario('secret','act_1','2026-10-01','2026-10-02');
    expect(result).toMatchObject({ok:true,dados:[{amount_cents:1999}]});
    const url=new URL(transport.mock.calls[0]![0]);expect(url.searchParams.get('time_increment')).toBe('1');
    expect(url.searchParams.has('access_token')).toBe(false);
  });
  it('não envia o token à URL seguinte ou a outro host',async()=>{
    const transport=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({data:[],paging:{next:'https://evil.example/steal?access_token=secret'}})));
    vi.stubGlobal('fetch',transport);
    expect((await lerGastoDiario('secret','act_1','2026-10-01','2026-10-02')).ok).toBe(false);
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('retira token da paginação legítima, mantém autorização no header',async()=>{
    const transport=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({data:[],paging:{next:'https://graph.facebook.com/v22.0/act_1/insights?after=abc&access_token=secret'}})))
      .mockResolvedValueOnce(new Response(JSON.stringify({data:[]})));
    vi.stubGlobal('fetch',transport);
    expect((await lerGastoDiario('secret','act_1','2026-10-01','2026-10-02')).ok).toBe(true);
    expect(transport.mock.calls[1]![0]).not.toContain('access_token');
    expect(transport.mock.calls[1]![1]).toMatchObject({headers:{authorization:'Bearer secret'},redirect:'error'});
  });
  it('página falhada ou campo faltante nunca confirma gasto parcial',async()=>{
    const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify({data:[{campaign_id:'2',campaign_name:'Campanha',date_start:'2026-10-01',spend:'2.05'}]})));
    vi.stubGlobal('fetch',fetcher);expect((await lerGastoDiario('secret','act_1','2026-10-01','2026-10-02')).ok).toBe(false);
  });
  it('conta sem moeda/fuso não recebe BRL presumido',async()=>{
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({account_id:'1'}))));
    expect((await lerContaDoDashboard('secret','act_1')).ok).toBe(false);
  });
  it('consulta anúncio por ID e exige campanha, conta e conjunto verificados',async()=>{
    const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify({id:'3',account_id:'1',campaign_id:'2',adset_id:'4'})));
    vi.stubGlobal('fetch',fetcher);
    expect(await lerIdentidadeDeAnuncio('secret','3')).toMatchObject({ok:true,dados:{account_id:'act_1',campaign_id:'2',ad_id:'3',adset_id:'4'}});
    expect(new URL(fetcher.mock.calls[0]![0]).pathname).toBe('/v22.0/3');
  });
});
