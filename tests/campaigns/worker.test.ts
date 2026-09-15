import { beforeEach, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { EventRow } from "@/lib/event-log/dispatcher";
import { processCampaign } from "@/lib/campaigns/worker";

const { send, ensure } = vi.hoisted(() => ({ send: vi.fn(), ensure: vi.fn() }));
vi.mock("@/app/api/v1/messages/_handler", () => ({ sendMessageHandler: send }));
vi.mock("@/lib/automation/start-conversation", () => ({ ensureConversation: ensure }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => { throw new Error("No real DB"); }) }));

const campaign = {
  id: "campaign", name: "Sale", organization_id: "org-a", channel_session_id: "channel",
  steps: [{ message: "Hello", delay_minutes: 0 }, { message: "Follow up", delay_minutes: 60 }],
  status: "running", created_by: "user", started_at: "2026-09-07T00:00:00.000Z", hourly_limit: 10,
};
function row(payload: Record<string, unknown> = { step_index: 0 }): EventRow {
  return { id: "event", organization_id: "org-a", entity_id: "campaign", event_type: "whatsapp_campaign.requested", entity_kind: "whatsapp_campaign", payload, metadata: {}, consumed_by: [], attempts: 0 };
}
type Options = {
  step?: Record<string, unknown>; template?: Record<string, unknown>; templateError?: boolean;
  provider?: string; finalizeError?: boolean;
  foreign?: boolean; blocked?: boolean; declined?: boolean; replied?: boolean;
  optOutDuringSend?: boolean; foreignChannel?: boolean; foreignConversation?: boolean;
  retry?: string; done?: boolean; linkError?: boolean; firstClaimDone?: boolean;
  inbound?: { organization_id?: string; channel_session_id?: string };
  scheduled?: boolean; notDue?: string;
};
function database(options: Options = {}) {
  let claimed = false;
  let contactReads = 0;
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const writes: Array<Record<string, unknown>> = [];
  const queries: Array<{ table: string; filters: Record<string, unknown> }> = [];
  const messages: Array<Record<string, string>> = options.replied || options.inbound ? [{
    id: "inbound", organization_id: "org-a", contact_id: "contact",
    channel_session_id: "channel", direction: "inbound", created_at: "2026-09-07T01:00:00.000Z",
    ...options.inbound,
  }] : [];
  const admin = {
    rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      if (fn === "start_scheduled_whatsapp_campaign") return { data: options.notDue
        ? { retry_at: options.notDue } : { status: "running", started_at: campaign.started_at }, error: null };
      if (fn === "claim_whatsapp_campaign_step") {
        if (options.done) return { data: { done: true }, error: null };
        if (options.retry) return { data: { retry_at: options.retry }, error: null };
        if (claimed || options.firstClaimDone) return { data: { done: true }, error: null };
        claimed = true;
        return { data: { step_id: "step", contact_id: "contact" }, error: null };
      }
      if (fn === "finalize_whatsapp_campaign_step") return { data: true, error: options.finalizeError ? { message: "db failed" } : null };
      return { data: null, error: { message: "unknown rpc" } };
    }),
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const greaterThan: Record<string, string> = {};
      queries.push({ table, filters });
      let patch: Record<string, unknown> | undefined;
      const q = {
        select: () => q,
        eq: (k: string, v: unknown) => { filters[k] = v; return q; },
        is: (k: string, v: unknown) => { filters[k] = v; return q; },
        gt: (k: string, v: string) => { greaterThan[k] = v; return q; },
        limit: () => q,
        update: (v: Record<string, unknown>) => { patch = v; writes.push(v); return q; },
        maybeSingle: async () => resolve(), single: async () => resolve(),
        then: (fn: (v: unknown) => unknown) => {
          const r = resolve();
          return Promise.resolve(table === "channel_sessions" ? { ...r, data: r.data ? [r.data] : [] } : r).then(fn);
        },
      };
      function resolve() {
        if (table === "whatsapp_campaigns") return { data: options.foreign ? null : { ...campaign,
          ...(options.step ? { steps: [options.step] } : {}), status: options.scheduled ? "scheduled" : "running" }, error: null };
        if (table === "contacts") {
          contactReads++;
          const blocked = options.blocked || (options.optOutDuringSend && contactReads > 1);
          return { data: { id: "contact", phone_number: "+5511999999999", is_blocked: blocked, consent: options.declined ? { marketing: { declined_at: "2026-09-01" } } : {} }, error: null };
        }
        if (table === "messages") return {
          data: messages.find((message) =>
            Object.entries(filters).every(([k, v]) => message[k] === v)
            && Object.entries(greaterThan).every(([k, v]) => typeof message[k] === "string" && message[k] > v)) ?? null,
          error: null,
        };
        if (table === "channel_sessions") return { data: options.foreignChannel ? null : {
          id: "channel", organization_id: "org-a", provider: options.provider ?? "waha", status: "WORKING", archived_at: null,
        }, error: null };
        if (table === "meta_templates") {
          const template: Record<string, unknown> = { id: templateId, organization_id: "org-a", channel_session_id: "channel",
            language: "pt_BR", name: "retorno", status: "APPROVED", parameter_format: "POSITIONAL",
            components: [{ type: "BODY", text: "Olá {{1}}" }], ...options.template };
          return { data: Object.entries(filters).every(([k, v]) => template[k] === v) ? template : null,
            error: options.templateError ? { message: "db failed" } : null };
        }
        if (table === "conversations") return { data: options.foreignConversation ? null : { id: "conversation" }, error: null };
        if (table === "whatsapp_campaign_recipient_steps") return { data: { id: "step" }, error: options.linkError && patch?.message_id && !patch?.status ? { message: "DB failure" } : null };
        return { data: null, error: null };
      }
      return q;
    },
  };
  return { admin: admin as unknown as SupabaseClient, writes, queries, rpcCalls };
}

beforeEach(() => {
  vi.clearAllMocks();
  ensure.mockResolvedValue("conversation");
  send.mockImplementation(async (_db, _ctx, _input, options) => {
    const message = { id: "message", status: "sent", external_id: "external" };
    await options?.beforeSend?.(message);
    return message;
  });
});

const templateId = "11111111-1111-4111-8111-111111111111";
const officialStep = { type: "template", template_id: templateId, language: "pt_BR", values: { "1": "Ana" }, delay_minutes: 0, message: "snapshot antigo" };

it("official step renders current definition and sends template through the same guarded sink once", async () => {
  const db = database({ step: officialStep, provider: "meta_cloud" });
  await processCampaign(db.admin, row());
  await processCampaign(db.admin, row());
  expect(send).toHaveBeenCalledOnce();
  expect(send.mock.calls[0]?.[2]).toMatchObject({ type: "template", body: "Olá Ana", template_name: "retorno",
    template_language: "pt_BR", template_values: { "1": "Ana" } });
  expect(db.rpcCalls.find((c) => c.fn === "finalize_whatsapp_campaign_step")?.args.p_status).toBe("sent");
});

it.each([
  { template: { status: "REJECTED" } }, { template: { organization_id: "org-b" } },
  { template: { channel_session_id: "other-channel" } }, { template: { language: "en_US" } },
  { step: { ...officialStep, values: {} } }, { provider: "waha" }, { templateError: true },
])("invalid official template fails closed without transport: %j", async (over) => {
  const db = database({ step: officialStep, provider: "meta_cloud", ...over });
  await processCampaign(db.admin, row());
  expect(send).not.toHaveBeenCalled();
  expect(db.rpcCalls.find((c) => c.fn === "finalize_whatsapp_campaign_step")?.args.p_status).toBe("failed");
});

it.each([{ blocked: true }, { declined: true }, { replied: true }, { optOutDuringSend: true }])(
  "official step preserves opt-out/reply guards: %j", async (over) => {
    const db = database({ step: officialStep, provider: "meta_cloud", ...over });
    await processCampaign(db.admin, row());
    expect(db.rpcCalls.find((c) => c.fn === "finalize_whatsapp_campaign_step")?.args.p_status)
      .toBe(over.replied ? "stopped_reply" : "skipped_opt_out");
  },
);

it("failed template message is never counted as sent", async () => {
  send.mockResolvedValue({ id: "message", status: "failed", error_code: "template_not_approved" });
  const db = database({ step: officialStep, provider: "meta_cloud" });
  await processCampaign(db.admin, row());
  expect(db.rpcCalls.find((c) => c.fn === "finalize_whatsapp_campaign_step")?.args).toMatchObject({
    p_status: "failed", p_failure_reason: "template_not_approved",
  });
});

it("finalize failure and event retry never send the official template twice", async () => {
  const db = database({ step: officialStep, provider: "meta_cloud", finalizeError: true });
  await expect(processCampaign(db.admin, row())).rejects.toThrow("campaign_finalize_failed");
  await processCampaign(db.admin, row());
  expect(send).toHaveBeenCalledOnce();
});

it("template timeout after accept remains terminal on replay", async () => {
  send.mockRejectedValue(new Error("timeout"));
  const db = database({ step: officialStep, provider: "meta_cloud" });
  await processCampaign(db.admin, row()); await processCampaign(db.admin, row());
  expect(send).toHaveBeenCalledOnce();
  expect(db.rpcCalls.find((c) => c.fn === "finalize_whatsapp_campaign_step")?.args.p_status).toBe("failed");
});

it("isolates tenant: foreign campaign never claims or sends", async () => {
  const db = database({ foreign: true });
  expect((await processCampaign(db.admin, row())).status).toBe("skipped");
  expect(db.admin.rpc).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
});
it("scheduled event cannot claim or send before database due time", async () => {
  const due = "2030-01-01T00:00:00Z";
  const db = database({ scheduled: true, notDue: due });
  expect(await processCampaign(db.admin, row())).toMatchObject({ status: "retry", retry_at: due });
  expect(db.rpcCalls).toEqual([{ fn: "start_scheduled_whatsapp_campaign", args: { p_organization_id: "org-a", p_campaign_id: "campaign" } }]);
  expect(send).not.toHaveBeenCalled();
});
it("due scheduled event starts then uses the same send and claim idempotency on replay", async () => {
  const db = database({ scheduled: true });
  await processCampaign(db.admin, row());
  await processCampaign(db.admin, row());
  expect(send).toHaveBeenCalledTimes(1);
  expect(db.rpcCalls[0]?.fn).toBe("start_scheduled_whatsapp_campaign");
  expect(db.rpcCalls.find((c) => c.fn === "finalize_whatsapp_campaign_step")?.args.p_status).toBe("sent");
});
it.each([{ blocked: true }, { declined: true }])("opt-out does not send and finalizes skipped_opt_out: %j", async (options) => {
  const db = database(options);
  await processCampaign(db.admin, row());
  expect(send).not.toHaveBeenCalled();
  expect(db.rpcCalls.find((c) => c.fn === "finalize_whatsapp_campaign_step")?.args.p_status).toBe("skipped_opt_out");
});
it("reply after start stops the step and never sends", async () => {
  const db = database({ replied: true });
  await processCampaign(db.admin, row({ step_index: 1, contact_id: "contact" }));
  expect(send).not.toHaveBeenCalled();
  expect(db.rpcCalls.find((c) => c.fn === "finalize_whatsapp_campaign_step")?.args.p_status).toBe("stopped_reply");
});
it.each([
  { organization_id: "org-b" },
  { channel_session_id: "other-channel" },
])("inbound from another workspace/channel does not stop the step: %j", async (inbound) => {
  // Cada fixture difere em apenas um filtro: omiti-lo no worker impede o envio.
  const db = database({ inbound });
  await processCampaign(db.admin, row({ step_index: 1, contact_id: "contact" }));
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0]?.[2].body).toBe("Follow up");
  expect(db.rpcCalls.find((c) => c.fn === "finalize_whatsapp_campaign_step")?.args).toMatchObject({
    p_status: "sent", p_message_id: "message", p_failure_reason: null,
  });
});
it("preserves literal text per step and links message before send", async () => {
  const db = database();
  await processCampaign(db.admin, row({ step_index: 1, contact_id: "contact" }));
  expect(send.mock.calls[0]?.[1].actor.type).toBe("user");
  expect(send.mock.calls[0]?.[2].body).toBe("Follow up");
  const finalize = db.rpcCalls.find((c) => c.fn === "finalize_whatsapp_campaign_step")?.args;
  expect(finalize?.p_status).toBe("sent");
  expect(finalize?.p_message_id).toBe("message");
  expect(db.writes[0]).toEqual({ message_id: "message" });
});
it("sent step is never resent on event replay", async () => {
  const db = database();
  await processCampaign(db.admin, row());
  await processCampaign(db.admin, row());
  expect(send).toHaveBeenCalledTimes(1);
});
it("transport uncertainty is terminal and never blindly retried", async () => {
  send.mockRejectedValue(new Error("transport timeout after accept"));
  const db = database();
  await processCampaign(db.admin, row());
  await processCampaign(db.admin, row());
  expect(send).toHaveBeenCalledTimes(1);
  expect(db.rpcCalls.find((c) => c.fn === "finalize_whatsapp_campaign_step")?.args.p_status).toBe("failed");
});
it.each([{ foreignChannel: true }, { foreignConversation: true }])("rejects foreign channel/conversation: %j", async (options) => {
  const db = database(options);
  await processCampaign(db.admin, row());
  expect(send).not.toHaveBeenCalled();
});
it("hourly quota defers through drain without sending", async () => {
  const retry = "2026-09-07T21:00:00.000Z";
  const db = database({ retry });
  expect(await processCampaign(db.admin, row())).toMatchObject({ status: "retry", retry_at: retry });
  expect(send).not.toHaveBeenCalled();
});
it("claims done return ok without sending", async () => {
  const db = database({ done: true });
  expect((await processCampaign(db.admin, row())).status).toBe("ok");
  expect(send).not.toHaveBeenCalled();
});
it("checks opt-out again in pre-transport hook", async () => {
  const transport = vi.fn();
  send.mockImplementation(async (_db, _ctx, _input, options) => {
    await options?.beforeSend?.({ id: "message" });
    transport();
    return { id: "message", status: "sent", external_id: "external" };
  });
  const db = database({ optOutDuringSend: true });
  await processCampaign(db.admin, row());
  expect(transport).not.toHaveBeenCalled();
  expect(db.rpcCalls.find((c) => c.fn === "finalize_whatsapp_campaign_step")?.args.p_status).toBe("skipped_opt_out");
});
it("link persistence failure prevents transport", async () => {
  const transport = vi.fn();
  send.mockImplementation(async (_db, _ctx, _input, options) => {
    await options?.beforeSend?.({ id: "message" });
    transport();
    return { id: "message", status: "sent", external_id: "external" };
  });
  const db = database({ linkError: true });
  await processCampaign(db.admin, row());
  expect(transport).not.toHaveBeenCalled();
});
it("queued result is not treated as sent or retried", async () => {
  send.mockResolvedValue({ id: "message", status: "queued", external_id: null });
  const db = database();
  await processCampaign(db.admin, row());
  await processCampaign(db.admin, row());
  expect(db.rpcCalls.find((c) => c.fn === "finalize_whatsapp_campaign_step")?.args.p_status).toBe("failed");
  expect(send).toHaveBeenCalledTimes(1);
});
