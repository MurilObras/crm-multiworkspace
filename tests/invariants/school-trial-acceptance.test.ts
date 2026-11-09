import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import pg from "pg";

import { pickToolsFromMcp } from "@/lib/ai/runtime/tools";
import { crmUpdateLead } from "@/lib/mcp/tools/leads";
import type { McpContext } from "@/lib/mcp/types";
import { pgComoSupabase } from "../pg-como-supabase";

// Auditoria possui cliente global; as escritas de negócio usam o banco efêmero.
vi.mock("@/lib/audit", () => ({ audit: vi.fn().mockResolvedValue(undefined) }));

if (!process.env.TEST_DB_CONTAINER) throw new Error("Execute via pnpm test:db, nunca contra produção.");
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${Number(process.env.TEST_DB_PORT ?? 54329)}/postgres`,
  max: 3,
  // PostgREST devolve timestamptz como texto com microssegundos. O parser Date
  // padrão do pg perde precisão e simula um conflito que não ocorreu no banco.
  types: { getTypeParser: (oid: number) => oid === 1184 ? (value: string) => value : pg.types.getTypeParser(oid) },
});
const db = pgComoSupabase(pool);
const ORG_A = "b3010000-0000-4000-8000-00000000000a";
const ORG_B = "b3010000-0000-4000-8000-00000000000b";
const MISSING = "b3010000-0000-4000-8000-000000000099";
let pipeline = "";
let initialStage = "";
let trialStage = "";
let foreignStage = "";
let contact = "";
let siblingContact = "";
let foreignContact = "";
let leadId = "";

function context(): McpContext {
  return { organizationId: ORG_A, role: "ai_operator",
    actor: { type: "ai_agent", id: "invariant-identity", role: "ai_operator" },
    apiTokenId: "invariant-token", requestId: "invariant-identity", supabase: db };
}

function run(name: string, input: unknown) {
  const ctx = context();
  const tools = pickToolsFromMcp({ supabase: db, ctx,
    auth: { ...ctx, scopes: ["mcp:read", "mcp:write"] },
    pipelineIds: [pipeline], toolIds: [name], handoffToolEnabled: false,
    handoffSignal: { triggered: false },
  });
  return (tools[name] as unknown as { execute: (args: unknown) => Promise<unknown> }).execute(input);
}

beforeAll(async () => {
  for (const [org, suffix] of [[ORG_A, "a"], [ORG_B, "b"]] as const) {
    await pool.query(`insert into organizations (id, slug, legal_name, display_name)
      values ($1, $2, 'Teste de identidade', 'Teste de identidade')`, [org, `trial-identity-${suffix}`]);
    const p = await pool.query(`insert into crm_pipelines (organization_id, name, slug, position)
      values ($1, 'Funil de teste', 'trial-identity', 1) returning id`, [org]);
    const s = await pool.query(`insert into crm_stages (organization_id, pipeline_id, name, slug, position)
      values ($1, $2, 'Primeiro contato', 'initial', 1) returning id`, [org, p.rows[0].id]);
    const c = await pool.query(`insert into contacts (organization_id, name)
      values ($1, 'Responsável de teste') returning id`, [org]);
    if (org === ORG_A) {
      pipeline = p.rows[0].id;
      initialStage = s.rows[0].id;
      contact = c.rows[0].id;
    } else {
      foreignStage = s.rows[0].id;
      foreignContact = c.rows[0].id;
    }
  }
  const s = await pool.query(`insert into crm_stages (organization_id, pipeline_id, name, slug, position)
    values ($1, $2, 'Experimental agendada', 'trial', 2) returning id`, [ORG_A, pipeline]);
  trialStage = s.rows[0].id;
  const c = await pool.query(`insert into contacts (organization_id, name)
    values ($1, 'Outro responsável') returning id`, [ORG_A]);
  siblingContact = c.rows[0].id;
  const l = await pool.query(`insert into crm_leads (organization_id, pipeline_id, stage_id, contact_id, title)
    values ($1, $2, $3, $4, 'Atleta de teste') returning id`, [ORG_A, pipeline, initialStage, contact]);
  leadId = l.rows[0].id;
});

beforeEach(async () => {
  await pool.query(`update crm_leads set contact_id=$1, stage_id=$2, custom_fields='{}', tags='{}'
    where id=$3`, [contact, initialStage, leadId]);
});

afterAll(async () => { await pool.end(); });

describe("aceite da experimental pela ponte real, em banco com duas organizações", () => {
  it("o transporte preserva microssegundos para a comparação otimista real", async () => {
    const value = await pool.query("select '2026-11-10T21:30:00.123456Z'::timestamptz as updated_at");
    expect(value.rows[0].updated_at).toContain('.123456');
    const roundtrip = await pool.query("select $1::timestamptz = '2026-11-10T21:30:00.123456Z'::timestamptz as same", [value.rows[0].updated_at]);
    expect(roundtrip.rows[0].same).toBe(true);
  });
  it.each(["missing", "sibling", "foreign"])("preserva identidade ao editar com vínculo indevido %s", async (kind) => {
    const wrongContact = kind === "missing" ? MISSING : kind === "sibling" ? siblingContact : foreignContact;
    const result = await run("crm_update_lead", { lead_id: leadId, contact_id: wrongContact,
      description: "Experimental aceita", tags: ["experimental"] });
    expect(result).toMatchObject({ lead: { id: leadId, contact_id: contact, tags: ["experimental"] } });
    const state = await pool.query("select contact_id, description from crm_leads where id=$1", [leadId]);
    expect(state.rows[0]).toMatchObject({ contact_id: contact, description: "Experimental aceita" });
  });

  it("rejeita relink administrativo para contato alheio sem mutação", async () => {
    await expect(crmUpdateLead.handler({ lead_id: leadId, contact_id: foreignContact }, context()))
      .rejects.toMatchObject({ code: "validation_failed", status: 422 });
    const state = await pool.query("select contact_id from crm_leads where id=$1", [leadId]);
    expect(state.rows[0].contact_id).toBe(contact);
  });

  it("recupera apenas o avanço que falhou preservando ficha e etiquetas, sem criar outro cartão", async () => {
    const form = { unidade: "Unidade de teste", trial_at: "2026-11-10T21:30:00Z" };
    await run("crm_update_lead", { lead_id: leadId, custom_fields: form, tags: ["experimental"] });
    const rejected = await run("crm_move_lead_stage", { lead_id: leadId, to_stage_id: foreignStage });
    expect(rejected).toHaveProperty("error");
    const partial = await pool.query("select stage_id, custom_fields, contact_id from crm_leads where id=$1", [leadId]);
    expect(partial.rows[0]).toMatchObject({ stage_id: initialStage, custom_fields: form, contact_id: contact });
    const moved = await run("crm_move_lead_stage", { lead_id: leadId, to_stage_id: trialStage });
    expect(moved).toMatchObject({ lead: { id: leadId, stage_id: trialStage, contact_id: contact,
      custom_fields: form, tags: ["experimental"] } });
    const final = await pool.query("select id, stage_id, tags, custom_fields from crm_leads where organization_id=$1 and contact_id=$2", [ORG_A, contact]);
    expect(final.rows).toHaveLength(1);
    expect(final.rows[0]).toMatchObject({ id: leadId, stage_id: trialStage, tags: ["experimental"], custom_fields: form });
  });
});
