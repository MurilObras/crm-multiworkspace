// @vitest-environment node
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareAgentMedia } from "@/lib/agent-engine/edge/crm/prepare-media";
import { sendTurnMessage } from "@/lib/agent-engine/edge/crm/send-message";
import { claimJobs } from "@/lib/agent-engine/queue/queue";
import { getAdapter } from "@/lib/channels";
import * as templateSender from "@/lib/channels/meta/send-template-for-session";
import { OutboundSupersededError } from "@/lib/channels/delivery-error";
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
