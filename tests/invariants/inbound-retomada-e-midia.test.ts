import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { OutboundApprovalRevokedError } from '@/lib/channels/delivery-error';

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
  media?: { type: string; url?: string; audio_id?: string; agent_id?: string };
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

function montaHandler(doGenerate: unknown, maxSendsPerTurn?: number, onSend?: (input: EnvioCapturado) => void) {
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
          onSend?.(i);
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
  it.each([false, true])('áudio aprovado exige contexto, não repete e retoma em texto se revogado (%s)', async revoked => {
    const agent = 'eeeeeeee-0000-4000-8000-000000000070';
    const version = 'eeeeeeee-0000-4000-8000-000000000071';
    const audioId = 'eeeeeeee-0000-4000-8000-000000000072';
    const audio = { id: audioId, title: 'Apresentação aprovada', use_when: 'Quando perguntar como funciona o aplicativo',
      mime: 'audio/ogg', size_bytes: 17, enabled: true, storage_path: `${ORG}/agent-audios/${agent}/${audioId}.ogg` };
    await pool.query(`insert into ai_agents(id,organization_id,name,system_prompt,kind,config)
      values($1,$2,'Agente de áudio','Atende com gravações aprovadas','mcp_agent',$3)
      on conflict(id) do update set config=excluded.config,archived_at=null`, [agent, ORG, JSON.stringify({ approved_audios: [audio] })]);
    await pool.query(`insert into ai_agent_versions(id,organization_id,agent_id,version_number,system_prompt,provider,model,channel_session_id,status,max_steps)
      values($1,$2,$3,1,'Use gravação somente quando ajudar.','anthropic','claude-sonnet-4-6',$4,'published',12) on conflict do nothing`, [version, ORG, agent, SESSION]);
    await pool.query('update ai_agents set published_version_id=$1 where id=$2', [version, agent]);
    const inputs = [
      { body: 'Título', media: { type: 'audio', audio_id: audioId } },
      { body: 'Preparei uma apresentação curta do aplicativo para você.' },
      { body: 'Legenda que não deve ser enviada', media: { type: 'audio', audio_id: audioId } },
      { body: 'Repetição', media: { type: 'audio', audio_id: audioId } },
      { body: 'Forjado', media: { type: 'audio', audio_id: MSG } },
      ...(revoked ? [{ body: 'Posso explicar por texto: o aplicativo ajuda a organizar suas obras.' }] : []),
    ];
    let step = 0;
    try {
      const error = await rodaTurno(montaHandler(async (opts: { prompt?: unknown }) => {
        resultadosVistos.push(opts.prompt);
        const input = inputs[step++];
        return { content: input ? [{ type: 'tool-call', toolCallId: `audio-step-${step}`, toolName: 'send_message', input: JSON.stringify(input) }]
          : [{ type: 'text', text: CHECKPOINT }], finishReason: { unified: input ? 'tool-calls' : 'stop', raw: undefined }, usage: USO, warnings: [] };
      }, 4, revoked ? i => { if (i.media?.type === 'audio') throw new OutboundApprovalRevokedError(); } : undefined));
      expect(error).toBeNull(); expect(enviados).toHaveLength(2);
      expect(enviados[0]?.media).toBeUndefined();
      if (revoked) expect(enviados[1]?.media).toBeUndefined();
      else expect(enviados[1]).toMatchObject({ body: audio.title, media: { type: 'audio', audio_id: audioId, agent_id: agent } });
      const observed = JSON.stringify(resultadosVistos);
      expect(observed).toContain('audio_not_ready'); expect(observed).toContain('audio_not_approved');
      if (revoked) expect(observed).toContain('audio_approval_revoked');
      expect(observed).toContain('ÁUDIOS PRÉ-GRAVADOS APROVADOS'); expect(observed).not.toContain(audio.storage_path);
    } finally {
      await pool.query('update ai_agents set archived_at=now(),published_version_id=null where id=$1', [agent]);
    }
  });
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

it.each([false, true])(
  "dispensa ferramentas mutantes e encerra o loop (mesmo step: %s)",
  async (sameStep) => {
    let calls = 0;
    const marker = "acao_que_nao_pode_sobreviver_ao_turno";
    const model = async () => {
      const step = calls++;
      const send = {
        type: "tool-call" as const,
        toolCallId: "send-superseded",
        toolName: "send_message",
        input: JSON.stringify({ body: "Resposta antiga" }),
      };
      const update = {
        type: "tool-call" as const,
        toolCallId: "update-superseded",
        toolName: "update_lead_state",
        input: JSON.stringify({ next_action: marker }),
      };
      if (step === 0) await novaMensagem();
      if (step < 2)
        return {
          content: step === 0 ? (sameStep ? [send, update] : [send]) : [update],
          finishReason: { unified: "tool-calls" as const, raw: undefined },
          usage: USO,
          warnings: [],
        };
      return {
        content: [{ type: "text" as const, text: CHECKPOINT }],
        finishReason: { unified: "stop" as const, raw: undefined },
        usage: USO,
        warnings: [],
      };
    };
    try {
      const error = await rodaTurno(montaHandler(model));
      expect(error?.constructor.name).toBe("JobSettledError");
      expect(calls).toBe(1); // Sem outro step nem chamada de checkpoint.
      expect(enviados).toHaveLength(0);
      const state = (
        await pool.query(
          "select next_action from lead_state where organization_id=$1 and contact_id=$2",
          [ORG, CONTACT],
        )
      ).rows[0];
      expect(state?.next_action).not.toBe(marker);
      expect(
        (
          await pool.query(
            "select status from job_queue where organization_id=$1 and kind='inbound_turn' order by created_at desc limit 1",
            [ORG],
          )
        ).rows[0]?.status,
      ).toBe("done");
    } finally {
      await pool.query("delete from messages where organization_id=$1 and id=$2", [ORG, NEW_MSG]);
    }
  },
);

it.each([false, true])(
  "encerra envio retido por sessão offline antes de concluir inbound superada (durante modelo: %s)",
  async (duringModel) => {
    const workerId = "retry-offline-superado";
    const messageId = randomUUID(); // Protocolo real: messages.id = send_ledger.id.
    await pool.query("update job_queue set status='done' where status='pending'");
    const { job } = await m.queue.enqueueJob(pool, ORG, {
      kind: "inbound_turn", leadId: CONTACT,
      payload: { conversation_id: CONV, contact_id: CONTACT,
        channel_session_id: SESSION, inbound_message_id: MSG, crm_event_id: randomUUID() },
      maxAttempts: 3,
    });
    const [claimed] = await m.queue.claimJobs(pool, { workerId, maxConcurrency: 1 });
    expect(claimed?.id).toBe(job.id);
    await pool.query(`insert into messages
      (id,organization_id,conversation_id,channel_session_id,contact_id,type,direction,status,body,sent_via,sent_at,metadata)
      values ($1,$2,$3,$4,$5,'text','outbound','queued','Resposta antiga','ai',now(),$6::jsonb)`,
      [messageId, ORG, CONV, SESSION, CONTACT, JSON.stringify({
        idempotency_key: messageId, queued_reason: "channel_session_not_working",
        outbound_attempt: { phase: "prepared", input: { conversation_id: CONV, type: "text", body: "Resposta antiga" } },
      })]);
    await pool.query(`insert into send_ledger
      (id,organization_id,contact_id,job_id,seq,body_hash,status,crm_message_id)
      values ($1,$2,$3,$4,1,'fixture-hash','queued',$1)`, [messageId, ORG, CONTACT, job.id]);
    await m.queue.rescheduleJob(pool, job.id, workerId, {
      delayMs: 0, reason: "sessão do canal fora (resposta queued) — reagendado sem consumir attempts",
    });
    try {
      if (!duringModel) await novaMensagem();
      const [retry] = await m.queue.claimJobs(pool, { workerId, maxConcurrency: 1 });
      expect(retry?.id).toBe(job.id);
      let calls = 0;
      const model = modeloDeEnvio(novaMensagem);
      const handler = montaHandler(async () => { calls++; return model({}); });
      if (duringModel) {
        await expect(handler(retry!, pool, { workerId })).rejects.toMatchObject({ name: "job_settled" });
      } else {
        await handler(retry!, pool, { workerId });
        await m.queue.completeJob(pool, job.id, workerId);
      }
      expect(calls).toBe(duringModel ? 1 : 0);
      expect(enviados).toHaveLength(0);
      const state = (await pool.query(`select j.status job_status,m.status message_status,
        m.error_code,m.metadata->'outbound_attempt' attempt,l.status ledger_status,l.last_error
        from job_queue j join send_ledger l on l.job_id=j.id
        join messages m on m.id=l.crm_message_id where j.id=$1`, [job.id])).rows[0];
      expect(state).toMatchObject({ job_status: "done", message_status: "failed", ledger_status: "vetoed",
        error_code: "inbound_superseded", last_error: "inbound_superseded",
        attempt: { phase: "rejected", retryable: false, input: { body: "Resposta antiga" } } });
    } finally {
      await pool.query("delete from messages where organization_id=$1 and id=$2", [ORG, NEW_MSG]);
    }
  },
);
