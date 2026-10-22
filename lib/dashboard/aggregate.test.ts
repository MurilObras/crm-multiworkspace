import { describe,expect,it } from 'vitest';
import { aggregateDashboard } from './aggregate';
import { dashboardPeriod } from './period';
import { dashboardQuerySchema,firstPaymentSchema,type DashboardLead } from './contracts';
const base:DashboardLead={id:'lead',title:'Negócio',created_at:'2026-10-01T12:00:00Z',pipeline_id:'p',stage_id:'s',status:'open',
  value_cents:15000,currency:'BRL',owner_user_id:null,owner_agent_id:null,source:'whatsapp',source_metadata:{}};
const options=()=>({query:dashboardQuerySchema.parse({from:'2026-10-01',to:'2026-10-02'}),
  window:dashboardPeriod('2026-10-01','2026-10-02','America/Sao_Paulo'),now:'2026-10-22T12:00:00Z',
  marketingVisible:true,leads:[base],payments:[],qualifications:[],attributions:[],spend:[],coverage:[],pipeline_measurements:[]});
type Options=Parameters<typeof aggregateDashboard>[0];
const paid={lead_id:'lead',amount_cents:25000,currency:'BRL',paid_at:'2026-10-10T12:00:00Z',quantity:2,voided_at:null};
const attribution={lead_id:'lead',source:'meta_ads',account_id:'act_1',campaign_id:'2',campaign_name:'Campanha',captured_at:base.created_at};
const coverage={account_id:'act_1',campaign_id:'2',campaign_name:'Campanha',currency:'BRL',account_timezone:'America/Sao_Paulo',covered_days:2,oldest_sync_at:'2026-10-22T00:00:00Z'};
describe('dashboard comercial',()=>{
  it('separa retorno da coorte e recebimentos por data; 2 unidades são 1 venda',()=>{
    const o:Options={...options(),payments:[paid]};
    const cohort=aggregateDashboard(o);expect(cohort).toMatchObject({sales:1,quantity:2});
    expect(cohort.money[0]).toMatchObject({revenue_cents:25000,pipeline_cents:0});
    expect(aggregateDashboard({...o,query:{...o.query,view:'payments'}})).toMatchObject({sales:0,quantity:0});
  });
  it('won sem recebimento não é venda e pagamento invalidado não conta',()=>{
    expect(aggregateDashboard({...options(),leads:[{...base,status:'won'}]})).toMatchObject({sales:0,won_without_payment:1});
    expect(aggregateDashboard({...options(),payments:[{...paid,voided_at:'2026-10-11T00:00:00Z'}]})).toMatchObject({sales:0});
  });
  it('consulta completa sem veiculação é zero; consulta ausente ou parcial é desconhecida',()=>{
    const o:Options={...options(),attributions:[attribution],coverage:[coverage]};
    expect(aggregateDashboard(o).campaigns[0]).toMatchObject({spend_cents:0,cpl_cents:0});
    expect(aggregateDashboard({...o,coverage:[{...coverage,covered_days:1}]}).campaigns[0]).toMatchObject({spend_cents:null,cpl_cents:null});
    expect(aggregateDashboard({...o,coverage:[]}).spend_incomplete).toBe(true);
  });
  it('não divide todo o gasto por subconjunto de vendedor, funil ou origem',()=>{
    const o:Options={...options(),attributions:[attribution],coverage:[coverage],query:{...options().query,pipeline_id:'p'}};
    expect(aggregateDashboard(o).campaigns[0]).toMatchObject({spend_cents:null,cpl_cents:null});
  });
  it('reconhece aliases do mesmo fuso e recusa soma que perde centavos exatos',()=>{
    const o:Options={...options(),attributions:[attribution],coverage:[{...coverage,account_timezone:'Brazil/East'}]};
    expect(aggregateDashboard(o).timezone_mismatch).toBe(false);
    const spend={account_id:'act_1',campaign_id:'2',campaign_name:'Campanha',day:'2026-10-01',currency:'BRL',amount_cents:Number.MAX_SAFE_INTEGER,updated_at:coverage.oldest_sync_at};
    expect(()=>aggregateDashboard({...o,spend:[spend,{...spend,day:'2026-10-02',amount_cents:1}]})).toThrow('dashboard_amount_out_of_range');
  });
  it('não compara dias de fusos diferentes nem mistura moedas',()=>{
    const o:Options={...options(),attributions:[attribution],coverage:[{...coverage,account_timezone:'UTC'}]};
    expect(aggregateDashboard(o)).toMatchObject({timezone_mismatch:true});
    expect(aggregateDashboard(o).campaigns[0]?.cpl_cents).toBeNull();
    const currencies=aggregateDashboard({...o,payments:[{...paid,currency:'USD'}]});
    expect(currencies.campaigns).toHaveLength(2);expect(currencies.campaigns.every(c=>c.currency_conflict&&c.roas===null)).toBe(true);
  });
  it('não apresenta CPL qualificado se a medição começou depois da captação',()=>{
    const o:Options={...options(),attributions:[attribution],coverage:[coverage],
      pipeline_measurements:[{id:'p',dashboard_settings:{qualification_started_at:'2026-10-02T12:00:00Z',qualified_stage_ids:['s']}}]};
    expect(aggregateDashboard(o)).toMatchObject({qualification_incomplete:true});
    expect(aggregateDashboard(o).campaigns[0]?.cplq_cents).toBeNull();
  });
  it('não transforma ausência de moeda ou valor em negociação zero completa',()=>{
    expect(aggregateDashboard({...options(),leads:[{...base,currency:null}]}).pipeline_without_value).toBe(1);
  });
});
describe('datas e entrada de pagamento',()=>{
  it('usa dia local de 23h/25h, inclusive meia-noite histórica ausente no Brasil',()=>{
    const spring=dashboardPeriod('2026-03-08','2026-03-08','America/New_York');
    expect(Date.parse(spring.to)-Date.parse(spring.from)).toBe(23*3_600_000);
    const autumn=dashboardPeriod('2026-11-01','2026-11-01','America/New_York');
    expect(Date.parse(autumn.to)-Date.parse(autumn.from)).toBe(25*3_600_000);
    expect(dashboardPeriod('2018-11-04','2018-11-04','America/Sao_Paulo').from).toBe('2018-11-04T03:00:00.000Z');
  });
  it('recusa dia inexistente e período de 367 dias inclusivos',()=>{
    expect(()=>dashboardPeriod('2011-12-30','2011-12-30','Pacific/Apia')).toThrow();
    expect(dashboardQuerySchema.safeParse({from:'2026-01-01',to:'2027-01-02'}).success).toBe(false);
    expect(dashboardQuerySchema.safeParse({from:'2026-02-30',to:'2026-03-01'}).success).toBe(false);
  });
  it('não aceita valor fracionário em centavos, zero ou data futura',()=>{
    const p={amount_cents:100,currency:'BRL',paid_at:'2025-01-01T00:00:00Z'};
    expect(firstPaymentSchema.safeParse(p).success).toBe(true);
    for(const patch of [{amount_cents:0},{amount_cents:1.2},{paid_at:'2099-01-01T00:00:00Z'}])
      expect(firstPaymentSchema.safeParse({...p,...patch}).success).toBe(false);
  });
});
