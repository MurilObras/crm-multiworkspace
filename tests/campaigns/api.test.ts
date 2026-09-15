import { beforeEach, expect, it, vi } from "vitest";
import { GET, POST } from "@/app/api/v1/campaigns/route";

const { requireRole, createAdminClient, audit } = vi.hoisted(() => ({
  requireRole: vi.fn(), createAdminClient: vi.fn(), audit: vi.fn(),
}));
vi.mock("@/lib/auth/require-role", () => ({ requireRole }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient }));
vi.mock("@/lib/audit", () => ({ audit }));
vi.mock("@/lib/contacts/cpf", () => ({ hashCpf: vi.fn(), encryptCpfSql: vi.fn() }));
vi.mock("@/lib/automation/start-conversation", () => ({ ensureConversation: vi.fn(), sessaoProntaParaEnvio: vi.fn() }));

const org = "a0000000-0000-4000-8000-000000000001";
const user = "a0000000-0000-4000-8000-000000000002";
const id = "a0000000-0000-4000-8000-000000000003";
const channel = "a0000000-0000-4000-8000-000000000004";
const input = {
  id, name: "Campaign", channel_session_id: channel,
  steps: [{ message: "Hi {{literal}}", delay_minutes: 0 }, { message: "Follow", delay_minutes: 60 }],
  filters: { tag: "vip" }, hourly_limit: 10,
};
const contacts = [
  { organization_id: org, tags: ["vip"], source: "manual", is_merged_into: null },
  { organization_id: org, tags: ["vip"], source: "whatsapp", is_merged_into: null },
  { organization_id: "foreign", tags: ["vip"], source: "manual", is_merged_into: null },
  { organization_id: org, tags: ["other"], source: "manual", is_merged_into: null },
  { organization_id: org, tags: ["vip"], source: "manual", is_merged_into: "merged" },
];
const templateId = "11111111-1111-4111-8111-111111111111";
const templateStep = { type: "template", template_id: templateId, language: "pt_BR", values: { "1": "Ana" }, delay_minutes: 0 };
function database(detail = false, options: { template?: Record<string, unknown>; provider?: string; existing?: boolean } = {}) {
  const filters: Array<[string, unknown]> = [];
  const ranges: number[][] = [];
  const rpc = vi.fn().mockResolvedValue({ data: id, error: null });
  const admin = {
    rpc,
    from: vi.fn((table: string) => {
      let rows: Array<Record<string, unknown>> = table === "contacts" ? contacts.map((c) => ({ ...c }))
        : table === "channel_sessions" ? [{ id: channel, organization_id: org, provider: options.provider ?? "meta_cloud", status: "WORKING", archived_at: null }]
        : table === "meta_templates" ? [{ id: templateId, organization_id: org, channel_session_id: channel,
          language: "pt_BR", name: "retorno", status: "APPROVED", parameter_format: "POSITIONAL",
          components: [{ type: "BODY", text: "Olá {{1}}" }], ...options.template }]
        : table === "whatsapp_campaigns" && options.existing ? [{ id, organization_id: org }] : [];
      let countHead = false;
      const q = {
        select: (...args: unknown[]) => { if (args[1] && typeof args[1] === "object") countHead = true; return q; },
        order: () => q,
        range: (start: number, end: number) => { ranges.push([start, end]); return q; },
        eq: (key: string, value: unknown) => { filters.push([key, value]); rows = rows.filter((r) => r[key] === value); return q; },
        is: (key: string, value: unknown) => { filters.push([key, value]); rows = rows.filter((r) => r[key] === value); return q; },
        in: (key: string, values: string[]) => { filters.push([key, values]); rows = rows.filter((r) => values.includes(r[key] as string)); return q; },
        contains: (key: string, values: string[]) => { filters.push([key, values]); rows = rows.filter((r) => values.every((v) => (r[key] as string[]).includes(v))); return q; },
        maybeSingle: async () => ({ data: detail && table === "whatsapp_campaigns" ? { ...input, organization_id: org, status: "running", started_at: "2026-09-07T00:00:00.000Z" } : rows[0] ?? null, error: null }),
        then: (fn: (v: unknown) => unknown) => Promise.resolve(resolve()).then(fn),
      };
      function resolve() {
        if (table === "contacts") return { data: null, count: rows.length, error: null };
        if (table === "whatsapp_campaign_recipient_steps") {
          if (countHead) return { data: null, count: 1, error: null };
          return { data: [], error: null };
        }
        if (table === "whatsapp_campaign_recipients") {
          return { data: Array.from({ length: 101 }, (_, i) => ({ id: `r${i}`, contact_id: `c${i}` })), error: null };
        }
        return { data: rows, count: 0, error: null };
      }
      return q;
    }),
  };
  createAdminClient.mockReturnValue(admin);
  return { admin, filters, rpc, ranges };
}
beforeEach(() => {
  vi.clearAllMocks();
  requireRole.mockResolvedValue({ ok: true, user: { id: user }, org: { orgId: org } });
});
const request = (value: unknown = input) => new Request("http://localhost/api/v1/campaigns", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value),
});

it.each([false, true])("template uses existing RPC with real rendered message and full official reference (extended=%s)", async (extended) => {
  const db = database();
  expect((await POST(request({ ...input, steps: [templateStep], ...(extended ? { scheduled_at: "2030-01-01T12:00:00.000Z" } : {}) }))).status).toBe(201);
  expect(db.rpc).toHaveBeenCalledWith(extended ? "prepare_whatsapp_campaign" : "launch_whatsapp_campaign", expect.objectContaining({
    p_organization_id: org, p_channel_session_id: channel,
    p_steps: [{ ...templateStep, message: "Olá Ana" }],
  }));
});
it.each([
  { template: { status: "PENDING" } }, { template: { organization_id: "other" } },
  { template: { channel_session_id: "other" } }, { template: { language: "en_US" } },
  { provider: "waha" },
])("invalid template/channel never starts a campaign: %j", async (options) => {
  const db = database(false, options);
  expect((await POST(request({ ...input, steps: [templateStep] }))).status).toBe(422);
  expect(db.rpc).not.toHaveBeenCalled();
});
it("caller-provided message cannot replace official body", async () => {
  const db = database();
  expect((await POST(request({ ...input, steps: [{ ...templateStep, message: "texto adulterado" }] }))).status).toBe(201);
  expect(db.rpc.mock.calls[0]?.[1].p_steps[0].message).toBe("Olá Ana");
});
it("missing template parameters fail before RPC", async () => {
  const db = database();
  expect((await POST(request({ ...input, steps: [{ ...templateStep, values: {} }] }))).status).toBe(422);
  expect(db.rpc).not.toHaveBeenCalled();
});
it("retry of existing official campaign does not recreate or depend on template still being approved", async () => {
  const db = database(false, { existing: true, template: { status: "REJECTED" } });
  const res = await POST(request({ ...input, steps: [templateStep] }));
  expect(res.status).toBe(201); expect(await res.json()).toMatchObject({ data: { id } });
  expect(db.rpc).not.toHaveBeenCalled();
});

it("server preview applies exact tag/source and tenant, excluding merged contacts", async () => {
  const db = database();
  const response = await GET(new Request("http://localhost/api/v1/campaigns?preview=1&tag=vip&source=manual"));
  expect(response.status).toBe(200);
  expect((await response.json()).data.count).toBe(1);
  expect(db.filters).toContainEqual(["organization_id", org]);
  expect(db.filters).toContainEqual(["tags", ["vip"]]);
  expect(db.filters).toContainEqual(["source", "manual"]);
});
it("server preview source is optional", async () => {
  database();
  const response = await GET(new Request("http://localhost/api/v1/campaigns?preview=1&tag=vip"));
  expect((await response.json()).data.count).toBe(2);
});
it("preview requires tag", async () => {
  const db = database();
  expect((await GET(new Request("http://localhost/api/v1/campaigns?preview=1"))).status).toBe(422);
  expect(db.admin.from).not.toHaveBeenCalled();
});
it("launch uses trusted organization and actor with one atomic RPC carrying steps", async () => {
  const db = database();
  expect((await POST(request())).status).toBe(201);
  expect(requireRole).toHaveBeenCalledWith("agent", expect.anything());
  expect(db.rpc).toHaveBeenCalledWith("launch_whatsapp_campaign", {
    p_id: id, p_organization_id: org, p_created_by: user, p_name: input.name,
    p_channel_session_id: channel, p_steps: input.steps, p_filters: input.filters, p_hourly_limit: 10,
  });
  expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "whatsapp_campaign.launched", organizationId: org }));
});
it("body cannot override tenant or send a date without time and offset", async () => {
  const db = database();
  expect((await POST(request({ ...input, organization_id: "foreign" }))).status).toBe(422);
  expect((await POST(request({ ...input, scheduled_at: "2027-01-01" }))).status).toBe(422);
  expect(db.rpc).not.toHaveBeenCalled();
});
it("list submission normalizes again on server and only passes trusted tenant to atomic prepare", async () => {
  const db = database();
  const { filters: _filters, ...listInput } = input;
  expect((await POST(request({ ...listInput, audience: [{ phone_number: "+553284793302" }] }))).status).toBe(201);
  expect(db.rpc).toHaveBeenCalledWith("prepare_whatsapp_campaign", expect.objectContaining({
    p_organization_id: org, p_created_by: user, p_filters: {},
    p_audience: [{ phone_number: "+5532984793302" }], p_scheduled_at: null,
  }));
});
it("scheduled tag request retains filters and UTC timestamp in the same atomic prepare", async () => {
  const db = database();
  const due = "2030-01-01T12:00:00.000Z";
  expect((await POST(request({ ...input, scheduled_at: due }))).status).toBe(201);
  expect(db.rpc).toHaveBeenCalledWith("prepare_whatsapp_campaign", expect.objectContaining({
    p_organization_id: org, p_filters: input.filters, p_audience: null, p_scheduled_at: due,
  }));
});
it("cannot mix audience modes, inject contact IDs or use invalid list phones", async () => {
  const db = database();
  expect((await POST(request({ ...input, audience: [{ phone_number: "+5511987654321" }] }))).status).toBe(422);
  expect((await POST(request({ ...input, filters: undefined, audience: [{ phone_number: "bad" }] }))).status).toBe(422);
  expect((await POST(request({ ...input, filters: undefined, audience: [{ phone_number: "+5511987654321", contact_id: id }] }))).status).toBe(422);
  expect(db.rpc).not.toHaveBeenCalled();
});
it("foreign channel RPC rejection becomes validation error, no audit success", async () => {
  const db = database();
  db.rpc.mockResolvedValue({ data: null, error: { code: "22023" } });
  expect((await POST(request())).status).toBe(422);
  expect(audit).not.toHaveBeenCalled();
});
it("unauthorized launch never reaches service role", async () => {
  requireRole.mockResolvedValue({ ok: false, response: new Response(null, { status: 403 }) });
  expect((await POST(request())).status).toBe(403);
  expect(createAdminClient).not.toHaveBeenCalled();
});
it("foreign campaign detail is not found and is queried in active tenant", async () => {
  const db = database();
  expect((await GET(new Request(`http://localhost/api/v1/campaigns?id=${id}`))).status).toBe(404);
  expect(db.filters).toContainEqual(["organization_id", org]);
});
it("detail counts five statuses and paginates recipients beyond the first hundred", async () => {
  const db = database(true);
  const response = await GET(new Request(`http://localhost/api/v1/campaigns?id=${id}&page=1`));
  const { data } = await response.json();
  expect(response.status).toBe(200);
  expect(data.recipients).toHaveLength(100);
  expect(data.has_more).toBe(true);
  expect(Object.keys(data.counts)).toEqual(["pending", "sent", "failed", "skipped_opt_out", "stopped_reply"]);
  expect(db.ranges).toEqual([[100, 200]]);
});
it("rejects invalid detail pagination", async () => {
  database();
  expect((await GET(new Request(`http://localhost/api/v1/campaigns?id=${id}&page=-1`))).status).toBe(422);
});
