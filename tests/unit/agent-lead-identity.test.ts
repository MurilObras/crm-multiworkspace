import { createClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { pickToolsFromMcp } from "@/lib/ai/runtime/tools";
import { crmListLeads, crmUpdateLead } from "@/lib/mcp/tools/leads";
import type { McpContext } from "@/lib/mcp/types";

// Somente a saída de auditoria é externa ao cliente sob teste. Ponte, catálogo,
// schemas, handlers e Supabase/PostgREST continuam reais; o transporte é local.
vi.mock("@/lib/audit", () => ({ audit: vi.fn().mockResolvedValue(undefined) }));

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const PIPELINE = "33333333-3333-4333-8333-333333333333";
const LEAD = "44444444-4444-4444-8444-444444444444";
const CONTACT = "55555555-5555-4555-8555-555555555555";
const OTHER_CONTACT = "66666666-6666-4666-8666-666666666666";
const FOREIGN_CONTACT = "77777777-7777-4777-8777-777777777777";
const MISSING_CONTACT = "88888888-8888-4888-8888-888888888888";
const STAGE = "99999999-9999-4999-8999-999999999999";
const TRIAL_STAGE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

type Row = Record<string, unknown>;
let fixtureNumber = 0;

/** Transporte PostgREST em memória: não substitui nenhuma decisão do handler. */
function fixture() {
  const leads: Row[] = [
    { id: LEAD, organization_id: ORG, pipeline_id: PIPELINE, stage_id: STAGE,
      contact_id: CONTACT, title: "Atleta de teste", status: "open", tags: [],
      custom_fields: { origem: "teste" }, owner_user_id: null,
      created_at: "2026-11-01T12:00:00Z", updated_at: "2026-11-01T12:00:00Z" },
    { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", organization_id: ORG,
      pipeline_id: PIPELINE, stage_id: STAGE, contact_id: OTHER_CONTACT,
      title: "Outro atleta", status: "open", owner_user_id: null,
      created_at: "2026-11-02T12:00:00Z" },
    { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", organization_id: OTHER_ORG,
      pipeline_id: PIPELINE, stage_id: STAGE, contact_id: CONTACT,
      title: "Negócio de outro workspace", status: "open", owner_user_id: null,
      created_at: "2026-11-03T12:00:00Z" },
  ];
  const contacts = [
    { id: CONTACT, organization_id: ORG },
    { id: OTHER_CONTACT, organization_id: ORG },
    { id: FOREIGN_CONTACT, organization_id: OTHER_ORG },
  ];
  const stages = [
    { id: STAGE, organization_id: ORG, pipeline_id: PIPELINE, name: "Contato" },
    { id: TRIAL_STAGE, organization_id: ORG, pipeline_id: PIPELINE, name: "Experimental" },
  ];
  const activities: Row[] = [];
  const requests: URL[] = [];
  let moveFails = false;
  const fetcher = async (request: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(request));
    requests.push(url);
    const table = url.pathname.split("/").at(-1)!;
    const method = init?.method ?? "GET";
    const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
      status, headers: { "content-type": "application/json" },
    });
    if (url.pathname.includes("/rpc/")) return response(null);
    const tables: Record<string, Row[]> = { crm_leads: leads, contacts, crm_stages: stages,
      crm_lead_activities: activities };
    const rows = tables[table];
    if (!rows) throw new Error(`Tabela inesperada: ${table}`);
    let matches = rows.filter((row) => [...url.searchParams].every(([key, value]) =>
      !value.startsWith("eq.") || String(row[key]) === value.slice(3)));
    const body = init?.body ? JSON.parse(String(init.body)) as Row : {};
    if (method === "PATCH") {
      if (moveFails && body.stage_id) {
        moveFails = false;
        return response({ message: "falha de escrita", code: "XX000" }, 500);
      }
      // A FK do banco impede UUID inexistente, mas NÃO garante mesma organização.
      if (typeof body.contact_id === "string" && !contacts.some((c) => c.id === body.contact_id)) {
        return response({ message: "violates foreign key constraint", code: "23503" }, 409);
      }
      matches.forEach((row) => Object.assign(row, body));
    } else if (method === "POST") {
      rows.push(body);
      matches = [body];
    }
    const order = url.searchParams.get("order");
    if (order) matches = [...matches].sort((a, b) =>
      String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")));
    const limit = url.searchParams.get("limit");
    if (limit) matches = matches.slice(0, Number(limit));
    const headers = new Headers(init?.headers);
    return response(headers.get("accept")?.includes("vnd.pgrst.object")
      ? matches[0] ?? null : matches);
  };
  const supabase = createClient("http://identity-test.invalid", "test-key", {
    auth: { persistSession: false, autoRefreshToken: false, storageKey: `identity-test-${++fixtureNumber}` },
    global: { fetch: fetcher },
  });
  const ctx: McpContext = {
    organizationId: ORG, role: "ai_operator", actor: { type: "ai_agent", id: "agent-test", role: "ai_operator" },
    apiTokenId: "test-token", requestId: "identity-test", supabase,
  };
  const tools = pickToolsFromMcp({ supabase, ctx,
    auth: { ...ctx, scopes: ["mcp:read", "mcp:write"] },
    pipelineIds: [PIPELINE], toolIds: ["crm_update_lead", "crm_list_leads", "crm_move_lead_stage", "crm_get_lead"],
    handoffToolEnabled: false, handoffSignal: { triggered: false },
  });
  const execute = (name: string, args: unknown) =>
    (tools[name] as unknown as { execute: (input: unknown) => Promise<unknown> }).execute(args);
  return { leads, activities, requests, ctx, tools, execute, failMove: () => { moveFails = true; } };
}

beforeEach(() => vi.clearAllMocks());

describe("a edição operacional da IA preserva a identidade do cartão", () => {
  it.each([MISSING_CONTACT, OTHER_CONTACT, FOREIGN_CONTACT])(
    "um contact_id indevido (%s) não impede nem desvincula o registro do aceite", async (contactId) => {
      const f = fixture();
      const result = await f.execute("crm_update_lead", {
        lead_id: LEAD, contact_id: contactId, description: "Experimental aceita no próximo treino",
        tags: ["experimental"],
      });
      expect(result).toMatchObject({ lead: { id: LEAD, contact_id: CONTACT,
        description: "Experimental aceita no próximo treino", tags: ["experimental"] } });
      expect(f.leads[0]?.contact_id).toBe(CONTACT);
    },
  );

  it("o schema oferecido ao modelo não pede vínculo para editar", () => {
    const f = fixture();
    const schema = f.tools.crm_update_lead!.inputSchema as z.ZodObject;
    expect(schema.parse({ lead_id: LEAD, contact_id: OTHER_CONTACT })).not.toHaveProperty("contact_id");
    // O contrato administrativo original continua oferecendo relink explícito.
    expect(z.object(crmUpdateLead.inputSchema).parse({ lead_id: LEAD, contact_id: OTHER_CONTACT }))
      .toHaveProperty("contact_id", OTHER_CONTACT);
  });

  it("a ficha, etapa e etiquetas são recuperáveis sem duplicar o cartão após falha parcial", async () => {
    const f = fixture();
    const args = { lead_id: LEAD, custom_fields: { unidade: "Pontal Sul", trial_at: "2026-11-10T21:30:00Z" },
      tags: ["experimental"] };
    const schema = f.tools.crm_update_lead!.inputSchema as z.ZodObject;
    const first = await f.execute("crm_update_lead", schema.parse(args));
    expect(first).toMatchObject({ lead: { custom_fields: { origem: "teste", unidade: "Pontal Sul",
      trial_at: "2026-11-10T21:30:00Z" }, tags: ["experimental"] } });
    f.failMove();
    const failedMove = await f.execute("crm_move_lead_stage", { lead_id: LEAD, to_stage_id: TRIAL_STAGE });
    expect(failedMove).toHaveProperty("error");
    const persisted = await f.execute("crm_get_lead", { lead_id: LEAD });
    expect(persisted).toMatchObject({ lead: { stage_id: STAGE, contact_id: CONTACT,
      custom_fields: { unidade: "Pontal Sul" }, tags: ["experimental"] } });
    await f.execute("crm_update_lead", args);
    const moved = await f.execute("crm_move_lead_stage", { lead_id: LEAD, to_stage_id: TRIAL_STAGE });
    expect(moved).toMatchObject({ lead: { id: LEAD, contact_id: CONTACT, stage_id: TRIAL_STAGE,
      tags: ["experimental"], custom_fields: { origem: "teste", unidade: "Pontal Sul" } } });
    expect(f.leads.filter((lead) => lead.id === LEAD)).toHaveLength(1);
  });

  it("localiza somente os cartões do contato e workspace com filtro limitado", async () => {
    const f = fixture();
    const result = await f.execute("crm_list_leads", { contact_id: CONTACT, pipeline_id: PIPELINE, limit: 20 });
    expect(result).toMatchObject({ leads: [{ id: LEAD }], has_more: false });
    expect((result as { leads: Row[] }).leads).toHaveLength(1);
    const query = f.requests.find((url) => url.pathname.endsWith("/crm_leads"));
    expect(query?.searchParams.get("organization_id")).toBe(`eq.${ORG}`);
    expect(query?.searchParams.get("contact_id")).toBe(`eq.${CONTACT}`);
    expect(query?.searchParams.get("limit")).toBe("21");
  });

  it("o schema de busca permite escolher o contato sem paginar a carteira", () => {
    expect(z.object(crmListLeads.inputSchema).parse({ contact_id: CONTACT }))
      .toHaveProperty("contact_id", CONTACT);
  });
});

describe("relink administrativo mantém validação de organização no servidor", () => {
  it("preserva relink legítimo de humano/MCP externo", async () => {
    const f = fixture();
    const result = await crmUpdateLead.handler({ lead_id: LEAD, contact_id: OTHER_CONTACT },
      { ...f.ctx, role: "manager", actor: { type: "user", id: "human-test" } });
    expect(result).toMatchObject({ lead: { contact_id: OTHER_CONTACT } });
  });

  it.each([MISSING_CONTACT, FOREIGN_CONTACT])("recusa contato fora da organização (%s) sem mudar o cartão", async (contactId) => {
    const f = fixture();
    await expect(crmUpdateLead.handler({ lead_id: LEAD, contact_id: contactId },
      { ...f.ctx, role: "manager", actor: { type: "user", id: "human-test" } }))
      .rejects.toMatchObject({ status: 422, code: "validation_failed" });
    expect(f.leads[0]?.contact_id).toBe(CONTACT);
  });
});
