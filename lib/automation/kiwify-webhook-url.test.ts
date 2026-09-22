import { describe, expect, it } from "vitest";
import { webhookUrlKiwify } from "./kiwify-webhook-url";

describe("webhookUrlKiwify", () => {
  it("monta URL completa a partir do path_token cru (GET da integração)", () => {
    expect(webhookUrlKiwify("https://app.minhaempresa.com.br", "abc123")).toBe(
      "https://app.minhaempresa.com.br/api/v1/webhooks/kiwify/abc123",
    );
  });
  it("aceita o endpoint já com a barra (POST da integração)", () => {
    expect(webhookUrlKiwify("https://app.minhaempresa.com.br", "/api/v1/webhooks/kiwify/abc123")).toBe(
      "https://app.minhaempresa.com.br/api/v1/webhooks/kiwify/abc123",
    );
  });
  it("não duplica barra quando a origem termina com '/'", () => {
    expect(webhookUrlKiwify("https://app.minhaempresa.com.br/", "abc123")).toBe(
      "https://app.minhaempresa.com.br/api/v1/webhooks/kiwify/abc123",
    );
  });
});
