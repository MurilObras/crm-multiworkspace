// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  byteaParaHex,
  chaveDeIdempotencia,
  hashCanonico,
  idRecurso,
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
