import { beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { GET } from "./route";
vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn(async () => ({ ok: true, org: { orgId: "org" } })),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
const agent = "11111111-1111-4111-8111-111111111111";
type Row = Record<string, unknown>;
const rows: Record<string, Row[]> = {
  llm_calls: [
    {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      organization_id: "org",
      agent_id: agent,
      purpose: "agent_turn",
      status: "ok",
      created_at: "2026-10-15T12:00:00Z",
    },
    {
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      organization_id: "org",
      agent_id: agent,
      purpose: "agent_test",
      status: "ok",
      created_at: "2026-10-15T12:03:00Z",
    },
    {
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      organization_id: "other",
      agent_id: agent,
      purpose: "agent_turn",
      status: "ok",
      created_at: "2026-10-15T12:05:00Z",
    },
  ],
  ai_agent_runs: [
    {
      id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      organization_id: "org",
      agent_id: agent,
      is_dry_run: true,
      status: "failed",
      error_code: "agent_test_result_persist_failed",
      started_at: "2026-10-15T12:02:00Z",
      tool_calls: [],
    },
    {
      id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      organization_id: "other",
      agent_id: agent,
      is_dry_run: true,
      status: "completed",
      started_at: "2026-10-15T12:04:00Z",
    },
  ],
};
beforeEach(() => {
  vi.mocked(createClient).mockResolvedValue({
    from: (table: string) => {
      let result = [...rows[table]!],
        limit = Infinity;
      const query = {
        select: () => query,
        eq: (col: string, value: unknown) => {
          result = result.filter((r) => r[col] === value);
          return query;
        },
        neq: (col: string, value: unknown) => {
          result = result.filter((r) => r[col] !== value);
          return query;
        },
        order: () => query,
        limit: (value: number) => {
          limit = value;
          return query;
        },
        or: (expression: string) => {
          const match =
            /^(created_at|started_at)\.lt\.([^,]+),and\(\1\.eq\.[^,]+,id\.lt\.([^\)]+)\)$/.exec(
              expression,
            )!;
          result = result.filter(
            (r) =>
              String(r[match[1]!]) < match[2]! ||
              (String(r[match[1]!]) === match[2] && String(r.id) < match[3]!),
          );
          return query;
        },
        then: (resolve: (value: unknown) => unknown) =>
          resolve({
            data: result
              .sort((a, b) =>
                String(b.created_at ?? b.started_at).localeCompare(
                  String(a.created_at ?? a.started_at),
                ),
              )
              .slice(0, limit),
            error: null,
          }),
      };
      return query;
    },
  } as never);
});
const ctx = { params: Promise.resolve({ id: agent }) };
it("lista o resultado completo do teste, sem duplicá-lo como produção nem vazar outro workspace", async () => {
  const response = await GET(new NextRequest("http://localhost/x?limit=10"), ctx);
  const { data } = await response.json();
  expect(data.map((r: Row) => r.id)).toEqual([
    "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  ]);
  expect(data[0]).toMatchObject({
    is_dry_run: true,
    status: "failed",
    error_code: "agent_test_result_persist_failed",
  });
  expect(data[1]).toMatchObject({ is_dry_run: false, status: "completed" });
});
it("pagina o conjunto de testes e produção sem repetir nem pular uma fonte", async () => {
  const first = await (await GET(new NextRequest("http://localhost/x?limit=1"), ctx)).json();
  expect(first.data).toHaveLength(1);
  expect(first.meta.has_more).toBe(true);
  const second = await (
    await GET(new NextRequest(`http://localhost/x?limit=1&cursor=${first.meta.cursor}`), ctx)
  ).json();
  expect(second.data.map((r: Row) => r.id)).toEqual(["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"]);
  expect(second.meta.has_more).toBe(false);
});
it("filtro de falha inclui teste que teve chamada ao modelo bem-sucedida", async () => {
  const { data } = await (
    await GET(new NextRequest("http://localhost/x?status=failed"), ctx)
  ).json();
  expect(data).toHaveLength(1);
  expect(data[0].is_dry_run).toBe(true);
});
