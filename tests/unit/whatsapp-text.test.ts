import { describe, expect, it } from "vitest";
import { formatWhatsAppText } from "@/lib/agent-engine/edge/channel/whatsapp-text";

describe("texto enviado ao WhatsApp", () => {
  it("envia negrito simples, preservando preço e quebras", () => {
    expect(formatWhatsAppText("**Gestão Profissional**\nR$ **169,90** por mês.")).toBe(
      "*Gestão Profissional*\nR$ *169,90* por mês.",
    );
  });
  it("preserva código, URLs e texto já formatado; normalizar duas vezes não muda", () => {
    const source =
      "**Plano** `**literal**` https://example.test/**path**\n```\n**code**\n``` *pronto*";
    const formatted =
      "*Plano* `**literal**` https://example.test/**path**\n```\n**code**\n``` *pronto*";
    expect(formatWhatsAppText(source)).toBe(formatted);
    expect(formatWhatsAppText(formatted)).toBe(formatted);
  });
});
