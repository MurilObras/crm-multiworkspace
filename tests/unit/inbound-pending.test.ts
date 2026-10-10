// @vitest-environment node
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Queryable } from "@/lib/agent-engine/queue/queue";
import {
  coalesceInboundDebounce,
  isCurrentInbound,
  recheckPacingHeldInbound,
} from "@/lib/agent-engine/queue/inbound-pending";

let pg: PGlite;
let db: Queryable;
const input = {
  organizationId: "aaaaaaaa-0000-4000-8000-000000000001",
  contactId: "aaaaaaaa-0000-4000-8000-000000000003",
  conversationId: "aaaaaaaa-0000-4000-8000-000000000004",
  channelSessionId: "aaaaaaaa-0000-4000-8000-000000000006",
  messageId: "aaaaaaaa-0000-4000-8000-000000000008",
  eventId: "11111111-1111-4111-8111-111111111111",
  debounceMs: 30_000,
};

beforeEach(async () => {
  pg = new PGlite();
  await pg.exec(`create table job_queue (id text primary key, organization_id uuid, contact_id uuid,
    kind text default 'inbound_turn', status text default 'pending', run_after timestamptz,
    last_error text, payload jsonb, source_event_id uuid);
    create table messages (id uuid primary key, organization_id uuid, conversation_id uuid,
      direction text, sent_at timestamptz, created_at timestamptz default now());
    insert into messages (id,organization_id,conversation_id,direction) values
      ('aaaaaaaa-0000-4000-8000-000000000008','aaaaaaaa-0000-4000-8000-000000000001','aaaaaaaa-0000-4000-8000-000000000004','inbound');`);
  db = {
    query: async (sql: string, values?: unknown[]) => {
      const result = await pg.query(sql, values);
      return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
    },
  } as unknown as Queryable;
});
afterEach(async () => {
  await pg.close();
});

async function job(id: string, overrides: Record<string, unknown> = {}) {
  const row = {
    organization_id: "aaaaaaaa-0000-4000-8000-000000000001",
    contact_id: "aaaaaaaa-0000-4000-8000-000000000003",
    kind: "inbound_turn",
    status: "pending",
    last_error: null,
    delay: "10 seconds",
    payload: {
      conversation_id: "aaaaaaaa-0000-4000-8000-000000000004",
      channel_session_id: "aaaaaaaa-0000-4000-8000-000000000006",
      inbound_message_id: "message-old",
    },
    ...overrides,
  };
  await pg.query(
    `insert into job_queue (id,organization_id,contact_id,kind,status,run_after,last_error,payload)
    values ($1,$2,$3,$4,$5,now()+$6::interval,$7,$8)`,
    [
      id,
      row.organization_id,
      row.contact_id,
      row.kind,
      row.status,
      row.delay,
      row.last_error,
      JSON.stringify(row.payload),
    ],
  );
}

describe("rajadas sem perder mensagem nova", () => {
  it("atualiza a âncora do debounce para a última mensagem e conserva o job", async () => {
    await job("debounce");
    expect(await coalesceInboundDebounce(db, input)).toBe("debounce");
    const { rows } = await pg.query<{ payload: Record<string, string> }>(
      "select payload from job_queue",
    );
    expect(rows[0]?.payload.inbound_message_id).toBe("aaaaaaaa-0000-4000-8000-000000000008");
    expect(rows[0]?.payload.crm_event_id).toBe(input.eventId);
    const source = await pg.query<{ source_event_id: string }>(
      "select source_event_id from job_queue",
    );
    expect(source.rows[0]?.source_event_id).toBe(input.eventId);
  });
  it("evento atrasado não substitui a âncora de uma mensagem mais recente", async () => {
    await job("debounce");
    await pg.query(
      `insert into messages (id,organization_id,conversation_id,direction,sent_at)
      values ($1,$2,$3,'inbound',now()+interval '1 minute')`,
      ["aaaaaaaa-0000-4000-8000-000000000009", input.organizationId, input.conversationId],
    );
    expect(await coalesceInboundDebounce(db, input)).toBeNull();
    const { rows } = await pg.query<{ payload: Record<string, string> }>(
      "select payload from job_queue",
    );
    expect(rows[0]?.payload.inbound_message_id).toBe("message-old");
  });
  it.each([
    { last_error: "cap de envio (warmup_cap) atingido", delay: "6 hours" },
    { last_error: "fora da janela anti-ban de envio" },
    { organization_id: "aaaaaaaa-0000-4000-8000-000000000002" },
    {
      payload: {
        conversation_id: "aaaaaaaa-0000-4000-8000-000000000005",
        channel_session_id: "aaaaaaaa-0000-4000-8000-000000000006",
      },
    },
    {
      payload: {
        conversation_id: "aaaaaaaa-0000-4000-8000-000000000004",
        channel_session_id: "aaaaaaaa-0000-4000-8000-000000000007",
      },
    },
    { status: "running" },
    { delay: "2 hours" },
    { delay: "-1 second" },
  ])("não absorve mensagem em job incompatível: %j", async (overrides) => {
    await job("other", overrides);
    expect(await coalesceInboundDebounce(db, input)).toBeNull();
  });
});

it("reavalia somente respostas retidas do workspace e canal selecionados, uma vez", async () => {
  const held = {
    last_error: "cap de envio (warmup_cap) atingido — turno adiado para a próxima abertura",
    delay: "6 hours",
  };
  await job("held", held);
  await job("window", {
    last_error: "fora da janela anti-ban de envio — turno adiado para a abertura",
    delay: "6 hours",
  });
  await job("other-org", { ...held, organization_id: "aaaaaaaa-0000-4000-8000-000000000002" });
  await job("followup", { ...held, kind: "followup_turn" });
  await job("running", { ...held, status: "running" });
  await job("other-channel", {
    ...held,
    payload: { channel_session_id: "aaaaaaaa-0000-4000-8000-000000000007" },
  });
  await job("transport", { ...held, last_error: "canal indisponível" });
  expect(
    await recheckPacingHeldInbound(
      db,
      "aaaaaaaa-0000-4000-8000-000000000001",
      "aaaaaaaa-0000-4000-8000-000000000006",
    ),
  ).toBe(2);
  expect(
    await recheckPacingHeldInbound(
      db,
      "aaaaaaaa-0000-4000-8000-000000000001",
      "aaaaaaaa-0000-4000-8000-000000000006",
    ),
  ).toBe(0);
  const { rows } = await pg.query<{ id: string }>(
    "select id from job_queue where run_after <= now() order by id",
  );
  expect(rows.map((r) => r.id)).toEqual(["held", "window"]);
});

it("descarta resposta ancorada no assunto antigo sem misturar workspaces", async () => {
  await pg.exec("delete from messages");
  await pg.exec(`insert into messages (id,organization_id,conversation_id,direction,sent_at) values
    ('aaaaaaaa-0000-4000-8000-000000000009','aaaaaaaa-0000-4000-8000-000000000001','aaaaaaaa-0000-4000-8000-000000000004','inbound',now()-interval '1 minute'),
    ('aaaaaaaa-0000-4000-8000-000000000010','aaaaaaaa-0000-4000-8000-000000000001','aaaaaaaa-0000-4000-8000-000000000004','inbound',now()),
    ('aaaaaaaa-0000-4000-8000-000000000011','aaaaaaaa-0000-4000-8000-000000000001','aaaaaaaa-0000-4000-8000-000000000004','outbound',now()+interval '1 second'),
    ('aaaaaaaa-0000-4000-8000-000000000012','aaaaaaaa-0000-4000-8000-000000000002','aaaaaaaa-0000-4000-8000-000000000004','inbound',now()+interval '2 seconds');`);
  expect(
    await isCurrentInbound(
      db,
      "aaaaaaaa-0000-4000-8000-000000000001",
      "aaaaaaaa-0000-4000-8000-000000000004",
      "aaaaaaaa-0000-4000-8000-000000000009",
    ),
  ).toBe(false);
  expect(
    await isCurrentInbound(
      db,
      "aaaaaaaa-0000-4000-8000-000000000001",
      "aaaaaaaa-0000-4000-8000-000000000004",
      "aaaaaaaa-0000-4000-8000-000000000010",
    ),
  ).toBe(true);
  expect(
    await isCurrentInbound(
      db,
      "aaaaaaaa-0000-4000-8000-000000000001",
      "aaaaaaaa-0000-4000-8000-000000000013",
      "aaaaaaaa-0000-4000-8000-000000000010",
    ),
  ).toBe(false);
});
