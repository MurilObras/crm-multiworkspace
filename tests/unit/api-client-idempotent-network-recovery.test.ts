// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiClient } from "@/lib/api/client";
import { z } from "zod";

const fetchMock = vi.fn<typeof fetch>();
const response = () => new Response(JSON.stringify({ data: { id: "same-persisted-resource" } }), {
  status: 201, headers: { "Content-Type": "application/json" },
});
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("recuperação limitada de escrita idempotente após perder resposta", () => {
  it.each(["/api/v1/messages", "/api/v1/automation-rules"])("%s conserva chave, corpo e request id nas três tentativas", async path => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(response());
    expect(await apiClient.post(path, { body: "Mesmo conteúdo" }, { idempotencyKey: "stable-operation-key" }))
      .toEqual({ data: { id: "same-persisted-resource" } });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const calls = fetchMock.mock.calls.map(([url, init]) => ({ url, body: init?.body, headers: init?.headers }));
    expect(calls[1]).toEqual(calls[0]);
    expect(calls[2]).toEqual(calls[0]);
    expect(calls[0]!.headers).toMatchObject({ "Idempotency-Key": "stable-operation-key" });
  });

  it("encerra depois de três perdas sem fabricar sucesso ou uma nova chave", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    await expect(apiClient.post("/api/v1/messages", {}, { idempotencyKey: "stable-operation-key", maxAttempts: 50 }))
      .rejects.toThrow("fetch failed");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("respeita uma simulação ou chamada limitada explicitamente a uma tentativa", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    await expect(apiClient.post("/api/v1/messages", {}, { idempotencyKey: "stable-operation-key", maxAttempts: 1 }))
      .rejects.toThrow("fetch failed");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each(["/api/v1/messages", "/api/v1/agents/test", "/api/v1/unverified-write"])("%s não repete sem chave explícita", async path => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    await expect(apiClient.post(path, {})).rejects.toThrow("fetch failed");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("uma chave explícita não habilita replay numa rota sem contrato auditado", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    await expect(apiClient.post("/api/v1/unverified-write", {}, { idempotencyKey: "stable-operation-key" }))
      .rejects.toThrow("fetch failed");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("não começa outra tentativa quando a espera excederia o orçamento total", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    await expect(apiClient.post("/api/v1/messages", {}, { idempotencyKey: "stable-operation-key", timeoutMs: 10 }))
      .rejects.toThrow("fetch failed");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("um TypeError na leitura ou validação da resposta não vira nova escrita", async () => {
    fetchMock.mockResolvedValueOnce(response());
    const schema = z.unknown().transform(() => { throw new TypeError("schema transform failed"); });
    await expect(apiClient.post("/api/v1/messages", {}, { idempotencyKey: "stable-operation-key", schema }))
      .rejects.toThrow("schema transform failed");
    expect(fetchMock).toHaveBeenCalledOnce();
    fetchMock.mockClear();
    const res = response();
    vi.spyOn(res, "text").mockRejectedValueOnce(new TypeError("body interrupted"));
    fetchMock.mockResolvedValueOnce(res);
    await expect(apiClient.post("/api/v1/messages", {}, { idempotencyKey: "stable-operation-key" }))
      .rejects.toThrow("body interrupted");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("não repete timeout nem cancelamento do chamador", async () => {
    fetchMock.mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(new TypeError("aborted fetch")), { once: true });
    }));
    await expect(apiClient.post("/api/v1/messages", {}, { idempotencyKey: "stable-operation-key", timeoutMs: 20 }))
      .rejects.toThrow("aborted fetch");
    expect(fetchMock).toHaveBeenCalledOnce();
    fetchMock.mockClear();
    const caller = new AbortController();
    fetchMock.mockImplementationOnce(async () => { caller.abort(); throw new TypeError("caller aborted"); });
    await expect(apiClient.post("/api/v1/messages", {}, { idempotencyKey: "stable-operation-key", signal: caller.signal }))
      .rejects.toThrow("caller aborted");
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
