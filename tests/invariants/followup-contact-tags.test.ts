import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { pgComoSupabase } from "../pg-como-supabase";
import { createSupabaseAdminClient } from "@/lib/followup/engine";
import { createPgAdminClient } from "@/lib/followup/turn-bridge";

if (!process.env.TEST_DB_CONTAINER) throw new Error("Rode via pnpm test:db.");
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
});
const ORG = "c2300000-0000-4000-8000-000000000001";
const OTHER = "c2300000-0000-4000-8000-000000000002";
let contact: string;
let lead: string;
const TAG = "retomada_teste_automatico";

beforeAll(async () => {
  for (const id of [ORG, OTHER])
    await pool.query(
      "insert into organizations(id,slug,legal_name,display_name) values($1,$2,'Teste follow-up','Teste follow-up')",
      [id, `followup-tags-${id}`],
    );
  const { rows: contacts } = await pool.query<{ id: string }>(
    "insert into contacts(organization_id,display_name,tags) values($1,'Contato de teste',$2) returning id",
    [ORG, [TAG]],
  );
  contact = contacts[0]!.id;
  const { rows: pipelines } = await pool.query<{ id: string }>(
    "insert into crm_pipelines(organization_id,name,slug) values($1,'Funil teste','followup-tags') returning id",
    [ORG],
  );
  const { rows: stages } = await pool.query<{ id: string }>(
    "insert into crm_stages(organization_id,pipeline_id,name,slug,position) values($1,$2,'Em atendimento','em-atendimento',1000) returning id",
    [ORG, pipelines[0]!.id],
  );
  const { rows: leads } = await pool.query<{ id: string }>(
    "insert into crm_leads(organization_id,pipeline_id,stage_id,contact_id,title,tags) values($1,$2,$3,$4,'Lead teste',$5) returning id",
    [ORG, pipelines[0]!.id, stages[0]!.id, contact, ["tag_exclusiva_do_cartao"]],
  );
  lead = leads[0]!.id;
});
afterAll(async () => {
  await pool.query("delete from organizations where id=any($1::uuid[])", [[ORG, OTHER]]);
  await pool.end();
});

for (const [name, adapter] of [
  ["worker", createPgAdminClient(pool)],
  ["cron", createSupabaseAdminClient(pgComoSupabase(pool))],
] as const)
  describe(`etiquetas no baseline real — ${name}`, () => {
    it("a condição lê a etiqueta do contato sem exigir duplicação no cartão", async () => {
      await pool.query("update crm_leads set tags=$1 where organization_id=$2 and id=$3", [
        ["tag_exclusiva_do_cartao"],
        ORG,
        lead,
      ]);
      await pool.query("update contacts set tags=$1 where organization_id=$2 and id=$3", [
        [TAG],
        ORG,
        contact,
      ]);
      expect((await adapter.loadLeadFacts(ORG, contact)).tags).toEqual([TAG]);
    });
    it("retirada do contato é respeitada mesmo com etiqueta antiga no lead", async () => {
      await pool.query("update crm_leads set tags=$1 where organization_id=$2 and id=$3", [
        [TAG],
        ORG,
        lead,
      ]);
      await pool.query("update contacts set tags='{}' where organization_id=$1 and id=$2", [
        ORG,
        contact,
      ]);
      expect((await adapter.loadLeadFacts(ORG, contact)).tags).toEqual([]);
    });
    it("outro workspace não consegue ler a etiqueta deste contato", async () => {
      await pool.query("update contacts set tags=$1 where organization_id=$2 and id=$3", [
        [TAG],
        ORG,
        contact,
      ]);
      expect(await adapter.loadLeadFacts(OTHER, contact)).toMatchObject({
        tags: [],
        lead_stage: null,
        contact_name: null,
      });
    });
  });
