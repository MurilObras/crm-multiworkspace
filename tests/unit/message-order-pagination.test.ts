import { describe, expect, it } from "vitest";
import { listMessagesHandler } from "@/app/api/v1/messages/_handler";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import type { SupabaseClient } from "@supabase/supabase-js";

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONV = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ctx = { organization_id: ORG, requestId: "r" } as HandlerCtx;
const at = "2026-10-13T14:16:00.000Z";
const rows = [
  {
    id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
    sent_at: at,
    created_at: "2026-10-13T14:16:00.100Z",
    organization_id: ORG,
    conversation_id: CONV,
  },
  {
    id: "11111111-1111-4111-8111-111111111111",
    sent_at: at,
    created_at: "2026-10-13T14:16:00.200Z",
    organization_id: ORG,
    conversation_id: CONV,
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    sent_at: at,
    created_at: "2026-10-13T14:16:00.300Z",
    organization_id: ORG,
    conversation_id: CONV,
  },
];
type Row = (typeof rows)[number];

// Duplo do PostgREST, não prova de banco. A prova com PostgREST real está no E2E.
function db(data = rows): SupabaseClient {
  return {
    from: () => {
      let current = [...data];
      const orders: Array<{ col: keyof Row; ascending: boolean }> = [];
      let cap = Infinity;
      const query = {
        select: () => query,
        eq: (col: keyof Row, value: string) => {
          current = current.filter((r) => r[col] === value);
          return query;
        },
        order: (col: keyof Row, o: { ascending: boolean }) => {
          orders.push({ col, ...o });
          return query;
        },
        limit: (n: number) => {
          cap = n;
          return query;
        },
        maybeSingle: async () => ({ data: current[0] ?? null, error: null }),
        or: (expression: string) => {
          const split = (s: string) => {
            let depth = 0;
            let start = 0;
            const out: string[] = [];
            for (let i = 0; i < s.length; i++) {
              if (s[i] === "(") depth++;
              if (s[i] === ")") depth--;
              if (s[i] === "," && !depth) {
                out.push(s.slice(start, i));
                start = i + 1;
              }
            }
            return [...out, s.slice(start)];
          };
          const evaluate = (s: string, row: Row): boolean => {
            if (s.startsWith("and("))
              return split(s.slice(4, -1)).every((part) => evaluate(part, row));
            const match = s.match(/^(\w+)\.(lt|eq)\.(.*)$/)!;
            return match[2] === "eq"
              ? row[match[1] as keyof Row] === match[3]
              : row[match[1] as keyof Row] < match[3]!;
          };
          current = current.filter((row) => split(expression).some((part) => evaluate(part, row)));
          return query;
        },
        then: (resolve: (value: { data: Row[]; error: null }) => unknown) =>
          resolve({
            data: current
              .sort((a, b) => {
                for (const o of orders) {
                  const cmp = a[o.col].localeCompare(b[o.col]);
                  if (cmp) return o.ascending ? cmp : -cmp;
                }
                return 0;
              })
              .slice(0, cap),
            error: null,
          }),
      };
      return query;
    },
  } as unknown as SupabaseClient;
}

describe("cursor da ordem temporal", () => {
  it("paginação em empate de sent_at não pula correção com UUID menor", async () => {
    const first = await listMessagesHandler(db(), ctx, CONV, { limit: 2 });
    expect(first.messages.map((m) => m.id)).toEqual([rows[1]!.id, rows[2]!.id]);
    const second = await listMessagesHandler(db(), ctx, CONV, { limit: 2, cursor: first.cursor! });
    expect(second.messages.map((m) => m.id)).toEqual([rows[0]!.id]);
    expect(second.has_more).toBe(false);
  });
  it("cursor legado descobre created_at da âncora e continua na mesma ordem", async () => {
    const cursor = Buffer.from(JSON.stringify({ sent_at: at, id: rows[1]!.id })).toString(
      "base64url",
    );
    const result = await listMessagesHandler(db(), ctx, CONV, { limit: 2, cursor });
    expect(result.messages.map((m) => m.id)).toEqual([rows[0]!.id]);
  });
  it("âncora legada de outro workspace não é aceita", async () => {
    const cursor = Buffer.from(JSON.stringify({ sent_at: at, id: rows[1]!.id })).toString(
      "base64url",
    );
    await expect(
      listMessagesHandler(
        db(rows.map((r) => ({ ...r, organization_id: "outra-org" }))),
        ctx,
        CONV,
        { limit: 2, cursor },
      ),
    ).rejects.toMatchObject({ code: "invalid_cursor" });
  });
  it("valores de filtro forjados são rejeitados antes de montar PostgREST", async () => {
    const cursor = Buffer.from(
      JSON.stringify({ sent_at: `${at},id.gt.0`, id: rows[1]!.id }),
    ).toString("base64url");
    await expect(listMessagesHandler(db(), ctx, CONV, { limit: 2, cursor })).rejects.toMatchObject({
      code: "invalid_cursor",
    });
  });
});
