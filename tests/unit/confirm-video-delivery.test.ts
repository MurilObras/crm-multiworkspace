// @vitest-environment node
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import type pg from "pg";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import {
  confirmVideoDelivery,
  VideoConfirmationConflict,
} from "@/lib/channels/confirm-video-delivery";
import { availableConversationAudios } from "@/lib/agent-engine/agent/conversation-audios";
import { pendingAudioSubject } from "@/lib/agent-engine/agent/audio-rule";
import type { ApprovedMedia } from "@/lib/ai/agents/approved-media";

const org = "10000000-0000-4000-8000-000000000001";
const other = "10000000-0000-4000-8000-000000000002";
const original = "20000000-0000-4000-8000-000000000001";
const echo = "20000000-0000-4000-8000-000000000002";
const session = "30000000-0000-4000-8000-000000000001";
const job = "40000000-0000-4000-8000-000000000001";
const contact = "50000000-0000-4000-8000-000000000001";
const conversation = "60000000-0000-4000-8000-000000000001";
let db: PGlite;
let pool: pg.Pool;

beforeEach(async () => {
  db = new PGlite();
  // PostgreSQL real via WASM; sem CRM, WAHA ou dados de produção.
  await db.exec(`create table channel_sessions(id uuid,organization_id uuid,provider text);
    create table job_queue(id uuid,organization_id uuid,status text,locked_by text);
    create table send_ledger(id uuid,organization_id uuid,job_id uuid,crm_message_id uuid,status text,last_error text,updated_at timestamptz);
    create table messages(id uuid primary key,organization_id uuid,conversation_id uuid,contact_id uuid,channel_session_id uuid,
      external_id text,type text,direction text,status text,sent_via text,error_code text,error_message text,
      metadata jsonb,ack integer,created_at timestamptz,sent_at timestamptz,delivered_at timestamptz,read_at timestamptz,
      revoked_at timestamptz,reply_to_message_id uuid,body text,media_derived_text text,unique(organization_id,external_id));
    insert into channel_sessions values('${session}','${org}','waha');
    insert into job_queue values('${job}','${org}','failed',null);
    insert into send_ledger values('${original}','${org}','${job}','${original}','failed','outbound_delivery_uncertain',now());
    insert into messages(id,organization_id,conversation_id,contact_id,channel_session_id,type,direction,status,sent_via,
      error_code,error_message,metadata,created_at,sent_at)
      values('${original}','${org}','${conversation}','${contact}','${session}','video','outbound','failed','ai',
        'outbound_delivery_uncertain','timeout','{"outbound_attempt":{"phase":"uncertain"}}','2026-10-15T19:27:40Z','2026-10-15T19:27:40Z');
    insert into messages(id,organization_id,conversation_id,contact_id,channel_session_id,external_id,type,direction,status,sent_via,
      metadata,created_at,sent_at,ack,delivered_at,read_at)
      values('${echo}','${org}','${conversation}','${contact}','${session}','provider-video','video','outbound','read','external_device',
        '{"fromMe":true}','2026-10-15T19:28:19Z','2026-10-15T19:28:14Z',3,'2026-10-15T19:28:14Z','2026-10-15T19:28:20Z');`);
  const client = {
    query: async (sql: string, values?: unknown[]) => {
      const result = await db.query(sql, values);
      return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
    },
    release: () => {},
  };
  pool = { ...client, connect: async () => client } as unknown as pg.Pool;
});
afterEach(async () => db.close());

describe("confirmação de vídeo recebido", () => {
  it.each(["Pode reenviar o vídeo oficial de demonstração?", "Reenvie aquele vídeo de novo"])(
    "libera %s após confirmar, sem confundir o eco com a mídia aprovada",
    async (request) => {
      const agent = "70000000-0000-4000-8000-000000000001",
        media = "70000000-0000-4000-8000-000000000002";
      const inbound = "70000000-0000-4000-8000-000000000003",
        newJob = "70000000-0000-4000-8000-000000000004";
      await db.query(`update messages set metadata=metadata || $2::jsonb where id=$1`, [
        original,
        JSON.stringify({
          idempotency_key: original,
          approved_media: {
            agent_id: agent,
            media_id: media,
            audio_id: media,
            media_type: "video",
            fingerprint: "a".repeat(64),
            request_inbound_id: "old-request",
          },
        }),
      ]);
      await db.query(
        `insert into messages(id,organization_id,conversation_id,contact_id,type,direction,status,body,metadata,created_at,sent_at)
      values($1,$2,$3,$4,'text','inbound','delivered',$5,'{}','2026-10-15T19:29:00Z','2026-10-15T19:29:00Z')`,
        [inbound, org, conversation, contact, request],
      );
      const approved: ApprovedMedia = {
        id: media,
        type: "video",
        mime: "video/mp4",
        title: "Demonstração",
        enabled: true,
        required: true,
        storage_path: `${org}/agent-media/${agent}/${media}.mp4`,
        size_bytes: 100,
        use_when: "Demonstração visual",
        send_when: "Pedido do vídeo",
        trigger_type: "topic",
        stage_ids: [],
        allow_requested_repeat: true,
        content_sha256: "a".repeat(64),
      };
      expect(
        await availableConversationAudios(
          pool,
          org,
          conversation,
          agent,
          newJob,
          [approved],
          inbound,
          false,
        ),
      ).toEqual([]);
      await confirmVideoDelivery(pool, org, original, echo);
      expect(
        await availableConversationAudios(
          pool,
          org,
          conversation,
          agent,
          newJob,
          [approved],
          inbound,
          false,
        ),
      ).toEqual([approved]);
      await db.query("update messages set body='Como funciona o aplicativo?' where id=$1", [
        inbound,
      ]);
      expect(
        await availableConversationAudios(
          pool,
          org,
          conversation,
          agent,
          newJob,
          [approved],
          inbound,
          false,
        ),
      ).toEqual([]);
    },
  );
  it("eco conciliado não apaga pergunta que chegou antes do webhook atrasado no mesmo segundo", async () => {
    await confirmVideoDelivery(pool, org, original, echo);
    const first = "70000000-0000-4000-8000-000000000005";
    const anchor = "70000000-0000-4000-8000-000000000006";
    const newJob = "70000000-0000-4000-8000-000000000007";
    await db.query(
      `insert into messages(id,organization_id,conversation_id,direction,type,body,created_at,sent_at,metadata)
      values($1,$3,$4,'inbound','text','Qual é o preço?','2026-10-15T19:28:17Z','2026-10-15T19:28:14Z','{}'),
            ($2,$3,$4,'inbound','text','E quais planos vocês têm?','2026-10-15T19:28:20Z','2026-10-15T19:28:20Z','{}')`,
      [first, anchor, org, conversation],
    );
    expect(await pendingAudioSubject(pool, org, conversation, newJob, anchor)).toBe(
      "Qual é o preço?\n\nE quais planos vocês têm?",
    );
  });
  it("reconcilia a entrega, libera reenvio solicitado e preserva as duas linhas para auditoria", async () => {
    await confirmVideoDelivery(pool, org, original, echo);
    const rows = (
      await db.query<{
        id: string;
        status: string;
        external_id: string | null;
        metadata: Record<string, unknown>;
      }>("select id,status,external_id,metadata from messages order by id")
    ).rows;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      id: original,
      status: "read",
      external_id: "provider-video",
      metadata: { outbound_attempt: { phase: "confirmed" }, confirmed_echo_id: echo },
    });
    expect(rows[1]).toMatchObject({
      id: echo,
      external_id: null,
      metadata: { reconciled_into_message_id: original },
    });
    expect((await db.query("select status,last_error from send_ledger")).rows).toEqual([
      { status: "accepted", last_error: null },
    ]);
    expect(await confirmVideoDelivery(pool, org, original, echo)).toMatchObject({ replay: true });
  });
  it("outro workspace não lê nem altera a tentativa", async () => {
    await expect(confirmVideoDelivery(pool, other, original, echo)).rejects.toBeInstanceOf(
      VideoConfirmationConflict,
    );
    expect(
      (await db.query("select external_id from messages where id=$1", [echo])).rows[0],
    ).toMatchObject({ external_id: "provider-video" });
  });
  it.each([
    ["job ainda executando", "update job_queue set status='running',locked_by='worker'"],
    ["fila aguardando retry", "update job_queue set status='pending'"],
    [
      "outra conversa",
      `update messages set conversation_id='70000000-0000-4000-8000-000000000001' where id='${echo}'`,
    ],
    ["outro workspace no eco", `update messages set organization_id='${other}' where id='${echo}'`],
    [
      "outra sessão",
      `update messages set channel_session_id='70000000-0000-4000-8000-000000000001' where id='${echo}'`,
    ],
    [
      "outro contato",
      `update messages set contact_id='70000000-0000-4000-8000-000000000001' where id='${echo}'`,
    ],
    ["arquivo apagado", `update messages set revoked_at=now() where id='${echo}'`],
    ["retorno sem confirmação", `update messages set status='sending' where id='${echo}'`],
    ["retorno antigo", `update messages set sent_at='2026-10-15T19:27:00Z' where id='${echo}'`],
    [
      "fora da janela de confirmação",
      `update messages set sent_at='2026-10-15T19:40:00Z' where id='${echo}'`,
    ],
    [
      "rejeição terminal",
      `update messages set metadata='{"outbound_attempt":{"phase":"rejected"}}' where id='${original}'`,
    ],
  ])("recusa %s sem mudar a mensagem original", async (_name, setup) => {
    await db.exec(setup);
    await expect(confirmVideoDelivery(pool, org, original, echo)).rejects.toBeInstanceOf(
      VideoConfirmationConflict,
    );
    expect(
      (await db.query("select status,external_id from messages where id=$1", [original])).rows[0],
    ).toEqual({ status: "failed", external_id: null });
  });
  it("rollback conserva o eco quando o ledger não permite confirmar", async () => {
    await db.exec("update send_ledger set status='vetoed'");
    await expect(confirmVideoDelivery(pool, org, original, echo)).rejects.toBeInstanceOf(
      VideoConfirmationConflict,
    );
    expect(
      (await db.query("select external_id from messages where id=$1", [echo])).rows[0],
    ).toEqual({ external_id: "provider-video" });
  });
  it("migration aceita custo desconhecido e pode ser reaplicada", async () => {
    await db.exec("create table ai_agent_runs(id integer,cost_cents numeric not null default 0)");
    const migration = readFileSync(
      "supabase/migrations/20261016020000_0233_agent_test_unknown_cost.sql",
      "utf8",
    );
    await db.exec(migration);
    await db.exec(migration);
    await db.exec(
      "insert into ai_agent_runs(id,cost_cents) values(1,null); insert into ai_agent_runs(id) values(2)",
    );
    expect((await db.query("select cost_cents from ai_agent_runs order by id")).rows).toEqual([
      { cost_cents: null },
      { cost_cents: null },
    ]);
  });
});
