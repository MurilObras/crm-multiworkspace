// @vitest-environment node
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareAgentMedia } from "@/lib/agent-engine/edge/crm/prepare-media";
import { sendTurnMessage } from "@/lib/agent-engine/edge/crm/send-message";
import { claimJobs, completeJob, rescheduleJob, type JobRow } from "@/lib/agent-engine/queue/queue";
import { readApprovedAudios } from '@/lib/ai/agents/approved-audios';
import { requiredAudioPlan, deliverRequiredAudio } from '@/lib/agent-engine/agent/required-audio';
import { getAdapter } from "@/lib/channels";
import * as templateSender from "@/lib/channels/meta/send-template-for-session";
import { OutboundSupersededError } from "@/lib/channels/delivery-error";
import { OutboundApprovalRevokedError, OutboundAudioUnavailableError } from '@/lib/channels/delivery-error';
import { MAX_MEDIA_BYTES } from "@/lib/messaging/media/types";
import { outboundPostgres, ORG, CONTACT, JOB, CONV } from "../helpers/outbound-postgres";

const state = vi.hoisted(() => ({
  dns: vi.fn(async () => {}),
  upload: vi.fn(async (..._args: unknown[]) => ({ error: null })),
  download: vi.fn(async () => ({ data: new Blob(['OggSOpusHead-test'], { type: 'audio/ogg' }), error: null })),
  sign: vi.fn(async () => ({
    data: { signedUrl: "https://signed.example/official.mp4" },
    error: null,
  })),
}));
vi.mock("@/lib/automation/outbound-ip", () => ({ assertDestinoResolvidoSeguro: state.dns }));
vi.mock("@/lib/channels/conferir-definicao", () => ({ conferirDefinicao: async () => {} }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));
vi.mock("@/lib/ai/elegibilidade/consulta-supabase", () => ({
  decidirElegibilidadeDaConversaViaSupabase: async () => ({ permite: true }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ storage: { from: () => ({ createSignedUrl: state.sign }) } }),
}));

let db: Awaited<ReturnType<typeof outboundPostgres>>;
let supabase: SupabaseClient;
const input = () => ({
  workerId: "media-test",
  tenantId: ORG,
  leadId: CONTACT,
  jobId: JOB,
  seq: 1,
  conversationId: CONV,
  body: "Demonstração oficial",
  media: { type: "video" as const, url: "https://official.example/demo.mp4" },
});
const AUDIO_AGENT = '10000000-0000-4000-8000-000000000060';
const AUDIO_ID = '10000000-0000-4000-8000-000000000061';
const approvedAudio = () => ({ id: AUDIO_ID, title: 'Apresentação', use_when: 'Quando perguntar sobre o aplicativo',
  enabled: true, mime: 'audio/ogg', size_bytes: 17, storage_path: `${ORG}/agent-audios/${AUDIO_AGENT}/${AUDIO_ID}.ogg` });
const audioInput = () => ({ ...input(), media: { type: 'audio' as const, audio_id: AUDIO_ID, agent_id: AUDIO_AGENT } });
beforeAll(async () => {
  db = await outboundPostgres();
  await db.pool.query('create table ai_agents(id uuid primary key,organization_id uuid,archived_at timestamptz,config jsonb)');
  supabase = {
    ...db.supabase,
    storage: { from: () => ({ upload: state.upload, download: state.download }) },
  } as unknown as SupabaseClient;
}, 60_000);
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  vi.clearAllMocks();
  await db.seed();
  await db.pool.query('delete from ai_agents');
  await db.pool.query('insert into ai_agents values($1,$2,null,$3)', [AUDIO_AGENT, ORG, JSON.stringify({ approved_audios: [approvedAudio()] })]);
  await db.pool.query("update job_queue set kind='inbound_turn' where id=$1", [JOB]);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("video-bytes", { headers: { "content-type": "video/mp4" } })),
  );
});

describe('áudio privado aprovado pelo mesmo sink', () => {
  it.each([false, true])('áudio obrigatório retoma a mesma intenção após desconexão (após resposta: %s)', async afterResponse => {
    const audios = readApprovedAudios({ approved_audios: [{ ...approvedAudio(), required: true }] });
    await db.pool.query('update ai_agents set config=$1', [JSON.stringify({ approved_audios: audios })]);
    await db.pool.query("update job_queue set payload=payload || jsonb_build_object('conversation_id',$1::text)", [CONV]);
    vi.spyOn(getAdapter('waha'), 'isConfigured').mockReturnValue(true);
    const transport = vi.spyOn(getAdapter('waha'), 'send').mockImplementationOnce(async () => {
      await db.pool.query("update channel_sessions set status='STOPPED'");
      return { externalId: 'context-once' };
    }).mockResolvedValue({ externalId: 'voice-once' });
    await claimJobs(db.pool, { workerId: 'media-test', maxConcurrency: 1, jobIds: [JOB] });
    const job = async () => (await db.pool.query<JobRow>('select * from job_queue where id=$1', [JOB])).rows[0]!;
    const plan = (await requiredAudioPlan(db.pool, await job(), 'media-test', AUDIO_AGENT, audios, 3, afterResponse ? 'after_response' : undefined))!;
    let sequence = 0;
    const invoke: Parameters<typeof deliverRequiredAudio>[0]['invoke'] = async args => {
      const result = await sendTurnMessage(db.pool, { supabase }, { ...audioInput(), seq: ++sequence, body: args.body,
        media: args.media ? { ...args.media, agent_id: AUDIO_AGENT } : undefined });
      return { ok: true, status: result.kind === 'sent' || result.kind === 'already_sent' ? 'enviada' : 'aceita_aguardando_canal' };
    };
    const reserve = () => { sequence = Math.max(sequence, afterResponse ? 3 : 2); };
    if (afterResponse) { sequence = 2; await invoke({ body: 'Contexto da resposta atual.' }); sequence = 1; }
    await deliverRequiredAudio({ plan, agent: AUDIO_AGENT, audios, invoke, reserve, contextAlreadySent: afterResponse, discard: async () => {} });
    expect(transport).toHaveBeenCalledOnce();
    expect((await db.pool.query('select status from messages where type=\'audio\'')).rows[0]?.status).toBe('queued');
    await rescheduleJob(db.pool, JOB, 'media-test', { delayMs: 0, reason: 'fixture offline' });
    await db.pool.query("update channel_sessions set status='WORKING'");
    await claimJobs(db.pool, { workerId: 'media-test', maxConcurrency: 1, jobIds: [JOB] });
    expect(await requiredAudioPlan(db.pool, await job(), 'media-test', AUDIO_AGENT, audios, 3)).toEqual(plan);
    sequence = 0;
    if (afterResponse) { sequence = 2; await invoke({ body: 'Contexto da resposta atual.' }); sequence = 1; }
    await deliverRequiredAudio({ plan, agent: AUDIO_AGENT, audios, invoke, reserve, contextAlreadySent: afterResponse, discard: async () => {} });
    expect(transport).toHaveBeenCalledTimes(2);
    expect((await db.pool.query('select seq from send_ledger order by seq')).rows.map(r => r.seq)).toEqual(afterResponse ? [2,3] : [1,2]);
    expect((await db.pool.query('select status from messages')).rows.map(r => r.status)).toEqual(['sent','sent']);
    expect((await db.pool.query('select status from send_ledger')).rows.map(r => r.status)).toEqual(['accepted','accepted']);
  });
  it('outro job na mesma conversa não repete a gravação já enviada', async () => {
    const next = '10000000-0000-4000-8000-000000000080';
    vi.spyOn(getAdapter('waha'), 'isConfigured').mockReturnValue(true);
    const transport = vi.spyOn(getAdapter('waha'), 'send').mockResolvedValue({ externalId: 'confirmed-once' });
    await claimJobs(db.pool, { workerId: 'media-test', maxConcurrency: 1, jobIds: [JOB] });
    expect((await sendTurnMessage(db.pool, { supabase }, audioInput())).kind).toBe('sent');
    await completeJob(db.pool, JOB, 'media-test');
    await db.pool.query("insert into job_queue(id,organization_id,contact_id,kind,payload) values($1,$2,$3,'inbound_turn',$4)",
      [next, ORG, CONTACT, JSON.stringify({ conversation_id: CONV })]);
    await claimJobs(db.pool, { workerId: 'media-test', maxConcurrency: 1, jobIds: [next] });
    await expect(sendTurnMessage(db.pool, { supabase }, { ...audioInput(), jobId: next })).rejects.toMatchObject({ message: 'audio_already_used' });
    expect(transport).toHaveBeenCalledOnce(); expect(state.download).toHaveBeenCalledOnce();
    expect((await db.pool.query('select status,last_error from send_ledger where job_id=$1', [next])).rows[0])
      .toMatchObject({ status: 'vetoed', last_error: 'audio_already_used' });
  });
  it.each(['audio_already_used', 'audio_text_preference'])('revalida %s após assinar o arquivo e não abre transporte', async reason => {
    vi.spyOn(getAdapter('waha'), 'isConfigured').mockReturnValue(true);
    const transport = vi.spyOn(getAdapter('waha'), 'send');
    state.sign.mockImplementationOnce(async () => {
      await db.pool.query(`insert into messages(organization_id,conversation_id,contact_id,direction,type,status,metadata)
        values($1,$2,$3,$4,$5,'sent',$6)`, [ORG, CONV, CONTACT,
        reason === 'audio_already_used' ? 'outbound' : 'inbound', reason === 'audio_already_used' ? 'audio' : 'text',
        JSON.stringify(reason === 'audio_already_used' ? { approved_audio: { agent_id: AUDIO_AGENT, audio_id: AUDIO_ID } }
          : { agent_audio_preference: 'text' })]);
      return { data: { signedUrl: 'https://signed.example/audio.ogg' }, error: null };
    });
    await claimJobs(db.pool, { workerId: 'media-test', maxConcurrency: 1, jobIds: [JOB] });
    await expect(sendTurnMessage(db.pool, { supabase }, audioInput())).rejects.toMatchObject({ message: reason });
    expect(transport).not.toHaveBeenCalled();
    expect((await db.pool.query('select status,error_code,metadata from messages where direction=\'outbound\' and status=\'failed\'')).rows[0])
      .toMatchObject({ status: 'failed', error_code: reason, metadata: { outbound_attempt: { phase: 'rejected', retryable: false } } });
    expect((await db.pool.query('select status,last_error from send_ledger')).rows[0]).toMatchObject({ status: 'vetoed', last_error: reason });
  });
  it('mudar de etapa durante a assinatura veta o áudio já preparado sem abrir transporte', async () => {
    const pipeline = '10000000-0000-4000-8000-000000000071';
    const stage = '10000000-0000-4000-8000-000000000072';
    const other = '10000000-0000-4000-8000-000000000073';
    await db.pool.query('insert into crm_pipelines(id,organization_id) values($1,$2)', [pipeline, ORG]);
    await db.pool.query('insert into crm_stages(id,organization_id,pipeline_id) values($1,$2,$3),($4,$2,$3)', [stage, ORG, pipeline, other]);
    await db.pool.query("insert into crm_leads(id,organization_id,contact_id,pipeline_id,stage_id,status) values($1,$2,$3,$4,$5,'open')", [AUDIO_AGENT, ORG, CONTACT, pipeline, stage]);
    await db.pool.query('update ai_agents set config=$1', [JSON.stringify({ approved_audios: [{ ...approvedAudio(), stage_ids: [stage] }] })]);
    vi.spyOn(getAdapter('waha'), 'isConfigured').mockReturnValue(true);
    const transport = vi.spyOn(getAdapter('waha'), 'send');
    state.sign.mockImplementationOnce(async () => {
      await db.pool.query('update crm_leads set stage_id=$1', [other]);
      return { data: { signedUrl: 'https://signed.example/audio.ogg' }, error: null };
    });
    await claimJobs(db.pool, { workerId: 'media-test', maxConcurrency: 1, jobIds: [JOB] });
    await expect(sendTurnMessage(db.pool, { supabase }, audioInput())).rejects.toBeInstanceOf(OutboundAudioUnavailableError);
    expect(transport).not.toHaveBeenCalled();
    expect((await db.pool.query('select status,error_code,metadata from messages')).rows[0]).toMatchObject({ status: 'failed', error_code: 'audio_stage_mismatch', metadata: { outbound_attempt: { phase: 'rejected', retryable: false } } });
    expect((await db.pool.query('select status,last_error from send_ledger')).rows[0]).toMatchObject({ status: 'vetoed', last_error: 'audio_stage_mismatch' });
  });
  it('envia uma vez, copia para a conversa e conserva a origem aprovada no replay', async () => {
    vi.spyOn(getAdapter('waha'), 'isConfigured').mockReturnValue(true);
    const transport = vi.spyOn(getAdapter('waha'), 'send').mockResolvedValue({ externalId: 'confirmed-audio' });
    await claimJobs(db.pool, { workerId: 'media-test', maxConcurrency: 1, jobIds: [JOB] });
    expect((await sendTurnMessage(db.pool, { supabase }, audioInput())).kind).toBe('sent');
    expect(transport.mock.calls[0]?.[0]).toMatchObject({ kind: 'audio', media: { mime: 'audio/ogg', caption: null } });
    expect(fetch).not.toHaveBeenCalled();
    expect(state.download).toHaveBeenCalledWith(approvedAudio().storage_path);
    const row = (await db.pool.query('select * from messages')).rows[0]!;
    expect(row.media_storage_path).toMatch(new RegExp(`^${ORG}/${CONV}/agent-`));
    expect(row.metadata.approved_audio).toEqual({ agent_id: AUDIO_AGENT, audio_id: AUDIO_ID });
    expect((await sendTurnMessage(db.pool, { supabase }, audioInput())).kind).toBe('already_sent');
    expect(transport).toHaveBeenCalledOnce(); expect(state.download).toHaveBeenCalledOnce();
  });
  it('revogação durante a assinatura encerra mensagem e ledger, mantendo a lane', async () => {
    vi.spyOn(getAdapter('waha'), 'isConfigured').mockReturnValue(true);
    const transport = vi.spyOn(getAdapter('waha'), 'send');
    state.sign.mockImplementationOnce(async () => {
      await db.pool.query("update ai_agents set config='{}'");
      return { data: { signedUrl: 'https://signed.example/audio.ogg' }, error: null };
    });
    await claimJobs(db.pool, { workerId: 'media-test', maxConcurrency: 1, jobIds: [JOB] });
    await expect(sendTurnMessage(db.pool, { supabase }, audioInput())).rejects.toBeInstanceOf(OutboundApprovalRevokedError);
    expect(transport).not.toHaveBeenCalled();
    expect((await db.pool.query('select status,error_code,metadata from messages')).rows[0]).toMatchObject({ status: 'failed',
      error_code: 'audio_approval_revoked', metadata: { outbound_attempt: { phase: 'rejected', retryable: false } } });
    expect((await db.pool.query('select status from send_ledger')).rows[0]?.status).toBe('vetoed');
    expect((await db.pool.query('select status from job_queue')).rows[0]?.status).toBe('running');
  });
  it('retry offline revalida a origem persistida mesmo se o modelo agora escolher outra mídia', async () => {
    await db.pool.query("update channel_sessions set status='STOPPED'");
    await claimJobs(db.pool, { workerId: 'media-test', maxConcurrency: 1, jobIds: [JOB] });
    expect((await sendTurnMessage(db.pool, { supabase }, audioInput())).kind).toBe('queued');
    await db.pool.query("update ai_agents set config='{}'");
    await db.pool.query("update channel_sessions set status='WORKING'");
    await db.pool.query("update job_queue set run_after=now()");
    await claimJobs(db.pool, { workerId: 'media-test', maxConcurrency: 1, jobIds: [JOB] });
    await expect(sendTurnMessage(db.pool, { supabase }, input())).rejects.toBeInstanceOf(OutboundApprovalRevokedError);
    expect(state.download).toHaveBeenCalledOnce(); expect(fetch).not.toHaveBeenCalled();
    expect((await db.pool.query('select status from messages')).rows[0]?.status).toBe('failed');
  });
  it('nova inbound durante a preparação final também descarta áudio aprovado', async () => {
    vi.spyOn(getAdapter('waha'), 'isConfigured').mockReturnValue(true);
    const transport = vi.spyOn(getAdapter('waha'), 'send');
    let current = true;
    state.sign.mockImplementationOnce(async () => { current = false; return { data: { signedUrl: 'https://signed.example/a.ogg' }, error: null }; });
    await claimJobs(db.pool, { workerId: 'media-test', maxConcurrency: 1, jobIds: [JOB] });
    await expect(sendTurnMessage(db.pool, { supabase }, { ...audioInput(), beforePersist: async () => {
      if (!current) throw new OutboundSupersededError();
    } })).rejects.toBeInstanceOf(OutboundSupersededError);
    expect(transport).not.toHaveBeenCalled();
  });
  it.each(['other_org', 'wrong_path', 'disabled', 'unknown_id'])('recusa %s antes de baixar arquivo privado', async reason => {
    const a = approvedAudio();
    if (reason === 'wrong_path') a.storage_path = `${CONV}/private.ogg`;
    if (reason === 'disabled') a.enabled = false;
    await db.pool.query('update ai_agents set organization_id=$1,config=$2', [reason === 'other_org' ? CONV : ORG, JSON.stringify({ approved_audios: [a] })]);
    const args = audioInput(); if (reason === 'unknown_id') args.media.audio_id = CONV;
    await expect(prepareAgentMedia(supabase, args, JOB)).rejects.toThrow('audio_approval_revoked');
    expect(state.download).not.toHaveBeenCalled(); expect(state.upload).not.toHaveBeenCalled();
  });
  it.each([false, true])('revogação antes/durante download termina a intenção sem mensagem órfã (%s)', async during => {
    if (during) state.download.mockImplementationOnce(async () => {
      await db.pool.query("update ai_agents set config='{}'");
      return { data: new Blob(['OggSOpusHead-test'], { type: 'audio/ogg' }), error: null };
    });
    else await db.pool.query("update ai_agents set config='{}'");
    await claimJobs(db.pool, { workerId: 'media-test', maxConcurrency: 1, jobIds: [JOB] });
    await expect(sendTurnMessage(db.pool, { supabase }, audioInput())).rejects.toBeInstanceOf(OutboundApprovalRevokedError);
    expect((await db.pool.query('select id from messages')).rows).toHaveLength(0);
    expect((await db.pool.query('select status,last_error from send_ledger')).rows[0]).toMatchObject({ status: 'vetoed', last_error: 'audio_approval_revoked' });
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("arquivo oficial pelo Storage e pelo sink real", () => {
  it.each(["image", "video"] as const)(
    "entrega %s com URL assinada, legenda e uma única tentativa no replay",
    async (type) => {
      const mime = type === "image" ? "image/jpeg" : "video/mp4";
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("bytes", { headers: { "content-type": mime } })),
      );
      vi.spyOn(getAdapter("waha"), "isConfigured").mockReturnValue(true);
      const transport = vi
        .spyOn(getAdapter("waha"), "send")
        .mockResolvedValue({ externalId: "confirmed-media" });
      await claimJobs(db.pool, { workerId: "media-test", maxConcurrency: 1, jobIds: [JOB] });
      const args = { ...input(), media: { ...input().media, type } };
      expect((await sendTurnMessage(db.pool, { supabase }, args)).kind).toBe("sent");
      expect(transport).toHaveBeenCalledOnce();
      expect(transport.mock.calls[0]?.[0]).toMatchObject({
        kind: type,
        media: {
          url: "https://signed.example/official.mp4",
          mime,
          caption: "Demonstração oficial",
        },
      });
      const row = (
        await db.pool.query(
          "select media_storage_path,media_mime,media_size_bytes,status from messages",
        )
      ).rows[0];
      expect(row).toMatchObject({ status: "sent", media_mime: mime });
      expect(row?.media_storage_path).toMatch(new RegExp(`^${ORG}/${CONV}/agent-`));
      expect((await sendTurnMessage(db.pool, { supabase }, args)).kind).toBe("already_sent");
      expect(transport).toHaveBeenCalledOnce();
      expect(state.upload).toHaveBeenCalledOnce();
      expect(fetch).toHaveBeenCalledOnce();
      expect(fetch).toHaveBeenCalledWith(
        args.media.url,
        expect.objectContaining({ redirect: "manual" }),
      );
    },
  );
  it("reconfere a conversa depois do download, antes de criar uma mensagem", async () => {
    await claimJobs(db.pool, { workerId: "media-test", maxConcurrency: 1, jobIds: [JOB] });
    const beforePersist = vi.fn(async () => {
      throw new Error("inbound-superada");
    });
    await expect(
      sendTurnMessage(db.pool, { supabase }, { ...input(), beforePersist }),
    ).rejects.toThrow("inbound-superada");
    expect(state.upload).toHaveBeenCalledOnce();
    expect(beforePersist).toHaveBeenCalledOnce();
    expect((await db.pool.query("select id from messages")).rows).toHaveLength(0);
  });
});

describe("preparo limitado e isolado", () => {
  it("preparo atrasado não sobrescreve conteúdo diferente da mesma intenção", async () => {
    const first = await prepareAgentMedia(supabase, input(), JOB);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response("updated-video", { headers: { "content-type": "video/mp4" } }),
      ),
    );
    const second = await prepareAgentMedia(supabase, input(), JOB);
    expect(second.media_storage_path).not.toBe(first.media_storage_path);
    expect(state.upload.mock.calls[0]?.[0]).toBe(first.media_storage_path);
    expect(state.upload.mock.calls[1]?.[0]).toBe(second.media_storage_path);
  });
  it("recusa conversa de outro workspace antes de rede/Storage", async () => {
    await expect(prepareAgentMedia(supabase, { ...input(), tenantId: CONV }, JOB)).rejects.toThrow(
      "agent_media_prepare_failed",
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(state.upload).not.toHaveBeenCalled();
  });
  it("recusa host privado e DNS que resolve para destino proibido", async () => {
    await expect(
      prepareAgentMedia(
        supabase,
        { ...input(), media: { type: "video", url: "https://127.0.0.1/video" } },
        JOB,
      ),
    ).rejects.toThrow("agent_media_prepare_failed");
    state.dns.mockRejectedValueOnce(new Error("unsafe_url:private_ip"));
    await expect(prepareAgentMedia(supabase, input(), JOB)).rejects.toThrow(
      "agent_media_prepare_failed",
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(state.upload).not.toHaveBeenCalled();
  });
  it("não segue redirect nem transforma HTML em vídeo", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(null, { status: 302, headers: { location: "https://127.0.0.1/" } }),
      ),
    );
    await expect(prepareAgentMedia(supabase, input(), JOB)).rejects.toThrow(
      "agent_media_prepare_failed",
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("html", { headers: { "content-type": "text/html" } })),
    );
    await expect(prepareAgentMedia(supabase, input(), JOB)).rejects.toThrow(
      "agent_media_prepare_failed",
    );
    expect(state.upload).not.toHaveBeenCalled();
  });
  it("limita tamanho declarado e tamanho real do stream", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("x", { headers: { "content-length": String(MAX_MEDIA_BYTES + 1) } }),
      ),
    );
    await expect(prepareAgentMedia(supabase, input(), JOB)).rejects.toThrow(
      "agent_media_prepare_failed",
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(c) {
                c.enqueue(new Uint8Array(MAX_MEDIA_BYTES));
                c.enqueue(new Uint8Array(1));
                c.close();
              },
            }),
            { headers: { "content-type": "video/mp4", "content-length": "1" } },
          ),
      ),
    );
    await expect(prepareAgentMedia(supabase, input(), JOB)).rejects.toThrow(
      "agent_media_prepare_failed",
    );
    expect(state.upload).not.toHaveBeenCalled();
  });
  it("falha de upload não anuncia envio nem revela resposta externa", async () => {
    state.upload.mockRejectedValueOnce(new Error("sensitive upstream detail"));
    await expect(prepareAgentMedia(supabase, input(), JOB)).rejects.toThrow(
      /^agent_media_prepare_failed$/,
    );
  });
});

it.each(["image", "video", "text", "template"] as const)(
  "descarta %s superado no preparo final, sem transporte ou retry",
  async (type) => {
    let current = true;
    if (type === "template") {
      await db.pool.query("update channel_sessions set provider='meta_cloud'");
    }
    const adapter = getAdapter(type === "template" ? "meta_cloud" : "waha");
    vi.spyOn(adapter, "isConfigured").mockReturnValue(true);
    const transport = vi.spyOn(adapter, "send").mockResolvedValue({ externalId: "nao-deve-sair" });
    const templateTransport =
      type === "template"
        ? vi
            .spyOn(templateSender, "sendTemplateForSession")
            .mockResolvedValue("nao-deve-sair-template")
        : null;
    const rpc = supabase.rpc.bind(supabase);
    vi.spyOn(supabase, "rpc").mockImplementation(((name: string, ...args: unknown[]) => {
      if (name === "fn_automation_message_live") current = false;
      return rpc(name, ...args);
    }) as typeof supabase.rpc);
    if (type === "image" || type === "video") {
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response("bytes", {
              headers: { "content-type": type === "image" ? "image/jpeg" : "video/mp4" },
            }),
        ),
      );
      state.sign.mockImplementationOnce(async () => {
        current = false;
        return { data: { signedUrl: "https://signed.example/official.mp4" }, error: null };
      });
    }
    await claimJobs(db.pool, { workerId: "media-test", maxConcurrency: 1, jobIds: [JOB] });
    const guard = vi.fn(async () => {
      if (!current) throw new OutboundSupersededError();
    });
    const { media, ...base } = input();
    const args = {
      ...base,
      beforePersist: guard,
      ...(type === "image" || type === "video" ? { media: { ...media, type } } : {}),
      ...(type === "template"
        ? { template: { name: "retorno", language: "pt_BR", values: {} } }
        : {}),
    };
    await expect(sendTurnMessage(db.pool, { supabase }, args)).rejects.toBeInstanceOf(
      OutboundSupersededError,
    );
    expect(guard).toHaveBeenCalledTimes(2);
    expect(transport).not.toHaveBeenCalled();
    if (templateTransport) expect(templateTransport).not.toHaveBeenCalled();
    const row = (await db.pool.query("select status,error_code,metadata from messages")).rows[0];
    expect(row).toMatchObject({
      status: "failed",
      error_code: "inbound_superseded",
      metadata: { outbound_attempt: { phase: "rejected", retryable: false } },
    });
    expect((await db.pool.query("select status from send_ledger")).rows[0]?.status).toBe("vetoed");
    // O executor não libera a lane enquanto o laço de ferramentas não terminou.
    expect(
      (await db.pool.query("select status from job_queue where id=$1", [JOB])).rows[0]?.status,
    ).toBe("running");
    expect((await sendTurnMessage(db.pool, { supabase }, args)).kind).toBe("failed");
    expect(transport).not.toHaveBeenCalled();
    if (templateTransport) expect(templateTransport).not.toHaveBeenCalled();
  },
);

it("encerra também a linha queued de um retry dispensado antes de persistir", async () => {
  await db.pool.query("update channel_sessions set status='STOPPED'");
  await claimJobs(db.pool, { workerId: "media-test", maxConcurrency: 1, jobIds: [JOB] });
  expect((await sendTurnMessage(db.pool, { supabase }, input())).kind).toBe("queued");
  await expect(
    sendTurnMessage(
      db.pool,
      { supabase },
      {
        ...input(),
        beforePersist: async () => {
          throw new OutboundSupersededError();
        },
      },
    ),
  ).rejects.toBeInstanceOf(OutboundSupersededError);
  expect(
    (await db.pool.query("select status,error_code,metadata from messages")).rows[0],
  ).toMatchObject({
    status: "failed",
    error_code: "inbound_superseded",
    metadata: { outbound_attempt: { phase: "rejected", retryable: false } },
  });
  expect((await db.pool.query("select status from send_ledger")).rows[0]?.status).toBe("vetoed");
});
