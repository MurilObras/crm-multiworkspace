// @vitest-environment node
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { kiwifyConfigSchema, kiwifyFingerprint, normalizeKiwify, readKiwifyBody, verifyKiwifySignature } from "./kiwify";
import { mapInboundPayload, verifyInboundSignature } from "./inbound";
import { sentryScrubHooks } from "@/lib/sentry/scrub";

const secret = "synthetic-only";
const payload = {
  order_id: "order-test", store_id: "store-test", webhook_event_type: "order_approved", order_status: "paid",
  Product: { product_id: "product-test", product_name: "Curso fictício" },
  Customer: { full_name: " Pessoa Fictícia ", email: " PERSON@example.invalid ", mobile: "+12025550123" },
};
const sign = (p: unknown) => createHmac("sha1", secret).update(JSON.stringify(p), "utf8").digest("hex");
describe("contrato Kiwify", () => {
  it("baseline distribui exatamente a migration revisada", () => {
    const migration = readFileSync("supabase/migrations/20260920120000_0220_kiwify_ingestion.sql", "utf8").replaceAll("\r\n", "\n").trim();
    const baseline = readFileSync("supabase/baseline.sql", "utf8").replaceAll("\r\n", "\n");
    expect(baseline).toContain(migration);
  });
  it("verifica SHA1 hex em query, sem aceitar protocolo genérico", () => {
    expect(verifyKiwifySignature(payload, [sign(payload)], secret)).toBe(true);
    expect(verifyInboundSignature(JSON.stringify(payload), sign(payload), secret)).toBe(false);
    const generic = createHmac("sha256", secret).update(JSON.stringify(payload)).digest("hex");
    expect(verifyInboundSignature(JSON.stringify(payload), generic, secret)).toBe(true);
    expect(verifyKiwifySignature(payload, [generic], secret)).toBe(false);
  });
  it.each([[], [""], ["z".repeat(40)], ["0".repeat(39)], ["0".repeat(40)], [sign(payload), sign(payload)]].map(signatures => ({ signatures })))("rejeita assinatura ausente/malformada/inválida $signatures", ({ signatures }) => {
    expect(verifyKiwifySignature(payload, signatures, secret)).toBe(false);
  });
  it("não aceita corpo alterado nem segredo ausente", () => {
    expect(verifyKiwifySignature({ ...payload, order_status: "refunded" }, [sign(payload)], secret)).toBe(false);
    expect(verifyKiwifySignature(payload, [sign(payload)], "")).toBe(false);
  });
  it("preserva bytes da serialização oficial: Unicode, escapes, espaços, ordem e números", async () => {
    const raw = '{ "z": "\\u00e1", "a": 1.0, "Customer": {"full_name":" Pessoa "} }';
    const parsed = await readKiwifyBody(new Request("https://test.invalid", { method: "POST", body: raw }));
    const expected = createHmac("sha1", secret).update('{"z":"á","a":1,"Customer":{"full_name":" Pessoa "}}', "utf8").digest("hex");
    expect(verifyKiwifySignature(parsed, [expected], secret)).toBe(true);
    expect(verifyKiwifySignature(parsed, [createHmac("sha1", secret).update(raw).digest("hex")], secret)).toBe(false);
  });
  it("recusa UTF-8 inválido, JSON malformado e limite sem Content-Length", async () => {
    for (const body of [new Uint8Array([0xff]), "{", " ".repeat(256 * 1024 + 1)]) {
      await expect(readKiwifyBody(new Request("https://test.invalid", { method: "POST", body }))).rejects.toThrow();
    }
  });
  it("normaliza aninhados; genérico mantém contrato de campos no topo", () => {
    expect(normalizeKiwify(payload)).toMatchObject({ name: "Pessoa Fictícia", email: "person@example.invalid", phone: "+12025550123", product_id: "product-test" });
    expect(mapInboundPayload(payload)).toMatchObject({ name: null, email: null, phone: null });
  });
  it.each([null, [], { ...payload, Customer: [] }, { ...payload, Product: "x" }, { ...payload, order_id: 2 }, { ...payload, Customer: { mobile: 123 } }, { ...payload, Customer: { full_name: "x".repeat(201) } }])("recusa tipos/limites inválidos", p => {
    expect(() => normalizeKiwify(p)).toThrow();
  });
  it("nome/email/telefone inválidos não viram destinatário ou dados para sobrescrever", () => {
    expect(normalizeKiwify({ ...payload, Customer: { full_name: "\u0000", email: "invalid", mobile: "call 12025550123" } })).toMatchObject({ name: null, email: null, phone: null });
    expect(normalizeKiwify({ ...payload, Customer: null })).toMatchObject({ name: null, email: null, phone: null });
  });
  it("fingerprint ignora campos descartados e detecta conteúdo material", () => {
    const original = kiwifyFingerprint(normalizeKiwify(payload));
    expect(kiwifyFingerprint(normalizeKiwify({ ...payload, updated_at: "later" }))).toBe(original);
    expect(kiwifyFingerprint(normalizeKiwify({ ...payload, Product: { product_id: "other" } }))).not.toBe(original);
  });
  it("configuração exige mapeamento explícito e IDs sem repetição", () => {
    expect(kiwifyConfigSchema.safeParse({}).success).toBe(false);
  });
  it("telemetria remove corpo, query sensível e token", () => {
    const e = sentryScrubHooks.beforeSend({ request: { url: "https://test.invalid/api/v1/webhooks/kiwify/token?signature=secret", query_string: { signature: "secret" }, data: payload } });
    expect(JSON.stringify(e)).not.toContain("secret");
    expect(e.request).not.toHaveProperty("data");
    expect(e.request.url).not.toContain("/token");
  });
});
