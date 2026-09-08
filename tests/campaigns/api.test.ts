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
function database(detail = false) {
  const filters: Array<[string, unknown]> = [];
  const ranges: number[][] = [];
  const rpc = vi.fn().mockResolvedValue({ data: id, error: null });
  const admin = {
    rpc,
    from: vi.fn((table: string) => {
      let rows: Array<Record<string, unknown>> = table === "contacts" ? contacts.map((c) => ({ ...c })) : [];
      let countHead = false;
      const q = {
        select: (...args: unknown[]) => { if (args[1] && typeof args[1] === "object") countHead = true; return q; },
        order: () => q,
        range: (start: number, end: number) => { ranges.push([start, end]); return q; },
        eq: (key: string, value: unknown) => { filters.push([key, value]); rows = rows.filter((r) => r[key] === value); return q; },
        is: (key: string, value: unknown) => { filters.push([key, value]); rows = rows.filter((r) => r[key] === value); return q; },
        in: (key: string, values: string[]) => { filters.push([key, values]); rows = rows.filter((r) => values.includes(r[key] as string)); return q; },
        contains: (key: string, values: string[]) => { filters.push([key, values]); rows = rows.filter((r) => values.every((v) => (r[key] as string[]).includes(v))); return q; },
        maybeSingle: async () => ({ data: detail && table === "whatsapp_campaigns" ? { ...input, organization_id: org, status: "running", started_at: "2026-09-07T00:00:00.000Z" } : null, error: null }),
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
        return { data: [], count: 0, error: null };
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
it("body cannot override tenant or request future scheduling", async () => {
  const db = database();
  expect((await POST(request({ ...input, organization_id: "foreign" }))).status).toBe(422);
  expect((await POST(request({ ...input, scheduled_at: "2027-01-01" }))).status).toBe(422);
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
