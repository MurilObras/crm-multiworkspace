import { describe,it,expect } from 'vitest';
import { validateCommercialEvent } from '@/lib/obra-no-bolso/commercial-event';
import { campaignDestination,campaignLinkSchema } from '@/lib/dashboard/campaign-links';
import { trackingCode } from '@/lib/dashboard/attribution';
const registration={version:3,event_type:'lead_registered',event_id:'10000000-0000-4000-8000-000000000001',
  product_user_id:'10000000-0000-4000-8000-000000000002',occurred_at:'2026-10-22T12:00:00Z',user_created_at:'2026-10-20T12:00:00Z',
  name:'Teste',email:'TESTE@example.invalid',phone:'5511999990000',crm_ref:null,has_trial:true};
describe('contrato comercial v3 e origem',()=>{
  it('normaliza a identidade e não aceita workspace escolhido no payload',()=>{
    expect(validateCommercialEvent(registration,Date.parse(registration.occurred_at))).toMatchObject({ok:true,event:{phone:'+5511999990000',email:'teste@example.invalid'}});
    expect(validateCommercialEvent({...registration,organization_id:registration.event_id})).toEqual({ok:false});
  });
  it('rejeita pagamento não positivo, anterior ao usuário e evento futuro',()=>{
    const paid={...registration,event_type:'first_payment_received',payment_id:registration.event_id,amount_cents:100,currency:'BRL',paid_at:registration.occurred_at};
    expect(validateCommercialEvent(paid,Date.parse(registration.occurred_at)).ok).toBe(true);
    expect(validateCommercialEvent({...paid,amount_cents:0}).ok).toBe(false);
    expect(validateCommercialEvent({...paid,paid_at:'2026-10-19T12:00:00Z'}).ok).toBe(false);
    expect(validateCommercialEvent(paid,Date.parse('2026-10-21T12:00:00Z')).ok).toBe(false);
  });
  it('origem é referência opaca própria; não admite URL insegura ou campanha externa no body',()=>{
    const code='a'.repeat(24);
    const website=campaignLinkSchema.parse({kind:'website',account_id:'act_1',campaign_id:'2',url:'https://example.invalid/cadastro?plano=profissional'});
    const target=new URL(campaignDestination(website,code));expect(target.searchParams.get('plano')).toBe('profissional');
    expect(target.searchParams.get('crm_ref')).toBe(code);
    expect(()=>campaignDestination({...website,url:'https://user:pass@example.invalid'},code)).toThrow();
    expect(()=>campaignDestination({...website,url:'http://example.invalid'},code)).toThrow();
    const whatsapp=campaignLinkSchema.parse({kind:'whatsapp',account_id:'act_1',campaign_id:'2',phone:'5511999990000',message:'Quero saber mais'});
    expect(trackingCode(new URL(campaignDestination(whatsapp,code)).searchParams.get('text'))).toBe(code);
  });
});
