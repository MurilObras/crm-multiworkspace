import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { processCampaign } from "@/lib/campaigns/worker";
import { getAdapter, type ChannelProvider } from "@/lib/channels";
import * as templateTransport from "@/lib/channels/meta/send-template-for-session";
import type { EventRow } from "@/lib/event-log/dispatcher";

vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => { throw new Error("unexpected admin client"); } }));

type Row = Record<string, unknown>;
const templateId = "11111111-1111-4111-8111-111111111111";
/** Worker + ensureConversation + sink reais. Dublê só para banco e transporte;
 * os predicados são aplicados às linhas, incluindo o vínculo antes da rede. */
function database(provider: ChannelProvider, lastInboundAt: string | null, template: boolean) {
  const session = { id: "session", organization_id: "org", provider, status: "WORKING", archived_at: null,
    waha_session_name: "default", meta_phone_number_id: "123", zernio_account_id: "account" };
  const contact = { id: "contact", organization_id: "org", phone_number: "+5511999999999", is_blocked: false,
    consent: {}, is_anonymized: false, is_merged_into: null };
  const tables: Record<string, Row[]> = {
    whatsapp_campaigns: [{ id: "campaign", organization_id: "org", channel_session_id: "session", name: "Teste",
      status: "running", created_by: "user", started_at: new Date().toISOString(),
      steps: [template ? { type: "template", template_id: templateId, language: "pt_BR", values: {}, delay_minutes: 0, message: "Olá" }
        : { message: "Texto livre", delay_minutes: 0 }] }],
    channel_sessions: [session], contacts: [contact],
    conversations: [{ id: "conversation", organization_id: "org", channel_session_id: "session", contact_id: "contact",
      status: "open", is_group: false, group_chat_id: null, bot_silenced_until: null, last_inbound_at: lastInboundAt,
      contacts: contact, channel_sessions: session }],
    messages: [],
    meta_templates: [{ id: templateId, organization_id: "org", channel_session_id: "session", name: "retorno",
      language: "pt_BR", status: "APPROVED", contract_hash: "hash", parameter_format: "POSITIONAL",
      components: [{ type: "BODY", text: "Olá" }] }],
    whatsapp_campaign_recipient_steps: [{ id: "step", organization_id: "org", campaign_id: "campaign",
      contact_id: "contact", step_index: 0, status: "failed", message_id: null }],
  };
  let claimed = false;
  const finals: Row[] = [];
  const admin = {
    async rpc(fn: string, args: Row) {
      if (fn === "claim_whatsapp_campaign_step") {
        if (claimed) return { data: { done: true }, error: null };
        claimed = true;
        return { data: { step_id: "step", contact_id: "contact" }, error: null };
      }
      if (fn === "finalize_whatsapp_campaign_step") finals.push(args);
      return { data: true, error: null };
    },
    from(table: string) {
      const predicates: Array<(r: Row) => boolean> = [];
      let mode = "read";
      let patch: Row = {};
      const execute = () => {
        const rows = tables[table];
        if (!rows) throw new Error(`unexpected_table: ${table}`);
        if (mode === "insert") {
          const row = { id: "message", error_code: null, error_message: null, ...patch };
          rows.push(row); return { data: [row], error: null };
        }
        const found = rows.filter((r) => predicates.every((p) => p(r)));
        if (mode === "update") found.forEach((r) => Object.assign(r, patch));
        if (mode === "delete") tables[table] = rows.filter((r) => !found.includes(r));
        return { data: found.map((r) => ({ ...r })), error: null };
      };
      const q = {
        select: () => q, order: () => q, limit: () => q,
        eq(k: string, v: unknown) { predicates.push((r) => r[k] === v); return q; },
        neq(k: string, v: unknown) { predicates.push((r) => r[k] !== v); return q; },
        is(k: string, v: unknown) { predicates.push((r) => r[k] === v); return q; },
        in(k: string, v: unknown[]) { predicates.push((r) => v.includes(r[k])); return q; },
        gt(k: string, v: string) { predicates.push((r) => String(r[k]) > v); return q; },
        insert(p: Row) { mode = "insert"; patch = p; return q; },
        update(p: Row) { mode = "update"; patch = p; return q; },
        delete() { mode = "delete"; return q; },
        async maybeSingle() { const r = execute(); return { data: r.data[0] ?? null, error: null }; },
        async single() { return q.maybeSingle(); },
        async then(resolve: (v: ReturnType<typeof execute>) => unknown) { return resolve(execute()); },
      };
      return q;
    },
  };
  return { admin: admin as unknown as SupabaseClient, finals, tables };
}

const event: EventRow = { id: "event", organization_id: "org", entity_id: "campaign", payload: { step_index: 0 },
  event_type: "whatsapp_campaign.requested", entity_kind: "whatsapp_campaign", metadata: {}, consumed_by: [], attempts: 0 };
afterEach(() => vi.restoreAllMocks());

describe("campanha atravessa a janela universal e o sink reais", () => {
  it.each([
    ["waha", null, false, "sent"],
    ["meta_cloud", new Date().toISOString(), false, "sent"],
    ["meta_cloud", null, false, "failed"],
    ["meta_cloud", null, true, "sent"],
  ] as const)("%s inbound=%s template=%s => %s", async (provider, inbound, template, expected) => {
    const db = database(provider, inbound, template);
    const adapter = getAdapter(provider);
    vi.spyOn(adapter, "isConfigured").mockReturnValue(true);
    const textSend = vi.spyOn(adapter, "send").mockImplementation(async () => {
      expect(db.tables.whatsapp_campaign_recipient_steps?.[0]?.message_id).toBe("message");
      return { externalId: "wamid.text" };
    });
    const templateSend = vi.spyOn(templateTransport, "sendTemplateForSession").mockImplementation(async () => {
      expect(db.tables.whatsapp_campaign_recipient_steps?.[0]?.message_id).toBe("message");
      return "wamid.template";
    });
    await processCampaign(db.admin, event);
    await processCampaign(db.admin, event);
    expect(db.finals[0]?.p_status).toBe(expected);
    expect(db.tables.messages?.[0]?.status).toBe(expected);
    if (expected === "failed") {
      expect(db.finals[0]?.p_failure_reason).toBe("messaging_window_closed");
      expect(textSend).not.toHaveBeenCalled(); expect(templateSend).not.toHaveBeenCalled();
    } else if (template) {
      expect(templateSend).toHaveBeenCalledOnce(); expect(textSend).not.toHaveBeenCalled();
    } else {
      expect(textSend).toHaveBeenCalledOnce(); expect(templateSend).not.toHaveBeenCalled();
    }
  });
});
