// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  byteaParaHex,
  chaveDeIdempotencia,
  hashCanonico,
  idRecurso,
  reservarOuReplay,
} from "./idempotency";

describe("hashCanonico", () => {
  it("é estável e independente da ordem das chaves do objeto", () => {
    const a = { body: "oi", type: "text", conversation_id: "c" };
    const b = { conversation_id: "c", type: "text", body: "oi" };
    expect(hashCanonico(a)).toBe(hashCanonico(b));
  });
  it("difere para payload diferente", () => {
    expect(hashCanonico({ body: "a" })).not.toBe(hashCanonico({ body: "b" }));
  });
  it("ignora undefined (metadados opcionais ausentes não quebram o hash)", () => {
    expect(hashCanonico({ body: "oi", extra: undefined })).toBe(hashCanonico({ body: "oi" }));
  });
});

describe("idRecurso", () => {
  it("é determinístico para os mesmos insumos", () => {
    expect(idRecurso("org", "ator", "/x", "k")).toBe(idRecurso("org", "ator", "/x", "k"));
  });
  it("gera uuid válido", () => {
    expect(idRecurso("org", "ator", "/x", "k")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
  it("isola por org, ator, endpoint e chave", () => {
    const base = idRecurso("org", "ator", "/x", "k");
    expect(idRecurso("org2", "ator", "/x", "k")).not.toBe(base);
    expect(idRecurso("org", "ator2", "/x", "k")).not.toBe(base);
    expect(idRecurso("org", "ator", "/y", "k")).not.toBe(base);
    expect(idRecurso("org", "ator", "/x", "k2")).not.toBe(base);
  });
});

describe("chaveDeIdempotencia", () => {
  it("vincula a chave ao ator autenticado", () => {
    expect(chaveDeIdempotencia("ator", "k")).toBe("ator:k");
  });
});

describe("byteaParaHex", () => {
  it("normaliza Buffer, string \\x... e string pura", () => {
    expect(byteaParaHex(Buffer.from("ab", "hex"))).toBe("ab");
    expect(byteaParaHex("\\xab")).toBe("ab");
    expect(byteaParaHex("ab")).toBe("ab");
    expect(byteaParaHex(null)).toBe("");
  });
});

describe("reservarOuReplay", () => {
  function fakeAdmin(insertError: { code?: string } | null, lookupHashHex?: string): {
    admin: SupabaseClient;
    capturou: () => Record<string, unknown>;
  } {
    let inserido: Record<string, unknown> = {};
    const builder = {
      insert: (row: Record<string, unknown>) => {
        inserido = row;
        return {
          select: () => ({
            single: async () => ({ data: insertError ? null : { id: "row" }, error: insertError }),
          }),
        };
      },
      select: () => ({
        eq: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: lookupHashHex !== undefined
                  ? { request_hash: Buffer.from(lookupHashHex, "hex"), response_body: {} }
                  : null,
                error: null,
              }),
            }),
          }),
        }),
      }),
    };
    return {
      admin: { from: () => builder } as unknown as SupabaseClient,
      capturou: () => inserido,
    };
  }

  const args = {
    organizationId: "org",
    endpoint: "/api/v1/messages",
    chave: "ator:k",
    hash: hashCanonico({ body: "oi" }),
    recursoId: "00000000-0000-4000-8000-000000000001",
  };

  it("INSERT sem colisão → reservado (request_hash sai como string \\x<hex>, não Buffer)", async () => {
    const { admin, capturou } = fakeAdmin(null);
    const r = await reservarOuReplay(admin, args);
    expect(r).toEqual({ tipo: "reservado", recursoId: args.recursoId });
    expect(capturou().request_hash).toBe(`\\x${args.hash}`);
  });

  it("colisão com hash DIFERENTE → conflito (sem novo efeito)", async () => {
    const { admin } = fakeAdmin({ code: "23505" }, hashCanonico({ body: "outro" }));
    const r = await reservarOuReplay(admin, args);
    expect(r).toEqual({ tipo: "conflito" });
  });

  it("colisão com hash IGUAL → replay", async () => {
    const { admin } = fakeAdmin({ code: "23505" }, args.hash);
    const r = await reservarOuReplay(admin, args);
    expect(r).toEqual({ tipo: "replay", recursoId: args.recursoId });
  });

  it("erro de escrita que NÃO é colisão propaga (não libera execução)", async () => {
    const { admin } = fakeAdmin({ code: "42P01" });
    await expect(reservarOuReplay(admin, args)).rejects.toMatchObject({ code: "42P01" });
  });
});
