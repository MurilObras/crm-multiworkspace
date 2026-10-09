// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fetchSubscriptionSnapshot, signLookup, SUBSCRIPTION_LOOKUP_URL } from "./subscription-lookup";
import { SubscriptionLookupUnavailableError } from "./subscription-errors";
const secret = "synthetic-key-that-is-longer-than-32-characters";
const user = "820d31a5-1b20-48f4-babc-9f7039034765";
const now = Date.parse("2026-10-12T12:00:00Z");
const event = { version: 2, event_type: "subscription_status_checked", event_id: "4d8f203c-9528-4e6f-a781-746b991da951",
  product_user_id: user, occurred_at: "2026-10-12T12:00:00Z", checked_at: "2026-10-12T12:00:00Z",
  trial_started_at: "2026-10-08T12:00:00Z", name: "Synthetic", email: "test@example.invalid", phone: "5562999990000",
  status_pagamento: "suspenso", access_enabled: false, em_trial: false, trial_ends_at: null, access_expires_at: null };
function response(payload: unknown = { data: event }, domain: "snapshot" | "lookup" = "snapshot", stamp = String(now / 1000)) {
  const raw = Buffer.from(JSON.stringify(payload));
  return new Response(raw, { headers: { "Content-Type": "application/json", "X-Obra-Timestamp": stamp,
    "X-Obra-Signature": signLookup(raw, stamp, secret, domain) } });
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); });
afterEach(() => vi.useRealTimers());
it("reconsulta a origem fixa sem redirecionamento e assina somente o UUID", async () => {
  const transport = vi.fn(async (_url, init) => {
    const body = init.body as Buffer;
    expect(JSON.parse(body.toString())).toEqual({ product_user_id: user });
    expect(init.headers["X-Obra-Signature"]).toBe(signLookup(body, String(now / 1000), secret, "lookup"));
    return response();
  });
  const result = await fetchSubscriptionSnapshot(user, secret, now, transport as typeof fetch);
  expect(result.decision).toBe("recover");
  expect(transport).toHaveBeenCalledWith(SUBSCRIPTION_LOOKUP_URL, expect.objectContaining({ redirect: "error", cache: "no-store" }));
});
it.each(["wrong_domain", "wrong_uuid", "old_snapshot", "old_signature", "contradictory_time", "extra_workspace"])("recusa %s", async kind => {
  let payload: unknown = { data: event };
  if (kind === "wrong_uuid") payload = { data: { ...event, product_user_id: event.event_id } };
  if (kind === "old_snapshot") payload = { data: { ...event, checked_at: "2026-10-12T11:57:00Z", trial_started_at: "2026-10-07T12:00:00Z" } };
  if (kind === "contradictory_time") payload = { data: { ...event, checked_at: "2026-10-12T11:59:59Z" } };
  if (kind === "extra_workspace") payload = { data: { ...event, organization_id: event.event_id } };
  await expect(fetchSubscriptionSnapshot(user, secret, now, vi.fn(async () => response(payload,
    kind === "wrong_domain" ? "lookup" : "snapshot", kind === "old_signature" ? String(now / 1000 - 301) : undefined)) as typeof fetch)).rejects.toThrow();
});
it("não aceita JSON sem assinatura, corpo grande, erro HTTP ou identificador arbitrário", async () => {
  for (const reply of [Response.json({ data: event }), new Response("no", { status: 503 }), response({ data: "x".repeat(17_000) })]) {
    await expect(fetchSubscriptionSnapshot(user, secret, now, vi.fn(async () => reply) as typeof fetch)).rejects.toThrow();
  }
  const transport = vi.fn();
  await expect(fetchSubscriptionSnapshot("forged", secret, now, transport)).rejects.toThrow();
  expect(transport).not.toHaveBeenCalled();
});
it.each([408, 425, 429, 500, 502, 503, 504])("HTTP %s adia somente por indisponibilidade temporária", async status => {
  await expect(fetchSubscriptionSnapshot(user, secret, now,
    vi.fn(async () => new Response(null, { status })) as typeof fetch)).rejects.toBeInstanceOf(SubscriptionLookupUnavailableError);
});
it.each([new TypeError("fetch failed"), new DOMException("timeout", "TimeoutError")])("rede/timeout é espera sanitizada", async error => {
  await expect(fetchSubscriptionSnapshot(user, secret, now, vi.fn(async () => { throw error; }) as typeof fetch))
    .rejects.toMatchObject({ name: "SubscriptionLookupUnavailableError", message: "subscription_lookup_unavailable" });
});
it("perda de conexão ao ler a resposta também permite nova consulta", async () => {
  const body = new ReadableStream({ start(controller) { controller.error(new TypeError("terminated")); } });
  await expect(fetchSubscriptionSnapshot(user, secret, now, vi.fn(async () =>
    new Response(body, { headers: { "Content-Type": "application/json" } })) as typeof fetch))
    .rejects.toBeInstanceOf(SubscriptionLookupUnavailableError);
});
it.each([400, 401, 403, 404, 422])("HTTP %s não vira espera por indisponibilidade", async status => {
  await expect(fetchSubscriptionSnapshot(user, secret, now,
    vi.fn(async () => new Response(null, { status })) as typeof fetch))
    .rejects.not.toBeInstanceOf(SubscriptionLookupUnavailableError);
});
it("assinatura inválida, JSON inválido e corpo excessivo não viram espera", async () => {
  for (const reply of [Response.json({ data: event }), response({ data: "x".repeat(17_000) }), response({ data: null })]) {
    await expect(fetchSubscriptionSnapshot(user, secret, now, vi.fn(async () => reply) as typeof fetch))
      .rejects.not.toBeInstanceOf(SubscriptionLookupUnavailableError);
  }
});
