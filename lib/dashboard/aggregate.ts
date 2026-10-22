import type { CampaignMetric, DashboardLead, DashboardQuery, DailySpend, FirstPayment, LeadAttribution, Qualification, PipelineMeasurement,SpendCoverage } from './contracts';

/** Denominador ausente nunca vira custo ou retorno zero. */
const divide = (a: number | null, b: number): number | null => a === null || b <= 0 ? null : a / b;
const inside = (value: string, window: { from: string; to: string }) => Date.parse(value) >= Date.parse(window.from) && Date.parse(value) < Date.parse(window.to);
const keyOf = (account: string | null, campaign: string | null, currency: string) => JSON.stringify([account, campaign, currency]);
/** Valores acima do inteiro exato não podem produzir indicadores silenciosamente arredondados. */
const addCents = (a: number, b: number): number => {
  const sum = a + b;
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || !Number.isSafeInteger(sum))
    throw new RangeError('dashboard_amount_out_of_range');
  return sum;
};
const sameTimezone = (a: string, b: string) => {
  try { return new Intl.DateTimeFormat('en',{timeZone:a}).resolvedOptions().timeZone
    === new Intl.DateTimeFormat('en',{timeZone:b}).resolvedOptions().timeZone; }
  catch { return false; }
};

export function aggregateDashboard(input: {
  query: DashboardQuery; leads: DashboardLead[]; payments: FirstPayment[];
  attributions: LeadAttribution[]; qualifications: Qualification[]; spend: DailySpend[];
  now: string; marketingVisible: boolean;
  window: { from: string; to: string; timezone: string };
  pipeline_measurements: PipelineMeasurement[];
  coverage:SpendCoverage[];
}) {
  const { query: q } = input;
  const attributions = new Map(input.attributions.map(a => [a.lead_id, a]));
  const payments = new Map(input.payments.filter(p => !p.voided_at && Date.parse(p.paid_at) <= Date.parse(input.now)).map(p => [p.lead_id, p]));
  const qualifications = new Set(input.qualifications.filter(p => Date.parse(p.qualified_at) <= Date.parse(input.now)).map(p => p.lead_id));
  const filtered = input.leads.filter(l => {
    const a = attributions.get(l.id);
    return (!q.pipeline_id || l.pipeline_id === q.pipeline_id)
      && (!q.owner_user_id || l.owner_user_id === q.owner_user_id)
      && (!q.owner_agent_id || l.owner_agent_id === q.owner_agent_id)
      && (!q.source || (a?.source ?? l.source) === q.source)
      && (!q.account_id || a?.account_id === q.account_id)
      && (!q.campaign_id || a?.campaign_id === q.campaign_id);
  });
  const acquired = filtered.filter(l => inside(l.created_at, input.window));
  const acquiredIds = new Set(acquired.map(l => l.id));
  const rows = new Map<string, CampaignMetric>();
  const measurementStarts = new Map(input.pipeline_measurements.map(p => [p.id,p.dashboard_settings?.qualification_started_at]));
  const campaignCurrencies = new Map(input.coverage.map(s => [JSON.stringify([s.account_id,s.campaign_id]),s.currency]));
  const rowFor = (account: string | null, campaign: string | null, label: string, currency: string) => {
    const key = keyOf(account, campaign, currency);
    if (!rows.has(key)) rows.set(key, { account_id: account, campaign_id: campaign, label, currency,
      spend_cents: null, leads: 0, qualified: 0, sales: 0, quantity: 0, revenue_cents: 0,
      cpl_cents: null, cplq_cents: null, cost_per_sale_cents: null, roas: null,
      qualification_complete: true, currency_conflict: false,spend_complete:false,timezone_comparable:false,oldest_sync_at:null });
    return rows.get(key)!;
  };
  // Métricas financeiras permanecem separadas por moeda. Não há conversão cambial implícita.
  for (const lead of filtered) {
    const payment = payments.get(lead.id);
    const isAcquired = acquiredIds.has(lead.id);
    const paid = payment && (q.view === 'acquisition' ? isAcquired : inside(payment.paid_at, input.window));
    if (!isAcquired && !paid) continue;
    const a = attributions.get(lead.id);
    const row = rowFor(a?.account_id ?? null, a?.campaign_id ?? null,
      a?.campaign_name ?? (a?.campaign_id ? `Campanha ${a.campaign_id}` : 'Origem sem campanha identificada'),
      payment?.currency ?? campaignCurrencies.get(JSON.stringify([a?.account_id,a?.campaign_id])) ?? lead.currency ?? 'UNSPECIFIED');
    if (isAcquired) {
      row.leads++; if (qualifications.has(lead.id)) row.qualified++;
      const start = measurementStarts.get(lead.pipeline_id);
      if (!start || Date.parse(start) > Date.parse(lead.created_at)) row.qualification_complete = false;
    }
    if (paid) { row.sales++; row.quantity += payment.quantity; row.revenue_cents = addCents(row.revenue_cents,payment.amount_cents); }
  }
  const spendNotComparable = !!(q.pipeline_id || q.owner_user_id || q.owner_agent_id || q.source);
  const expectedDays=Math.round((Date.parse(q.to)-Date.parse(q.from))/86_400_000)+1;
  if(input.marketingVisible&&!spendNotComparable)for(const c of input.coverage) {
    if((q.account_id&&q.account_id!==c.account_id)||(q.campaign_id&&q.campaign_id!==c.campaign_id))continue;
    const row=rowFor(c.account_id,c.campaign_id,c.campaign_name,c.currency);
    row.spend_complete=c.covered_days===expectedDays;
    row.timezone_comparable=sameTimezone(c.account_timezone,input.window.timezone);
    row.oldest_sync_at=c.oldest_sync_at;
    if(row.spend_complete)row.spend_cents=0;
  }
  // Gasto de uma campanha inteira não pode virar custo de um atendente ou de um subconjunto do funil.
  if (input.marketingVisible && !spendNotComparable) for (const s of input.spend) {
    if (s.day >= q.from && s.day <= q.to && (!q.account_id || s.account_id === q.account_id) && (!q.campaign_id || s.campaign_id === q.campaign_id)) {
      const row = rowFor(s.account_id, s.campaign_id, s.campaign_name, s.currency);
      if(row.spend_complete)row.spend_cents = addCents(row.spend_cents ?? 0,s.amount_cents);
    }
  }
  const currencies = new Map<string, Set<string>>();
  for (const row of rows.values()) if (row.campaign_id) {
    const key = JSON.stringify([row.account_id,row.campaign_id]);
    if (!currencies.has(key)) currencies.set(key,new Set());
    currencies.get(key)!.add(row.currency);
  }
  for (const row of rows.values()) {
    row.currency_conflict = !!row.campaign_id && (currencies.get(JSON.stringify([row.account_id,row.campaign_id]))?.size ?? 0)>1;
    if (q.view === 'acquisition' && !row.currency_conflict && row.timezone_comparable) {
      row.cpl_cents = divide(row.spend_cents, row.leads);
      row.cplq_cents = row.qualification_complete ? divide(row.spend_cents, row.qualified) : null;
      row.cost_per_sale_cents = divide(row.spend_cents, row.sales);
      row.roas = row.spend_cents && row.spend_cents > 0 ? row.revenue_cents / row.spend_cents : null;
    }
  }
  const byStage=new Map<string,number>();
  const byOwner=new Map<string,{owner_kind:'user'|'ai'|'unassigned';owner_id:string|null;leads:number;sales:number}>();
  const bySource=new Map<string,{source:string;leads:number;sales:number}>();
  for(const lead of filtered) {
    if(lead.status==='open' && !payments.has(lead.id)) byStage.set(lead.stage_id,(byStage.get(lead.stage_id)??0)+1);
    const isAcquired=acquiredIds.has(lead.id);
    const paid=payments.get(lead.id);
    const isSale=!!paid && (q.view==='acquisition'?isAcquired:inside(paid.paid_at,input.window));
    if(!isAcquired && !isSale) continue;
    const owner=lead.owner_user_id??lead.owner_agent_id;
    const kind=lead.owner_user_id?'user':lead.owner_agent_id?'ai':'unassigned';
    const key=JSON.stringify([kind,owner]);
    if(!byOwner.has(key)) byOwner.set(key,{owner_kind:kind,owner_id:owner,leads:0,sales:0});
    const source=attributions.get(lead.id)?.source??lead.source;
    if(!bySource.has(source)) bySource.set(source,{source,leads:0,sales:0});
    if(isAcquired) {byOwner.get(key)!.leads++;bySource.get(source)!.leads++;}
    if(isSale) {byOwner.get(key)!.sales++;bySource.get(source)!.sales++;}
  }
  const money = new Map<string, { currency: string; pipeline_cents: number; revenue_cents: number; spend_cents: number | null }>();
  const totals = (currency: string) => {
    if (!money.has(currency)) money.set(currency, { currency, pipeline_cents: 0, revenue_cents: 0, spend_cents: null });
    return money.get(currency)!;
  };
  for (const lead of filtered) if (lead.status === 'open' && !payments.has(lead.id) && lead.value_cents !== null && lead.currency)
    totals(lead.currency).pipeline_cents = addCents(totals(lead.currency).pipeline_cents,lead.value_cents);
  for (const row of rows.values()) {
    const total = totals(row.currency); total.revenue_cents = addCents(total.revenue_cents,row.revenue_cents);
    if (row.spend_cents !== null) total.spend_cents = addCents(total.spend_cents ?? 0,row.spend_cents);
  }
  // Não apresentar a soma parcial de campanhas consultadas como gasto total.
  for(const m of money.values())if([...rows.values()].some(r=>r.campaign_id&&r.currency===m.currency&&!r.spend_complete))m.spend_cents=null;
  return {
    view: q.view, from: q.from, to: q.to, as_of: input.now,
    leads: acquired.length, qualified: acquired.filter(l => qualifications.has(l.id)).length,
    sales: [...rows.values()].reduce((n, r) => n + r.sales, 0),
    quantity: [...rows.values()].reduce((n, r) => n + r.quantity, 0),
    conversion_rate: q.view === 'acquisition' ? divide([...rows.values()].reduce((n, r) => n + r.sales, 0), acquired.length) : null,
    won_without_payment: filtered.filter(l => l.status === 'won' && !payments.has(l.id) && inside(l.created_at, input.window)).length,
    qualification_incomplete: [...rows.values()].some(r => !r.qualification_complete),
    pipeline_without_value: filtered.filter(l => l.status==='open' && !payments.has(l.id) && (l.value_cents===null || !l.currency)).length,
    money: [...money.values()], campaigns: [...rows.values()].sort((a,b)=>(b.spend_cents??-1)-(a.spend_cents??-1)||b.sales-a.sales||a.label.localeCompare(b.label)),
    spend_not_comparable: spendNotComparable,
    spend_incomplete:input.marketingVisible&&[...rows.values()].some(r=>r.campaign_id&&!r.spend_complete),
    timezone_mismatch:input.marketingVisible&&[...rows.values()].some(r=>r.campaign_id&&r.spend_complete&&!r.timezone_comparable),
    stages:[...byStage].map(([stage_id,count])=>({stage_id,count})),
    owners:[...byOwner.values()],sources:[...bySource.values()],
  };
}
