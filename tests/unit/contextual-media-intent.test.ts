// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { outboundPostgres, ORG, CONTACT, CONV, JOB } from "../helpers/outbound-postgres";
import { readApprovedMedia, type ApprovedMedia } from "@/lib/ai/agents/approved-media";
import {
  authorizeMediaIntent,
  clearRepeatIntent,
  mediaSubjectHash,
  parseMediaIntent,
} from "@/lib/agent-engine/agent/media-intent";
import {
  availableConversationAudios,
  assertConversationAudioAvailable,
} from "@/lib/agent-engine/agent/conversation-audios";
import {
  loadTurnMediaDecision,
  persistTurnMediaDecision,
} from "@/lib/agent-engine/agent/media-intent-store";
import { readMediaReplayPolicy } from "@/lib/ai/agents/media-replay-policy";
import type { JobRow } from "@/lib/agent-engine/queue/queue";
import {
  durableMediaPreference,
  temporaryMediaPreference,
} from "@/lib/agent-engine/agent/media-preference-scope";
import {
  conversationAllowsMedia,
  explicitMediaPreference,
  withTurnMediaPreference,
} from "@/lib/agent-engine/agent/media-preference";
import { agentPatchSchema } from "@/lib/ai/guardrails-schema";

const AGENT = "10000000-0000-4000-8000-000000000060";
const MEDIA = "10000000-0000-4000-8000-000000000061";
const INBOUND = "10000000-0000-4000-8000-000000000062";
const OLD = "10000000-0000-4000-8000-000000000063";
const ALIAS = "10000000-0000-4000-8000-000000000064";
function media(kind: "audio" | "image" | "video" = "video"): ApprovedMedia {
  return readApprovedMedia({
    approved_media: [
      {
        id: MEDIA,
        ...(kind === "audio" ? {} : { type: kind }),
        title: "Demonstração",
        use_when: "Demonstração do funcionamento e exemplos práticos.",
        send_when: "Mostrar na prática como funciona.",
        storage_path: `${ORG}/agent-audios/${AGENT}/${MEDIA}.${kind === "audio" ? "ogg" : kind === "image" ? "jpg" : "mp4"}`,
        mime: kind === "audio" ? "audio/ogg" : kind === "image" ? "image/jpeg" : "video/mp4",
        size_bytes: 10,
        enabled: true,
        required: false,
        allow_requested_repeat: true,
        content_sha256: "a".repeat(64),
      },
    ],
  })[0]!;
}
const show = {
  audio_id: MEDIA,
  intent: "show" as const,
  format: "video" as const,
  text_only: false,
};

describe("contrato semântico e política de repetição", () => {
  it("alterar só a política não inclui defaults que sobrescrevam outros ajustes do agente", () => {
    expect(
      agentPatchSchema.parse({ config: { media_replay_policy: "explicit_repeat" } }).config,
    ).toEqual({ media_replay_policy: "explicit_repeat" });
    expect(agentPatchSchema.parse({ config: { temperature: 0.73 } }).config).toEqual({
      temperature: 0.73,
    });
  });
  it("política anterior continua aceitando pedido explícito de formato quando o classificador infere repetição", () => {
    const response = JSON.stringify({ ...show, intent: "repeat" });
    const intent = parseMediaIntent(
      response,
      [media()],
      "Quero vídeo",
      undefined,
      "explicit_media_request",
    );
    expect(intent).toMatchObject({ audio_id: MEDIA, intent: "show" });
    expect(
      authorizeMediaIntent({
        item: media(),
        intent,
        policy: "explicit_media_request",
        legacyRequest: true,
        allowsFormat: true,
        inbound: INBOUND,
        used: [{ id: MEDIA, confirmed: true, request: OLD }],
      }).allowed,
    ).toBe(true);
    expect(
      parseMediaIntent(response, [media()], "Quero vídeo", undefined, "explicit_repeat").audio_id,
    ).toBeNull();
  });
  it("distingue resposta inválida do classificador de ausência legítima de correspondência", () => {
    const reasons: string[] = [];
    parseMediaIntent("não sei", [media()], "mostrar", (reason) => reasons.push(reason));
    expect(reasons).toEqual(["invalid_classifier_output"]);
    parseMediaIntent(
      JSON.stringify({ audio_id: null, intent: "none", format: null, text_only: false }),
      [media()],
      "preço",
      (reason) => reasons.push(reason),
    );
    expect(reasons).toEqual(["invalid_classifier_output"]);
  });
  it("diferencia agora temporário de preferência geral e respeita correção posterior na mesma mensagem", () => {
    expect(temporaryMediaPreference("A partir de agora, somente texto")).toBe(false);
    expect(temporaryMediaPreference("De agora em diante, só texto")).toBe(false);
    expect(temporaryMediaPreference("Hoje prefiro só texto")).toBe(false);
    expect(temporaryMediaPreference("Por enquanto, só texto")).toBe(false);
    expect(temporaryMediaPreference("Nesta resposta, só texto")).toBe(true);
    expect(explicitMediaPreference("Prefiro texto, mas agora manda áudio", "audio")).toBe("audio");
    expect(explicitMediaPreference("Pode mandar áudio, mas prefiro só texto", "audio")).toBe(
      "text",
    );
    expect(explicitMediaPreference("Prefiro texto, mas agora manda vídeo", "video")).toBe("audio");
  });
  it("configurações existentes preservam o padrão; política inválida não ativa modo novo", () => {
    expect(readMediaReplayPolicy(null)).toBe("explicit_media_request");
    expect(readMediaReplayPolicy({ media_replay_policy: "inventada" })).toBe(
      "explicit_media_request",
    );
    expect(readMediaReplayPolicy({ media_replay_policy: "explicit_repeat" })).toBe(
      "explicit_repeat",
    );
  });
  it("escopo temporário não atravessa uma nova regra geral nem transforma comentário em preferência", () => {
    for (const kind of ["audio", "image", "video"] as const) {
      const parse = (clause: string) => explicitMediaPreference(clause, kind);
      expect(
        durableMediaPreference(
          "Nesta resposta pode mandar vídeo. A partir de agora só texto.",
          parse,
        ),
      ).toBe("text");
      expect(
        durableMediaPreference("Essa resposta ficou confusa. Prefiro somente texto.", parse),
      ).toBe("text");
      expect(durableMediaPreference("Nesta resposta:\n\nSó texto", parse)).toBeNull();
      expect(durableMediaPreference("Só texto, mas nesta resposta pode mandar vídeo.", parse)).toBe(
        "text",
      );
    }
  });
  it.each([
    "Consegue me mostrar na prática como funciona?",
    "Queria ver uma despesa na prática",
    "Me mostra como ficam os lembretes",
  ])("aceita seleção sem palavra de formato: %s", (subject) => {
    expect(parseMediaIntent(JSON.stringify(show), [media()], subject)).toEqual(show);
  });
  it.each(["mostra de novo", "reenviar", "outra vez", "mais uma vez", "gostaria de rever"])(
    "repetição natural: %s",
    (text) => {
      expect(clearRepeatIntent(text)).toBe(true);
    },
  );
  it.each([
    "como funciona?",
    "Quero o vídeo",
    "Como registrar gastos por áudio?",
    "não precisa reenviar",
  ])("não cria repetição: %s", (text) => {
    expect(clearRepeatIntent(text)).toBe(false);
    expect(
      parseMediaIntent(JSON.stringify({ ...show, intent: "repeat" }), [media()], text).audio_id,
    ).toBeNull();
  });
  it("modelo não pode selecionar ID estranho, formato errado ou aprovação revogada", () => {
    for (const result of [
      { ...show, audio_id: OLD },
      { ...show, format: "audio" },
      { ...show, extra: true },
    ])
      expect(parseMediaIntent(JSON.stringify(result), [media()], "mostrar").audio_id).toBeNull();
    expect(
      parseMediaIntent(JSON.stringify(show), [{ ...media(), enabled: false }], "mostrar").audio_id,
    ).toBeNull();
    expect(
      parseMediaIntent(JSON.stringify({ ...show, text_only: true }), [media()], "Só texto")
        .audio_id,
    ).toBeNull();
  });
  for (const kind of ["audio", "image", "video"] as const)
    it(`${kind}: primeira entrega, assunto repetido, replay, alias e pendência`, () => {
      const item = media(kind),
        intent = { ...show, format: kind };
      const args = {
        item,
        intent,
        policy: "explicit_repeat" as const,
        legacyRequest: true,
        allowsFormat: true,
        inbound: INBOUND,
        used: [],
      };
      expect(authorizeMediaIntent(args).reason).toBe("first_delivery");
      const used = [{ id: ALIAS, fingerprint: item.content_sha256, confirmed: true, request: OLD }];
      expect(authorizeMediaIntent({ ...args, used }).reason).toBe("repeat_intent_required");
      expect(
        authorizeMediaIntent({ ...args, policy: "explicit_media_request", used }).allowed,
      ).toBe(true);
      expect(
        authorizeMediaIntent({ ...args, intent: { ...intent, intent: "repeat" }, used }).allowed,
      ).toBe(true);
      expect(
        authorizeMediaIntent({ ...args, intent: { ...intent, intent: "repeat" }, used: [] }).reason,
      ).toBe("no_previous_delivery");
      expect(
        authorizeMediaIntent({
          ...args,
          intent: { ...intent, intent: "repeat" },
          used: [{ ...used[0]!, confirmed: false }],
        }).reason,
      ).toBe("pending_or_same_request");
      expect(
        authorizeMediaIntent({
          ...args,
          intent: { ...intent, intent: "repeat" },
          used: [{ ...used[0]!, request: INBOUND }],
        }).allowed,
      ).toBe(false);
      expect(
        authorizeMediaIntent({ ...args, item: { ...item, allow_requested_repeat: false }, used })
          .reason,
      ).toBe("repeat_disabled");
      expect(authorizeMediaIntent({ ...args, allowsFormat: false }).reason).toBe("text_preference");
    });
});

let db: Awaited<ReturnType<typeof outboundPostgres>>;
beforeAll(async () => {
  db = await outboundPostgres();
  await db.pool.query(
    "create table ai_agents(id uuid,organization_id uuid,config jsonb,archived_at timestamptz)",
  );
}, 60_000);
afterAll(async () => db.close());
beforeEach(async () => {
  await db.seed();
  await db.pool.query("delete from ai_agents");
  await db.pool.query("insert into ai_agents(id,organization_id,config) values($1,$2,$3)", [
    AGENT,
    ORG,
    { media_replay_policy: "explicit_repeat" },
  ]);
  await db.pool.query(
    `insert into messages(id,organization_id,conversation_id,contact_id,direction,type,body,created_at)
    values($1,$2,$3,$4,'inbound','text','Consegue me mostrar na prática como funciona?',now())`,
    [INBOUND, ORG, CONV, CONTACT],
  );
  await db.pool.query(
    `update job_queue set kind='inbound_turn',status='running',locked_by='intent-test',payload=$1 where id=$2`,
    [{ conversation_id: CONV, inbound_message_id: INBOUND }, JOB],
  );
});
async function job() {
  return (await db.pool.query<JobRow>("select * from job_queue where id=$1", [JOB])).rows[0]!;
}
async function persist(intent = show) {
  const { rows } = await db.pool.query<{ body: string }>("select body from messages where id=$1", [
    INBOUND,
  ]);
  return persistTurnMediaDecision({
    db: db.pool,
    job: await job(),
    worker: "intent-test",
    agent: AGENT,
    conversation: CONV,
    inbound: INBOUND,
    subject: rows[0]!.body,
    policy: "explicit_repeat",
    intent,
    selected: media(),
    authorize: (decision) =>
      availableConversationAudios(
        db.pool,
        ORG,
        CONV,
        AGENT,
        JOB,
        [media()],
        INBOUND,
        true,
        decision,
      ),
  });
}
it("decisão fica sob lease, vinculada à mensagem e reutilizável no pré-voo", async () => {
  const d = await persist();
  expect(d.authorized_id).toBe(MEDIA);
  expect(await loadTurnMediaDecision(db.pool, ORG, CONV, AGENT, JOB)).toEqual(d);
  await expect(
    assertConversationAudioAvailable(db.pool, ORG, CONV, AGENT, MEDIA, OLD, JOB, media()),
  ).resolves.toBeUndefined();
  await db.pool.query(
    "update job_queue set locked_by='outro',payload=payload-'media_intent_decision'",
  );
  await expect(persist()).rejects.toMatchObject({ name: "OutboundLeaseLostError" });
});
it("mudança de mensagem invalida a prova em vez de voltar ao permissivo legado", async () => {
  await persist();
  await db.pool.query("update messages set body='Nesta resposta, só texto' where id=$1", [INBOUND]);
  await expect(
    assertConversationAudioAvailable(db.pool, ORG, CONV, AGENT, MEDIA, OLD, JOB, media()),
  ).rejects.toThrow();
});
it("não aceita prova de outra organização, conversa, agente ou mensagem", async () => {
  const d = await persist();
  for (const key of [
    "organization_id",
    "conversation_id",
    "agent_id",
    "inbound_message_id",
  ] as const) {
    await db.pool.query(
      "update job_queue set payload=jsonb_set(payload,'{media_intent_decision}',$1)",
      [JSON.stringify({ ...d, [key]: OLD })],
    );
    await expect(loadTurnMediaDecision(db.pool, ORG, CONV, AGENT, JOB)).rejects.toThrow();
  }
});
it("preferência temporária expira no próximo pedido e a preferência geral continua", async () => {
  await db.pool.query("update messages set body='Nesta resposta, só texto' where id=$1", [INBOUND]);
  expect(
    await availableConversationAudios(db.pool, ORG, CONV, AGENT, JOB, [media()], INBOUND),
  ).toEqual([]);
  await db.pool.query("update messages set body='Qual o preço?' where id=$1", [INBOUND]);
  expect(
    await availableConversationAudios(db.pool, ORG, CONV, AGENT, JOB, [media()], INBOUND),
  ).toHaveLength(1);
  await db.pool.query("update messages set body='Prefiro somente texto' where id=$1", [INBOUND]);
  expect(
    await availableConversationAudios(db.pool, ORG, CONV, AGENT, JOB, [media()], INBOUND),
  ).toEqual([]);
});
it("só texto nesta resposta não bloqueia um follow-up futuro sem nova inbound", async () => {
  await db.pool.query("update messages set body='Nesta resposta, só texto' where id=$1", [INBOUND]);
  expect(
    await availableConversationAudios(db.pool, ORG, CONV, AGENT, JOB, [media()], INBOUND),
  ).toEqual([]);
  await db.pool.query("update job_queue set status='done' where id=$1", [JOB]);
  expect(
    await availableConversationAudios(db.pool, ORG, CONV, AGENT, OLD, [media()], null),
  ).toHaveLength(1);
});
it.each(["audio", "image", "video"] as const)(
  "%s: exceção temporária não apaga regra geral da mesma mensagem nem cache antigo",
  async (kind) => {
    const format = { audio: "áudio", image: "foto", video: "vídeo" }[kind];
    const text = `A partir de agora, somente texto. Nesta resposta, pode mandar ${format}.`;
    await db.pool.query("update messages set body=$1 where id=$2", [text, INBOUND]);
    // Versão anterior descartava a regra geral por enxergar a exceção na mensagem inteira.
    await db.pool.query(
      `update messages set metadata=jsonb_build_object(
    'agent_audio_preference_checked',true,'agent_audio_preference_version','2',
    'agent_audio_preference_source',md5(jsonb_build_array(body,media_derived_text)::text),
    'agent_visual_preference_version','2',
    'agent_visual_preference_source',md5(jsonb_build_array(body,media_derived_text)::text)) where id=$1`,
      [INBOUND],
    );
    const durable = await conversationAllowsMedia(db.pool, ORG, CONV, kind);
    expect(durable).toBe(false);
    expect(withTurnMediaPreference(durable, text, kind)).toBe(true);
    expect(
      await availableConversationAudios(db.pool, ORG, CONV, AGENT, OLD, [media(kind)], null),
    ).toEqual([]);
  },
);
it("retry não permite segunda entrega da mesma inbound nem pendência incerta com outro ID", async () => {
  const d = await persist();
  await db.pool.query(
    `insert into messages(id,organization_id,conversation_id,direction,type,status,metadata)
    values($1,$2,$3,'outbound','video','failed',$4)`,
    [
      OLD,
      ORG,
      CONV,
      {
        approved_media: { media_id: ALIAS, agent_id: AGENT, fingerprint: "a".repeat(64) },
        outbound_attempt: { phase: "uncertain" },
      },
    ],
  );
  expect(
    await availableConversationAudios(db.pool, ORG, CONV, AGENT, JOB, [media()], INBOUND, true, d),
  ).toEqual([]);
  await expect(
    assertConversationAudioAvailable(db.pool, ORG, CONV, AGENT, MEDIA, ALIAS, JOB, media()),
  ).rejects.toThrow();
});
it("outro seq do mesmo job não duplica mídia antiga sem request_inbound_id", async () => {
  await db.pool.query("update messages set body='Quero vídeo' where id=$1", [INBOUND]);
  await db.pool.query(
    "insert into send_ledger(id,organization_id,job_id,seq,status) values($1,$2,$3,1,'sent')",
    [OLD, ORG, JOB],
  );
  await db.pool.query(
    `insert into messages(id,organization_id,conversation_id,direction,type,status,metadata)
    values($1,$2,$3,'outbound','video','read',$4)`,
    [
      OLD,
      ORG,
      CONV,
      {
        idempotency_key: OLD,
        approved_media: { media_id: MEDIA, agent_id: AGENT, fingerprint: "a".repeat(64) },
        outbound_attempt: { phase: "confirmed" },
      },
    ],
  );
  await expect(
    assertConversationAudioAvailable(db.pool, ORG, CONV, AGENT, MEDIA, ALIAS, JOB, media()),
  ).rejects.toMatchObject({ message: "audio_already_used" });
});
it("preferência revogada na tela entre a decisão e o transporte veta o envio", async () => {
  await persist();
  await db.pool.query("update ai_agents set config='{}'");
  await expect(
    assertConversationAudioAvailable(db.pool, ORG, CONV, AGENT, MEDIA, OLD, JOB, media()),
  ).rejects.toThrow();
});
it("hash distingue texto alterado e conserva o turno exato", () => {
  expect(mediaSubjectHash("mostra")).not.toBe(mediaSubjectHash("mostra de novo"));
});

it('P01: decisão de um formato não reconcilia preferências dos três formatos', async () => {
  await persist();
  const spy = vi.spyOn(db.pool, 'query');
  try {
    expect(await availableConversationAudios(db.pool, ORG, CONV, AGENT, JOB,
      [media(), { ...media('audio'), id: OLD }, { ...media('image'), id: ALIAS }], INBOUND)).toHaveLength(1);
    // Baseline fazia pelo menos 10 viagens para este catálogo; continuam as
    // quatro leituras frescas da prova, mensagem atual e entregas anteriores.
    expect(spy.mock.calls.length).toBeLessThanOrEqual(4);
  } finally { spy.mockRestore(); }
});

it('P02: otimização não reutiliza aprovação revogada entre duas conferências', async () => {
  await persist();
  const spy = vi.spyOn(db.pool, 'query');
  try {
    await expect(assertConversationAudioAvailable(db.pool, ORG, CONV, AGENT, MEDIA, OLD, JOB, media())).resolves.toBeUndefined();
    expect(spy.mock.calls.length).toBeLessThanOrEqual(6);
  } finally { spy.mockRestore(); }
  await db.pool.query("update ai_agents set config='{}'");
  await expect(assertConversationAudioAvailable(db.pool, ORG, CONV, AGENT, MEDIA, OLD, JOB, media())).rejects.toThrow();
});
