import type { CreateAutomationRuleInput } from "@/lib/schemas/webhooks";

/**
 * A automação de compra Kiwify é o MESMO motor de regras (`automation_rules`) —
 * não há executor, fila ou scheduler próprio. Este módulo só monta o payload
 * canônico (trigger/condições/ação) e reconhece regras que já são deste tipo,
 * para a tela "criar ou gerenciar" sem duplicar lógica de envio.
 */

export const KIWIFY_PURCHASE_EVENT_TYPE = "order_approved";

/** Forma estrutural mínima de uma regra, sem acoplar a hooks de cliente. */
export interface KiwifyRuleLike {
  trigger_event: string;
  conditions: Array<{ field: string; op: string; value: string }>;
}

/** É a automação de compra Kiwify (gatilho lead.created + evento order_approved)? */
export function isKiwifyPurchaseRule(rule: KiwifyRuleLike): boolean {
  if (rule.trigger_event !== "lead.created") return false;
  return rule.conditions.some(
    (c) => c.field === "event.kiwify_event_type" && c.op === "eq" && c.value === KIWIFY_PURCHASE_EVENT_TYPE,
  );
}

export interface KiwifyPurchaseAutomationInput {
  name: string;
  productId: string;
  channelSessionId: string;
  /** Texto livre (quando a janela permite). Exclusivo em relação ao template. */
  template?: string;
  templateName?: string;
  templateLanguage?: string;
  templateValues?: Record<string, string>;
}

/**
 * Monta o payload canônico: trigger `lead.created`, condições AND
 * `event.kiwify_event_type = order_approved` e `event.product_id = <uuid>`,
 * ação `send_whatsapp_message` (texto livre OU template aprovado).
 */
export function buildKiwifyPurchaseAutomation(input: KiwifyPurchaseAutomationInput): CreateAutomationRuleInput {
  const config =
    typeof input.template === "string" && input.template.length > 0
      ? { channel_session_id: input.channelSessionId, template: input.template }
      : {
          channel_session_id: input.channelSessionId,
          template_name: input.templateName,
          template_language: input.templateLanguage,
          ...(input.templateValues ? { template_values: input.templateValues } : {}),
        };

  return {
    name: input.name,
    trigger_event: "lead.created",
    conditions: [
      { field: "event.kiwify_event_type", op: "eq", value: KIWIFY_PURCHASE_EVENT_TYPE },
      { field: "event.product_id", op: "eq", value: input.productId },
    ],
    actions: [{ type: "send_whatsapp_message", config }],
  };
}
