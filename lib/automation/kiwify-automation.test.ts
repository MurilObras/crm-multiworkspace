import { describe, expect, it } from "vitest";
import {
  buildKiwifyPurchaseAutomation,
  isKiwifyPurchaseRule,
  KIWIFY_PURCHASE_EVENT_TYPE,
} from "./kiwify-automation";

const productId = "33333333-3333-4333-8333-333333333333";
const channelSessionId = "44444444-4444-4444-8444-444444444444";

describe("isKiwifyPurchaseRule", () => {
  it("reconhece gatilho lead.created + condição de evento aprovado", () => {
    expect(
      isKiwifyPurchaseRule({
        trigger_event: "lead.created",
        conditions: [
          { field: "event.kiwify_event_type", op: "eq", value: "order_approved" },
          { field: "event.product_id", op: "eq", value: productId },
        ],
      }),
    ).toBe(true);
  });
  it("não confunde com outra automação lead.created sem o evento kiwify", () => {
    expect(
      isKiwifyPurchaseRule({
        trigger_event: "lead.created",
        conditions: [{ field: "lead.tags", op: "contains", value: "x" }],
      }),
    ).toBe(false);
  });
  it("não confunde com outro gatilho", () => {
    expect(
      isKiwifyPurchaseRule({
        trigger_event: "message.received",
        conditions: [{ field: "event.kiwify_event_type", op: "eq", value: "order_approved" }],
      }),
    ).toBe(false);
  });
});

describe("buildKiwifyPurchaseAutomation", () => {
  it("gera trigger, condições AND e ação de texto livre", () => {
    const out = buildKiwifyPurchaseAutomation({
      name: "Aviso de compra",
      productId,
      channelSessionId,
      template: "Oi, obrigado pela compra!",
    });
    expect(out.trigger_event).toBe("lead.created");
    expect(out.conditions).toEqual([
      { field: "event.kiwify_event_type", op: "eq", value: KIWIFY_PURCHASE_EVENT_TYPE },
      { field: "event.product_id", op: "eq", value: productId },
    ]);
    expect(out.actions).toEqual([
      { type: "send_whatsapp_message", config: { channel_session_id: channelSessionId, template: "Oi, obrigado pela compra!" } },
    ]);
  });
  it("gera ação de template aprovado quando não há texto livre", () => {
    const out = buildKiwifyPurchaseAutomation({
      name: "Aviso de compra",
      productId,
      channelSessionId,
      templateName: "boas_vindas",
      templateLanguage: "pt_BR",
      templateValues: { "0": "Maria" },
    });
    expect(out.actions).toEqual([
      {
        type: "send_whatsapp_message",
        config: {
          channel_session_id: channelSessionId,
          template_name: "boas_vindas",
          template_language: "pt_BR",
          template_values: { "0": "Maria" },
        },
      },
    ]);
  });
});
