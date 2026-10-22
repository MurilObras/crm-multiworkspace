import { beforeAll, describe, expect, it } from "vitest";
import {
  sql,
  lastLine,
  countAs,
  seedGov,
  GOV_ORG,
  GOV_MANAGER,
  GOV_AGENT_A,
  GOV_AGENT_B,
  GOV_VIEWER,
  GOV_LEAD,
  GOV_STAGE,
  GOV_PIPELINE,
  GOV_CONTACT_1,
} from "./gov-helpers";

const ORG_B = "da5b0000-0000-4000-8000-000000000001",
  MANAGER_B = "da5b0000-0000-4000-8000-000000000002";
const PIPE_B = "da5b0000-0000-4000-8000-000000000003",
  STAGE_B = "da5b0000-0000-4000-8000-000000000004";
const CONTACT_B = "da5b0000-0000-4000-8000-000000000005",
  LEAD_B = "da5b0000-0000-4000-8000-000000000006";
const PRODUCT = "da5b0000-0000-4000-8000-000000000007",
  EVENT = "da5b0000-0000-4000-8000-000000000008";
const parent = ["crm_first_payments", "crm_lead_qualifications", "crm_lead_attribution"];
const marketing = [
  "crm_campaign_assignments",
  "crm_ad_spend_daily",
  "crm_ad_spend_coverage",
  "crm_ad_sync_accounts",
  "crm_campaign_links",
];
const privateTables = ["obra_commercial_links", "obra_commercial_receipts"];
beforeAll(() => {
  seedGov();
  sql(`insert into organizations(id,slug,legal_name,display_name)values('${ORG_B}','dashboard-rls-b','Sintético B','Sintético B');
    insert into auth.users(id,email)values('${MANAGER_B}','dashboard-b@invariant.test');
    insert into user_organizations(organization_id,user_id,role,accepted_at)values('${ORG_B}','${MANAGER_B}','manager',now());
    insert into contacts(id,organization_id,name)values('${CONTACT_B}','${ORG_B}','Sintético B');
    insert into crm_pipelines(id,organization_id,name,slug)values('${PIPE_B}','${ORG_B}','Sintético B','dashboard-rls-b');
    insert into crm_stages(id,organization_id,pipeline_id,name,slug,position)values('${STAGE_B}','${ORG_B}','${PIPE_B}','Novo','novo',1000);
    insert into crm_leads(id,organization_id,pipeline_id,stage_id,contact_id,title,owner_user_id)
      values('${LEAD_B}','${ORG_B}','${PIPE_B}','${STAGE_B}','${CONTACT_B}','Sintético B','${MANAGER_B}');
    update crm_leads set contact_id='${GOV_CONTACT_1}',owner_user_id='${GOV_AGENT_A}' where id='${GOV_LEAD}';`);
  for (const [org, actor, pipe, stage, contact, lead, account, campaign, code] of [
    [
      GOV_ORG,
      GOV_MANAGER,
      GOV_PIPELINE,
      GOV_STAGE,
      GOV_CONTACT_1,
      GOV_LEAD,
      "act_501",
      "502",
      "a".repeat(24),
    ],
    [ORG_B, MANAGER_B, PIPE_B, STAGE_B, CONTACT_B, LEAD_B, "act_601", "602", "b".repeat(24)],
  ])
    sql(`select fn_record_crm_first_payment('${org}','${lead}',15000,'BRL',now(),1,'manual',null,'${actor}','Sintético');
    insert into crm_lead_qualifications(organization_id,lead_id,stage_id)values('${org}','${lead}','${stage}');
    insert into crm_lead_attribution(organization_id,lead_id,source,method)values('${org}','${lead}','whatsapp','inbound');
    insert into crm_campaign_assignments(organization_id,account_id,campaign_id,campaign_name,currency,account_timezone)
      values('${org}','${account}','${campaign}','Campanha sintética','BRL','UTC');
    insert into crm_ad_spend_daily(organization_id,account_id,campaign_id,campaign_name,day,currency,amount_cents)
      values('${org}','${account}','${campaign}','Campanha sintética',current_date,'BRL',100);
    insert into crm_ad_spend_coverage(organization_id,account_id,campaign_id,day,currency,account_timezone)
      values('${org}','${account}','${campaign}',current_date,'BRL','UTC');
    insert into crm_ad_sync_accounts(organization_id,account_id,last_success_at)values('${org}','${account}',now());
    insert into crm_campaign_links(organization_id,account_id,campaign_id,code,destination_url,kind)
      values('${org}','${account}','${campaign}','${code}','https://example.invalid','website');
    insert into obra_access_integrations(organization_id,pipeline_id,secret_encrypted)values('${org}','${pipe}',decode('00','hex'));
    insert into obra_commercial_links(organization_id,product_user_id,contact_id,lead_id)values('${org}','${PRODUCT}','${contact}','${lead}');
    insert into obra_commercial_receipts(organization_id,integration_id,event_id,product_user_id,event_type,fingerprint,lead_id)
      select '${org}',id,'${EVENT}','${PRODUCT}','lead_registered',repeat('a',64),'${lead}' from obra_access_integrations where organization_id='${org}';`);
});
describe("cada tabela comercial tem isolamento comportamental entre duas organizações", () => {
  for (const table of [...parent, ...marketing])
    it(`${table}: controles positivos e negativos A↔B sob JWT real`, () => {
      expect(
        countAs(GOV_MANAGER, `select count(*) from ${table} where organization_id='${GOV_ORG}'`),
      ).toBe(1);
      expect(
        countAs(MANAGER_B, `select count(*) from ${table} where organization_id='${ORG_B}'`),
      ).toBe(1);
      expect(
        countAs(GOV_MANAGER, `select count(*) from ${table} where organization_id='${ORG_B}'`),
      ).toBe(0);
      expect(
        countAs(MANAGER_B, `select count(*) from ${table} where organization_id='${GOV_ORG}'`),
      ).toBe(0);
      expect(
        countAs(GOV_VIEWER, `select count(*) from ${table} where organization_id='${GOV_ORG}'`),
      ).toBe(0);
      expect(() =>
        sql(`set role authenticated;select set_config('request.jwt.claims','{"sub":"${GOV_MANAGER}"}',false);
      update ${table} set organization_id=organization_id where organization_id='${GOV_ORG}';`),
      ).toThrow(/permission denied/);
    });
  for (const table of parent)
    it(`${table}: atendente só lê filhos dos leads que pode acessar`, () => {
      expect(
        countAs(GOV_AGENT_A, `select count(*) from ${table} where organization_id='${GOV_ORG}'`),
      ).toBe(1);
      expect(
        countAs(GOV_AGENT_B, `select count(*) from ${table} where organization_id='${GOV_ORG}'`),
      ).toBe(0);
    });
  for (const table of marketing)
    it(`${table}: atendente não lê marketing do próprio workspace`, () => {
      expect(
        countAs(GOV_AGENT_A, `select count(*) from ${table} where organization_id='${GOV_ORG}'`),
      ).toBe(0);
    });
  for (const table of privateTables)
    it(`${table}: somente serviço; nem o gestor lê ou altera dados próprios/vizinhos`, () => {
      expect(lastLine(sql(`set role service_role;select count(*) from ${table}`))).toBe("2");
      for (const user of [GOV_MANAGER, MANAGER_B])
        for (const org of [GOV_ORG, ORG_B]) {
          expect(() =>
            countAs(user, `select count(*) from ${table} where organization_id='${org}'`),
          ).toThrow(/permission denied/);
          expect(() =>
            sql(`set role authenticated;select set_config('request.jwt.claims','{"sub":"${user}"}',false);
        update ${table} set organization_id=organization_id where organization_id='${org}';`),
          ).toThrow(/permission denied/);
        }
      expect(() => sql(`set role anon;select count(*) from ${table};`)).toThrow(
        /permission denied/,
      );
    });
});
