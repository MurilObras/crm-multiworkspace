import { beforeAll,describe,expect,it } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { sql,lastLine,countAs,seedGov,GOV_ORG,GOV_MANAGER,GOV_AGENT_A,GOV_AGENT_B,GOV_VIEWER,GOV_LEAD,GOV_STAGE,GOV_PIPELINE,GOV_CONTACT_1 } from './gov-helpers';

const OTHER='c0aa0000-0000-4000-8000-000000000001';
beforeAll(()=>{
  seedGov();
  sql(`insert into organizations(id,slug,legal_name,display_name)values('${OTHER}','commercial-other','Outro','Outro');
    update crm_leads set contact_id='${GOV_CONTACT_1}',owner_user_id='${GOV_AGENT_A}' where id='${GOV_LEAD}';
    select fn_record_crm_first_payment('${GOV_ORG}','${GOV_LEAD}',25000,'BRL',now(),2,'manual',null,'${GOV_MANAGER}','Recebido');
    insert into crm_campaign_assignments(organization_id,account_id,campaign_id,campaign_name,currency,account_timezone)
      values('${GOV_ORG}','act_123','456','Campanha sintética','BRL','America/Sao_Paulo');`);
});
describe('dashboard no baseline completo',()=>{
  it('financeiro herda escopo do lead; viewer, outro dono e workspace não leem',()=>{
    const query=`select count(*) from crm_first_payments where organization_id='${GOV_ORG}'`;
    expect(countAs(GOV_MANAGER,query)).toBe(1);expect(countAs(GOV_AGENT_A,query)).toBe(1);
    expect(countAs(GOV_AGENT_B,query)).toBe(0);expect(countAs(GOV_VIEWER,query)).toBe(0);
    expect(countAs(GOV_MANAGER,`select count(*) from crm_first_payments where organization_id='${OTHER}'`)).toBe(0);
  });
  it('gastos/links não são visíveis ao atendente e escrita financeira não é RPC do browser',()=>{
    expect(countAs(GOV_MANAGER,'select count(*) from crm_campaign_assignments')).toBe(1);
    expect(countAs(GOV_AGENT_A,'select count(*) from crm_campaign_assignments')).toBe(0);
    expect(lastLine(sql(`select has_function_privilege('authenticated',
      'public.fn_record_crm_first_payment(uuid,uuid,integer,text,timestamptz,integer,text,text,uuid,text,timestamptz,boolean)','execute')`))).toBe('f');
  });
  it('snapshot por JWT exige pertencimento mesmo com organização fornecida na chamada',()=>{
    const snap=(org:string)=>`select fn_crm_dashboard_inputs('${org}',now()-interval '1 day',now()+interval '1 day',current_date-1,current_date+1)`;
    const own=lastLine(sql(`set role authenticated;select set_config('request.jwt.claims','{"sub":"${GOV_MANAGER}"}',false);${snap(GOV_ORG)}`));
    expect(JSON.parse(own).payments).toHaveLength(1);
    expect(()=>sql(`set role authenticated;select set_config('request.jwt.claims','{"sub":"${GOV_MANAGER}"}',false);${snap(OTHER)}`)).toThrow();
  });
  it('qualificação exige novo avanço e não duplica ao repetir etapa',()=>{
    sql(`select fn_configure_crm_dashboard('${GOV_ORG}','${GOV_PIPELINE}',array['${GOV_STAGE}']::uuid[],'Matrículas',true);`);
    expect(lastLine(sql(`select count(*) from crm_lead_qualifications where organization_id='${GOV_ORG}'`))).toBe('0');
    // O schema real não permite etapa nula: um novo negócio entra na etapa marcada.
    sql(`insert into crm_leads(organization_id,pipeline_id,stage_id,title)
      values('${GOV_ORG}','${GOV_PIPELINE}','${GOV_STAGE}','Novo qualificado');`);
    expect(lastLine(sql(`select count(*) from crm_lead_qualifications where organization_id='${GOV_ORG}'`))).toBe('1');
  });
  it('anonimização redige notas e a anulação não reintroduz dados',()=>{
    sql(`update contacts set is_anonymized=true,anonymized_at=now() where id='${GOV_CONTACT_1}' and organization_id='${GOV_ORG}';`);
    expect(lastLine(sql(`select note='' and history='[]'::jsonb from crm_first_payments where organization_id='${GOV_ORG}'`))).toBe('t');
    expect(()=>sql(`select fn_void_crm_first_payment('${GOV_ORG}','${GOV_LEAD}',now(),'${GOV_MANAGER}','Nome não pode voltar')`)).toThrow();
  });
  it('excluir workspace elimina seus links e cache sem bloquear a exclusão',()=>{
    sql(`insert into crm_campaign_assignments(organization_id,account_id,campaign_id,campaign_name,currency,account_timezone)
      values('${OTHER}','act_999','999','Somente outro workspace','BRL','UTC');
      insert into crm_campaign_links(organization_id,account_id,campaign_id,code,destination_url,kind)
      values('${OTHER}','act_999','999','aaaaaaaaaaaaaaaaaaaaaaaa','https://example.invalid','website');
      insert into crm_ad_spend_daily(organization_id,account_id,campaign_id,campaign_name,day,currency,amount_cents)
      values('${OTHER}','act_999','999','Somente outro workspace',current_date,'BRL',100);
      delete from organizations where id='${OTHER}';`);
    expect(lastLine(sql(`select count(*) from crm_campaign_links where organization_id='${OTHER}'`))).toBe('0');
    expect(lastLine(sql(`select count(*) from crm_ad_spend_daily where organization_id='${OTHER}'`))).toBe('0');
  });
});
describe('vocabulários novos correspondem aos CHECKs do banco',()=>{
  const source=ts.createSourceFile('contracts.ts',readFileSync('lib/dashboard/contracts.ts','utf8'),ts.ScriptTarget.Latest,true);
  for(const [table,column,symbol] of [['crm_first_payments','source','PaymentSource'],['crm_lead_attribution','method','AttributionMethod'],
    ['crm_campaign_links','kind','CampaignLinkKind'],['obra_commercial_receipts','event_type','CommercialEventKind']]) {
    it(`${table}.${column}`,()=>{
      const alias=source.statements.find(s=>ts.isTypeAliasDeclaration(s)&&s.name.text===symbol);
      if(!alias||!ts.isTypeAliasDeclaration(alias)||!ts.isUnionTypeNode(alias.type))throw new Error('Tipo literal ausente');
      const literals=alias.type.types.map(n=>ts.isLiteralTypeNode(n)&&ts.isStringLiteral(n.literal)?n.literal.text:'').sort();
      const constraints=sql(`select pg_get_constraintdef(oid) from pg_constraint where conrelid='public.${table}'::regclass and contype='c'`);
      const clause=constraints.split('\n').find(s=>new RegExp(`\\b${column}\\b`).test(s)&&s.includes('ANY'));
      expect(clause).toBeTruthy();
      const actual=[...(clause??'').matchAll(/'([^']+)'::text/g)].map(m=>m[1]).sort();
      expect(actual).toEqual(literals);
    });
  }
});
