// @vitest-environment node
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareAgentMedia } from "@/lib/agent-engine/edge/crm/prepare-media";
import { sendTurnMessage } from "@/lib/agent-engine/edge/crm/send-message";
import { claimJobs } from "@/lib/agent-engine/queue/queue";
import { getAdapter } from "@/lib/channels";
import { MAX_MEDIA_BYTES } from "@/lib/messaging/media/types";
import { outboundPostgres, ORG, CONTACT, JOB, CONV } from "../helpers/outbound-postgres";

const state = vi.hoisted(() => ({
  dns: vi.fn(async () => {}),
  upload: vi.fn(async (..._args: unknown[]) => ({ error: null })),
  sign: vi.fn(async () => ({
    data: { signedUrl: "https://signed.example/official.mp4" },
    error: null,
  })),
}));
vi.mock("@/lib/automation/outbound-ip", () => ({ assertDestinoResolvidoSeguro: state.dns }));
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
beforeAll(async () => {
  db = await outboundPostgres();
  supabase = {
    ...db.supabase,
    storage: { from: () => ({ upload: state.upload }) },
  } as unknown as SupabaseClient;
}, 60_000);
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  vi.clearAllMocks();
  await db.seed();
  await db.pool.query("update job_queue set kind='inbound_turn' where id=$1", [JOB]);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("video-bytes", { headers: { "content-type": "video/mp4" } })),
  );
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
