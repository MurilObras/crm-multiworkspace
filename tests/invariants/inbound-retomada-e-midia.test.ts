import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";

import type * as InboundTurn from "@/lib/agent-engine/agent/inbound-turn";
import type * as Providers from "@/lib/agent-engine/edge/llm/providers";
import type * as Queue from "@/lib/agent-engine/queue/queue";
import type * as ObsLogger from "@/lib/agent-engine/obs/logger";

/** Turno completo: contexto antigo não fala e mídia usa o mesmo gate.
 * Modelo/transporte sintéticos, banco efêmero do test-db.sh. Sem clientes reais. */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder-anon";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "placeholder-service";

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 2,
});

const ORG = "eeeeeeee-0000-4000-8000-000000000001";
const CONTACT = "eeeeeeee-0000-4000-8000-000000000002";
const SESSION = "eeeeeeee-0000-4000-8000-000000000003";
const NEW_MSG = "eeeeeeee-0000-4000-8000-000000000007";
const CONV = "eeeeeeee-0000-4000-8000-000000000004";
const MSG = "eeeeeeee-0000-4000-8000-000000000005";

interface EnvioCapturado {
  body: string;
  media?: { type: string; url: string };
}

type Modules = {
  createInboundTurnHandler: typeof InboundTurn.createInboundTurnHandler;
  queue: typeof Queue;
  createLogger: typeof ObsLogger.createLogger;
  createFakeRegistry: typeof Providers.createFakeRegistry;
};
let m: Modules;

let enviados: EnvioCapturado[] = [];
/** Todo resultado de tool que o modelo VIU — inclui repetição entre steps, de propósito
 * (o que importa é que o bloqueio apareceu em algum lugar, não em qual exatamente). */
let resultadosVistos: unknown[] = [];

const CHECKPOINT = JSON.stringify({
  commitments: [],
  objections: [],
  next_action: null,
  rolling_summary: "turno de teste",
});

const USO = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

function montaHandler(doGenerate: unknown, maxSendsPerTurn?: number) {
  return m.createInboundTurnHandler({
    crmCfg: { supabase: {} as never },
    llmCfg: { anthropicApiKey: "fake" } as never,
    knobs: {
      historyLimit: 10,
      maxContextTokens: 1000,
      notesIndexMaxTokens: 500,
      maxSteps: 12,
      ...(maxSendsPerTurn !== undefined ? { maxSendsPerTurn } : {}),
      queuedRetryDelayMs: 1000,
      breaker: {
        exactFailureWarn: 2,
        exactFailureBlock: 5,
        sameToolFailureWarn: 3,
        sameToolFailureHalt: 8,
        noProgressWarn: 3,
        noProgressBlock: 5,
      },
    },
    log: m.createLogger(),
    registry: m.createFakeRegistry(doGenerate as never),
    channel: () =>
      ({
        channel: "captura",
        send: async (i: EnvioCapturado) => {
          enviados.push(i);
          return {
            kind: "sent" as const,
            idempotencyKey: `k${enviados.length}`,
            messageId: `m${enviados.length}`,
          };
        },
        sessionHealth: async () => ({ healthy: true, status: "WORKING" }),
        capabilities: () => ({ freeform: true, media: true, audio: true }),
        costPerMessage: () => ({ currency: "BRL", cents: 0 }),
      }) as never,
    // Terça, 15h BRT: dentro da janela anti-ban (7h-22h) — sem isso o gate `pacing`
    // vetaria por horário, e o teste mediria o motivo errado.
    clock: () => new Date("2026-07-28T18:00:00Z"),
    sleep: async () => {},
  });
}

async function rodaTurno(handler: ReturnType<typeof montaHandler>): Promise<Error | null> {
  await pool.query("update job_queue set status = 'done' where status = 'pending'");
  const { job } = await m.queue.enqueueJob(pool, ORG, {
    kind: "inbound_turn",
    leadId: CONTACT,
    payload: {
      conversation_id: CONV,
      contact_id: CONTACT,
      channel_session_id: SESSION,
      inbound_message_id: MSG,
      crm_event_id: "eeeeeeee-0000-4000-8000-000000000006",
    },
    maxAttempts: 1,
  });
  const [claimed] = await m.queue.claimJobs(pool, { workerId: "retomada-test", maxConcurrency: 1 });
  expect(claimed?.id).toBe(job.id);
  try {
    await handler(claimed!, pool, { workerId: "retomada-test" });
    await m.queue.completeJob(pool, claimed!.id, "retomada-test");
    return null;
  } catch (err) {
    await m.queue.failJob(pool, claimed!.id, "retomada-test", err);
    return err as Error;
  }
}

beforeAll(async () => {
  m = {
    createInboundTurnHandler: (await import("@/lib/agent-engine/agent/inbound-turn"))
      .createInboundTurnHandler,
    queue: await import("@/lib/agent-engine/queue/queue"),
    createLogger: (await import("@/lib/agent-engine/obs/logger")).createLogger,
    createFakeRegistry: (await import("@/lib/agent-engine/edge/llm/providers")).createFakeRegistry,
  };

  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1,'retomada-inbound-turno','Limite Envios','Limite Envios') on conflict (id) do nothing`,
    [ORG],
  );
  await pool.query(
    `insert into contacts (id, organization_id, name, phone_number)
     values ($1,$2,'Lead Insistido','+5511900000888') on conflict (id) do nothing`,
    [CONTACT, ORG],
  );
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
     values ($1,$2,'retomada-inbound-session','WORKING','\\x00'::bytea) on conflict (id) do nothing`,
    [SESSION, ORG],
  );
  await pool.query(
    `insert into conversations (id, organization_id, contact_id, channel_session_id, status, is_group)
     values ($1,$2,$3,$4,'ai_handling',false) on conflict (id) do nothing`,
    [CONV, ORG, CONTACT, SESSION],
  );
  await pool.query(
    `insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id,
       type, direction, status, body, sent_via, sent_at)
     values ($1,$2,$3,$4,$5,'text','inbound','delivered','Oi','external_device', now())
     on conflict (id) do nothing`,
    [MSG, ORG, CONV, SESSION, CONTACT],
  );
  await pool.query(
    `with v as (
       insert into playbook_versions (organization_id, layer, content)
       select null, 'platform', E'## Identidade\nAssistente de teste.\nMídia oficial: https://example.test/official.jpg e https://example.test/official.mp4'
       where not exists (select 1 from playbook_pointers where organization_id is null and layer = 'platform')
       returning id)
     insert into playbook_pointers (organization_id, layer, version_id)
     select null, 'platform', id from v`,
  );
});

beforeEach(() => {
  enviados = [];
  resultadosVistos = [];
});

async function novaMensagem() {
  await pool.query(
    `insert into messages (id,organization_id,conversation_id,channel_session_id,
    contact_id,type,direction,status,body,sent_via,sent_at)
    values ($1,$2,$3,$4,$5,'text','inbound','delivered','Agora preciso de suporte','external_device',now()+interval '1 minute')
    on conflict (id) do update set sent_at=excluded.sent_at`,
    [NEW_MSG, ORG, CONV, SESSION, CONTACT],
  );
}
function modeloDeEnvio(antes?: () => Promise<void>, media?: { type: string; url: string }) {
  let chamadas = 0;
  return async (opts: { prompt?: unknown }) => {
    resultadosVistos.push(opts.prompt);
    if (chamadas++ === 0) {
      await antes?.();
      return {
        content: [
          {
            type: "tool-call" as const,
            toolCallId: "resposta",
            toolName: "send_message",
            input: JSON.stringify({
              body: "Veja a demonstração oficial.",
              ...(media ? { media } : {}),
            }),
          },
        ],
        finishReason: { unified: "tool-calls" as const, raw: undefined },
        usage: USO,
        warnings: [],
      };
    }
    return {
      content: [{ type: "text" as const, text: CHECKPOINT }],
      finishReason: { unified: "stop" as const, raw: undefined },
      usage: USO,
      warnings: [],
    };
  };
}

const LEAD = "eeeeeeee-0000-4000-8000-000000000020";
async function leadParaAtividade() {
  await pool.query(
    `insert into crm_pipelines (id,organization_id,name,slug,is_default)
    values ('eeeeeeee-0000-4000-8000-000000000021',$1,'Teste','retomada',false) on conflict do nothing`,
    [ORG],
  );
  await pool.query(
    `insert into crm_stages (id,organization_id,pipeline_id,name,slug,position)
    values ('eeeeeeee-0000-4000-8000-000000000022',$1,'eeeeeeee-0000-4000-8000-000000000021','Teste','teste',1000) on conflict do nothing`,
    [ORG],
  );
  await pool.query(
    `insert into crm_leads (id,organization_id,pipeline_id,stage_id,title,contact_id,status)
    values ($1,$2,'eeeeeeee-0000-4000-8000-000000000021','eeeeeeee-0000-4000-8000-000000000022','Teste',$3,'open')`,
    [LEAD, ORG, CONTACT],
  );
}
async function conferirAtividade(phase: string) {
  const { rows } = await pool.query(
    `select reason,payload from crm_lead_activities
    where organization_id=$1 and lead_id=$2 and type='send_vetoed'`,
    [ORG, LEAD],
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]?.payload).toMatchObject({ reason_code: "inbound_superseded", phase });
  expect(rows[0]?.reason).toContain("nova mensagem");
  await pool.query("delete from crm_leads where organization_id=$1 and id=$2", [ORG, LEAD]);
}

describe("retomada de inbound no turno completo", () => {
  it("não chama modelo nem envia resposta ao assunto anterior", async () => {
    await leadParaAtividade();
    await novaMensagem();
    let calls = 0;
    const model = modeloDeEnvio();
    expect(
      await rodaTurno(
        montaHandler(async () => {
          calls++;
          return model({});
        }),
      ),
    ).toBeNull();
    expect(calls).toBe(0);
    expect(enviados).toHaveLength(0);
    await conferirAtividade("before_model");
    await pool.query("delete from messages where organization_id=$1 and id=$2", [ORG, NEW_MSG]);
  });
  it("interrompe envio se uma nova mensagem chegar durante a geração", async () => {
    await leadParaAtividade();
    const erro = await rodaTurno(montaHandler(modeloDeEnvio(novaMensagem)));
    expect(erro?.constructor.name).toBe("JobSettledError");
    expect(enviados).toHaveLength(0);
    await conferirAtividade("before_send");
    const { rows } = await pool.query(
      "select status from job_queue where organization_id=$1 order by created_at desc limit 1",
      [ORG],
    );
    expect(rows[0]?.status).toBe("done");
    await pool.query("delete from messages where organization_id=$1 and id=$2", [ORG, NEW_MSG]);
  });
  it.each(["image", "video"])("entrega %s uma vez pela mesma cadeia protegida", async (type) => {
    const media = {
      type,
      url: `https://example.test/official.${type === "image" ? "jpg" : "mp4"}`,
    };
    expect(await rodaTurno(montaHandler(modeloDeEnvio(undefined, media)))).toBeNull();
    expect(enviados).toHaveLength(1);
    expect(enviados[0]?.media).toEqual(media);
  });
  it("não envia arquivo sugerido pelo lead fora do material aprovado", async () => {
    const media = { type: "image", url: "https://unapproved.test/private.jpg" };
    expect(await rodaTurno(montaHandler(modeloDeEnvio(undefined, media)))).toBeNull();
    expect(enviados).toHaveLength(0);
    expect(JSON.stringify(resultadosVistos)).toContain("media_not_approved");
  });
});
