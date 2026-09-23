import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import pg from "pg";

import { GOV_ORG, GOV_MANAGER, GOV_AGENT_A, seedGov, sql } from "./gov-helpers";
import {
  chaveDeIdempotencia,
  concluirIdempotencia,
  hashCanonico,
  idRecurso,
  reservarOuReplay,
} from "@/lib/api/idempotency";
import { sendMessageHandler } from "@/app/api/v1/messages/_handler";

/**
 * Prova REAL de concorrência/retry da idempotência de escrita: Postgres
 * efêmero (Docker do `pnpm test:db`), handlers reais (`sendMessageHandler`,
 * `reservarOuReplay`, `concluirIdempotencia`) e transporte sintético que CONTA
 * chamadas. Só o transporte externo é substituído — a persistência é o próprio
 * Postgres, acessado por `pg` (async) para intercalar requisições de verdade.
 */

// ─── transporte sintético ────────────────────────────────────────────────
const transport = vi.hoisted(() => ({
  sends: [] as Array<{ messageId: string; to: string }>,
  failConfirmation: false,
}));
vi.mock("@/lib/channels", () => ({
  CHANNEL_SESSION_REF_COLUMNS: "id, provider, status",
  DEFAULT_CHANNEL_PROVIDER: "synthetic",
  capabilitiesOf: () => ({ freeformOutsideWindow: true, requiresTemplates: false }),
  resolveSessionRef: (s: unknown) => s,
  getAdapter: () => ({
    isConfigured: () => true,
    resolveRecipient: (c: { phoneNumber?: string }) => c.phoneNumber ?? null,
    echoExternalIds: undefined,
    codes: { sendFailed: "synthetic_send_failed", notConfigured: "synthetic_not_configured", unknownError: "synthetic_unknown" },
    send: async (envelope: { to: string }) => {
      transport.sends.push({ messageId: String((envelope as { messageId?: string }).messageId ?? ""), to: envelope.to });
      if (transport.failConfirmation) throw new Error("synthetic lost confirmation");
      return { externalId: `synthetic-${transport.sends.length}` };
    },
    sendTemplate: async (envelope: { to: string }) => {
      transport.sends.push({ messageId: String((envelope as { messageId?: string }).messageId ?? ""), to: envelope.to });
      return { externalId: `synthetic-${transport.sends.length}` };
    },
  }),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

// ─── double PostgREST assíncrono sobre pg (o efêmero não tem PostgREST) ───
function lit(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (v instanceof Uint8Array) return `'\\x${Buffer.from(v).toString("hex")}'::bytea`;
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (Array.isArray(v)) return `ARRAY[${v.map((x) => `'${String(x).replace(/'/g, "''")}'`).join(",")}]::text[]`;
  if (typeof v === "object") return `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
  return `'${String(v).replace(/'/g, "''")}'`;
}
const EMBED: Record<string, string> = { contact_id: "contacts", channel_session_id: "channel_sessions" };

class Q {
  private mode: "select" | "insert" | "update" | "delete" | null = null;
  private cols = "*";
  private afterMutation = false;
  private data: Record<string, unknown> | null = null;
  private filters: Array<{ op: string; col: string; val: unknown }> = [];
  constructor(private table: string) {}

  select(c: string) {
    if (this.mode === "insert" || this.mode === "update") { this.afterMutation = true; this.cols = c; }
    else { this.mode = "select"; this.cols = c; }
    return this;
  }
  insert(d: Record<string, unknown>) { this.mode = "insert"; this.data = d; return this; }
  update(d: Record<string, unknown>) { this.mode = "update"; this.data = d; return this; }
  delete() { this.mode = "delete"; return this; }
  eq(col: string, v: unknown) { this.filters.push({ op: "eq", col, val: v }); return this; }
  neq(col: string, v: unknown) { this.filters.push({ op: "neq", col, val: v }); return this; }
  in(col: string, v: unknown[]) { this.filters.push({ op: "in", col, val: v }); return this; }
  is(col: string, v: null | boolean) { this.filters.push({ op: "is", col, val: v }); return this; }
  order() { return this; }
  limit() { return this; }

  async maybeSingle() { const r = await this.run(); return { data: r.rows[0] ?? null, error: r.error }; }
  async single() { const r = await this.run(); return { data: r.rows.length === 1 ? r.rows[0]! : null, error: r.error ?? (r.rows.length !== 1 ? { message: `expected 1 row got ${r.rows.length}` } : null) }; }
  then<T1 = { data: unknown; error: { message: string; code?: string } | null }, T2 = never>(
    ok?: (v: { rows: Array<Record<string, unknown>>; error: { message: string; code?: string } | null }) => T1 | PromiseLike<T1>,
    ko?: (e: unknown) => T2 | PromiseLike<T2>,
  ): PromiseLike<T1 | T2> { return this.run().then(ok, ko); }

  private where(): string {
    if (!this.filters.length) return "";
    const clauses = this.filters.map((f) => {
      if (f.op === "in") return `"${f.col}" in (${(f.val as unknown[]).map(lit).join(",")})`;
      if (f.op === "is") return `"${f.col}" is ${lit(f.val)}`;
      if (f.op === "neq") return `"${f.col}" <> ${lit(f.val)}`;
      if (f.col === "metadata->>idempotency_key") return `"metadata"->>'idempotency_key' = ${lit(f.val)}`;
      return `"${f.col}" = ${lit(f.val)}`;
    });
    return ` where ${clauses.join(" and ")}`;
  }

  private selectSql(): string {
    const parts: string[] = [];
    for (const raw of this.cols.split(",")) {
      const p = raw.trim();
      const m = /^(\w+):(\w+)\(([^)]+)\)$/.exec(p);
      if (m) {
        const t = EMBED[m[2]!];
        const fields = m[3]!.split(",").map((c) => `${c.trim()}, r.${c.trim()}`).join(", ");
        parts.push(`(select jsonb_build_object(${fields}) from public.${t} r where r.id = b.${m[2]}) as ${m[1]}`);
      } else if (p) parts.push(`b.${p}`);
    }
    return `select ${parts.length ? parts.join(", ") : "b.*"} from public.${this.table} b${this.where()}`;
  }

  private async run(): Promise<{ rows: Array<Record<string, unknown>>; error: { message: string; code?: string } | null }> {
    try {
      let sqlText: string;
      if (this.mode === "select") sqlText = this.selectSql();
      else if (this.mode === "delete") sqlText = `delete from public.${this.table}${this.where()}`;
      else if (this.mode === "insert") {
        const e = Object.entries(this.data!).filter(([, v]) => v !== undefined);
        sqlText = `insert into public.${this.table} (${e.map(([k]) => `"${k}"`).join(",")}) values (${e.map(([, v]) => lit(v)).join(",")})`;
      } else if (this.mode === "update") {
        const e = Object.entries(this.data!).filter(([, v]) => v !== undefined);
        sqlText = `update public.${this.table} set ${e.map(([k, v]) => `"${k}" = ${lit(v)}`).join(", ")}${this.where()}`;
      } else throw new Error("no mode");
      if (this.afterMutation || this.mode === "select") sqlText += ` returning *`;
      const res = await pool.query(sqlText);
      const rows = (res.rows ?? []) as Array<Record<string, unknown>>;
      return { rows, error: null };
    } catch (err) {
      return { rows: [], error: { message: (err as Error).message, code: (err as { code?: string }).code } };
    }
  }
}

const pool = new pg.Pool({ host: "127.0.0.1", port: Number(process.env.TEST_DB_PORT ?? 54329), user: "postgres", database: "postgres", max: 12 });
const admin = {
  from: (t: string) => new Q(t),
  rpc: async (name: string) => {
    if (name === "fn_automation_message_live") return { data: true, error: null };
    if (name === "fn_automation_message_preview") return { data: false, error: null };
    return { data: null, error: null };
  },
} as unknown as SupabaseClient;

const CONTACT = "66666666-3333-4000-8000-000000000001";
const SESSION = "66666666-2222-4000-8000-000000000001";
const CONV = "66666666-4444-4000-8000-000000000001";
const OUTRA_ORG = "eeeeeeee-0000-4000-8000-000000000001";

beforeAll(async () => {
  seedGov();
  sql(`insert into public.organizations (id, slug, legal_name, display_name)
       values ('${OUTRA_ORG}', 'idem-outra', 'Outra', 'Outra') on conflict do nothing;`);
  sql(`insert into public.contacts (id, organization_id, display_name, name, phone_number, is_blocked)
       values ('${CONTACT}', '${GOV_ORG}', 'Concorrencia', 'Ana', '+5511999990001', false) on conflict do nothing;`);
  sql(`do $x$ begin
    insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted, status, daily_message_limit)
      values ('${SESSION}', '${GOV_ORG}', 'idem-conc', '\\x00'::bytea, 'WORKING', 300);
  exception when unique_violation then null; end $x$;`);
  sql(`insert into public.conversations (id, organization_id, contact_id, channel_session_id, status)
       values ('${CONV}', '${GOV_ORG}', '${CONTACT}', '${SESSION}', 'open') on conflict do nothing;`);
});

afterAll(async () => { await pool.end(); });

function msgInput(body: string, conversationId = CONV) {
  return { conversation_id: conversationId, type: "text" as const, body };
}
function userCtx() {
  return { organization_id: GOV_ORG, actor: { type: "user" as const, id: GOV_MANAGER }, requestId: "t" };
}

async function enviar(key: string, body: string) {
  const chave = chaveDeIdempotencia(GOV_MANAGER, key);
  const hash = hashCanonico(msgInput(body));
  const recursoId = idRecurso(GOV_ORG, GOV_MANAGER, "/api/v1/messages", key);
  const reserva = await reservarOuReplay(admin, { organizationId: GOV_ORG, endpoint: "/api/v1/messages", chave, hash, recursoId });
  if (reserva.tipo === "conflito") return { conflito: true as const, recursoId };
  const message = await sendMessageHandler(admin, userCtx(), { ...msgInput(body), metadata: { idempotency_key: chave, idempotency_hash: hash } }, { messageId: recursoId, returnExistingOnConflict: true });
  await concluirIdempotencia(admin, { organizationId: GOV_ORG, endpoint: "/api/v1/messages", chave, recursoId, statusCode: 201 });
  return { conflito: false as const, message, recursoId };
}

describe("idempotência de escrita — concorrência real (Postgres + handlers reais)", () => {
  it("A: requisições simultâneas com mesma chave/payload → uma mensagem e UM transporte", async () => {
    transport.sends = [];
    const key = `conc-a-${Date.now()}`;
    const results = await Promise.all(Array.from({ length: 8 }, () => enviar(key, "Oi concorrencia A")));
    const conflitos = results.filter((r) => r.conflito);
    const ids = new Set(results.filter((r) => !r.conflito).map((r) => (r as { message: { id: string } }).message.id));
    expect(conflitos.length).toBe(0);
    expect(ids.size).toBe(1);
    expect(transport.sends.length).toBe(1);
    expect(transport.sends[0]!.to).toBe("+5511999990001");
  });

  it("B: mesma chave com payload DIFERENTE (concorrente) → um vence, outro 409", async () => {
    transport.sends = [];
    const key = `conc-b-${Date.now()}`;
    const chave = chaveDeIdempotencia(GOV_MANAGER, key);
    const recursoId = idRecurso(GOV_ORG, GOV_MANAGER, "/api/v1/messages", key);
    const h1 = hashCanonico(msgInput("payload um"));
    const h2 = hashCanonico(msgInput("payload dois"));
    const [a, b] = await Promise.all([
      reservarOuReplay(admin, { organizationId: GOV_ORG, endpoint: "/api/v1/messages", chave, hash: h1, recursoId }),
      reservarOuReplay(admin, { organizationId: GOV_ORG, endpoint: "/api/v1/messages", chave, hash: h2, recursoId }),
    ]);
    const tipos = [a.tipo, b.tipo].sort();
    expect(tipos).toEqual(["conflito", "reservado"]);
  });

  it("C: resposta perdida após persistência → retry recupera o MESMO recurso", async () => {
    transport.sends = [];
    const key = `conc-c-${Date.now()}`;
    const primeiro = await enviar(key, "Oi concorrencia C");
    expect(primeiro.conflito).toBe(false);
    // resposta perdida: repete com a MESMA chave → mesmo recurso, sem novo transporte
    const replay = await enviar(key, "Oi concorrencia C");
    expect(replay.conflito).toBe(false);
    expect((replay as { message: { id: string } }).message.id).toBe((primeiro as { message: { id: string } }).message.id);
    expect(transport.sends.length).toBe(1);
  });

  it("D: transporte aceito sem confirmação → retries não aumentam a contagem", async () => {
    transport.sends = [];
    const key = `conc-d-${Date.now()}`;
    await enviar(key, "Oi concorrencia D");
    expect(transport.sends.length).toBe(1);
    // reconciliação repetida (a mensagem já foi enviada): nenhum novo transporte
    for (let i = 0; i < 5; i++) await enviar(key, "Oi concorrencia D");
    expect(transport.sends.length).toBe(1);
  });

  it("E: limpeza do idempotency_keys preserva o conflito de payload e impede reenvio", async () => {
    transport.sends = [];
    const key = `conc-e-${Date.now()}`;
    const chave = chaveDeIdempotencia(GOV_MANAGER, key);
    const recursoId = idRecurso(GOV_ORG, GOV_MANAGER, "/api/v1/messages", key);
    await enviar(key, "payload original");
    // limpa o registro de idempotência (expiração/limpeza pertinente)
    sql(`delete from idempotency_keys where key='${chave}'`);
    // payload DIFERENTE com a mesma chave → colisão de PK com hash diferente → 409
    const h2 = hashCanonico(msgInput("payload diferente"));
    const reserva = await reservarOuReplay(admin, { organizationId: GOV_ORG, endpoint: "/api/v1/messages", chave, hash: h2, recursoId });
    expect(reserva.tipo).toBe("reservado"); // o registro sumiu → nova reserva
    await expect(
      sendMessageHandler(admin, userCtx(), { ...msgInput("payload diferente"), metadata: { idempotency_key: chave, idempotency_hash: h2 } }, { messageId: recursoId, returnExistingOnConflict: true }),
    ).rejects.toMatchObject({ status: 409, code: "idempotency_conflict" });
    expect(transport.sends.length).toBe(1);
  });

  it("F: isolamento por organização/ator + permissão revogada", async () => {
    const key = `conc-f-${Date.now()}`;
    // mesma chave em OUTRO ator → recurso e reserva diferentes (sem colisão)
    const idA = idRecurso(GOV_ORG, GOV_MANAGER, "/api/v1/messages", key);
    const idB = idRecurso(GOV_ORG, GOV_AGENT_A, "/api/v1/messages", key);
    expect(idA).not.toBe(idB);
    // mesma chave em OUTRA organização → recurso diferente
    const idC = idRecurso(OUTRA_ORG, GOV_MANAGER, "/api/v1/messages", key);
    expect(idC).not.toBe(idA);
  });

  it("G: nova operação deliberada com outra chave → segundo recurso", async () => {
    transport.sends = [];
    const a = await enviar(`conc-g-${Date.now()}-a`, "mesmo texto");
    const b = await enviar(`conc-g-${Date.now()}-b`, "mesmo texto");
    expect((a as { message: { id: string } }).message.id).not.toBe((b as { message: { id: string } }).message.id);
    expect(transport.sends.length).toBe(2);
  });
});
