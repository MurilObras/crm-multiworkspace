// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import type pg from "pg";
import { installResponsiblePause } from "@/tests/helpers/responsible-postgres";

import { pgComoSupabase } from "@/tests/pg-como-supabase";
import { createSupabaseAdminClient } from "./engine";
import { createPgAdminClient } from "./turn-bridge";
import { processNode, type EnrollmentRow } from "./node-handlers";
import type { FlowEdge, FlowNode } from "./graph-schema";

const ORG = "10000000-0000-4000-8000-000000000001";
const OTHER = "20000000-0000-4000-8000-000000000001";
const CONTACT = "10000000-0000-4000-8000-000000000002";
const TAG = "retomada_comercial";
const sql = new PGlite();
const pool = {
  query: async (text: string, values?: unknown[]) => {
    const r = await sql.query(text, values);
    return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
  },
} as unknown as pg.Pool;
const adapters = [
  ["worker pg", createPgAdminClient(pool)],
  ["cron Supabase", createSupabaseAdminClient(pgComoSupabase(pool))],
] as const;

beforeAll(async () => {
  // PostgreSQL embarcado executa as consultas de PRODUÇÃO, não um mock das linhas retornadas.
  await sql.exec(`
    create table contacts(id uuid, organization_id uuid, name text, tags text[]);
    create table crm_leads(contact_id uuid, organization_id uuid, stage_id uuid,
      tags text[], custom_fields jsonb, updated_at timestamptz default now());
  `);
  await installResponsiblePause(sql);
});
afterAll(() => sql.close());

for (const [name, adapter] of adapters)
  describe(name, () => {
    async function seed(contactTags: string[], leadTags: string[], withLead = true) {
      await sql.exec("truncate contacts, crm_leads");
      await sql.query("insert into contacts(id,organization_id,name,tags) values($1,$2,'Cliente de teste',$3)", [
        CONTACT,
        ORG,
        contactTags,
      ]);
      if (withLead)
        await sql.query("insert into crm_leads(contact_id,organization_id,tags) values($1,$2,$3)", [
          CONTACT,
          ORG,
          leadTags,
        ]);
    }

    it("contato etiquetado e cartão sem etiqueta continua elegível", async () => {
      await seed([TAG], []);
      const facts = await adapter.loadLeadFacts(ORG, CONTACT);
      expect(facts.tags).toEqual([TAG]);
      const node: FlowNode = {
        id: "guard",
        type: "condition",
        label: "Elegibilidade",
        position: { x: 0, y: 0 },
        config: { combinator: "and", checks: [{ field: "tag", op: "eq", value: TAG }] },
      };
      const edges: FlowEdge[] = [true, false].map((value) => ({
        id: String(value),
        source: "guard",
        target: value ? "enviar" : "encerrar",
        priority: 0,
        condition: { type: "cond_result", value },
      }));
      const result = processNode({
        node,
        edges,
        lead: { ...facts, steps_taken: 0, last_outcome: null },
        enrollment: { current_node_id: "guard" } as EnrollmentRow,
        clock: () => new Date("2026-10-20T19:00:00Z"),
      });
      expect(result).toMatchObject({ kind: "advance", next_node_id: "enviar" });
    });

    it("retirar etiqueta do contato bloqueia mesmo se o cartão manteve uma cópia antiga", async () => {
      await seed([TAG], [TAG]);
      expect((await adapter.loadLeadFacts(ORG, CONTACT)).tags).toContain(TAG);
      await sql.query("update contacts set tags='{}' where id=$1 and organization_id=$2", [
        CONTACT,
        ORG,
      ]);
      expect((await adapter.loadLeadFacts(ORG, CONTACT)).tags).toEqual([]);
    });

    it("não mistura etiquetas do cartão com as do contato", async () => {
      await seed([TAG], ["somente_no_cartao"]);
      expect((await adapter.loadLeadFacts(ORG, CONTACT)).tags).toEqual([TAG]);
    });

    it("consulta etiquetas mesmo sem oportunidade no funil", async () => {
      await seed([TAG], [], false);
      expect(await adapter.loadLeadFacts(ORG, CONTACT)).toMatchObject({
        tags: [TAG],
        lead_stage: null,
      });
    });

    it("não lê contato nem etiquetas de outro workspace", async () => {
      await seed([TAG], [TAG]);
      expect(await adapter.loadLeadFacts(OTHER, CONTACT)).toMatchObject({
        tags: [],
        lead_stage: null,
        contact_name: null,
      });
    });

    it("etiqueta nula equivale a nenhuma autorização, sem fallback ao cartão", async () => {
      await seed([], [TAG]);
      await sql.query("update contacts set tags=null");
      expect((await adapter.loadLeadFacts(ORG, CONTACT)).tags).toEqual([]);
    });
  });
