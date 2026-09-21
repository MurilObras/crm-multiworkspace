import { registerAction } from "@/lib/automation/actions";
import type { ActionCtx, ActionResultDetail } from "@/lib/automation/types";
import { renderTemplate } from "@/lib/automation/template";
import { ensureConversation } from "@/lib/automation/start-conversation";
import { checkDailyLimit, espacarEnvio } from "@/lib/automation/throttle";
import { adiarAteAJanelaAbrir } from "@/lib/automation/janela-do-canal";
import type { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import { reportarEnvio, type MensagemEnviada } from "@/lib/automation/desfecho-do-envio";
import { checarGuardasDeContato } from "@/lib/automation/guarda-do-contato";
import { sendAutomationMessage } from "@/lib/automation/send-message";
import { actionSchema } from "@/lib/schemas/webhooks";
import { loadOfficialTemplate } from "@/lib/channels/official-template";

async function postponeUntil(ctx: ActionCtx, config: Record<string, unknown>): Promise<string | null> {
  const sessionId = typeof config.channel_session_id === "string" ? config.channel_session_id : null;
  if (!sessionId) return null; // config inválida falha no execute, não adia

  // A janela vem dos knobs DO NÚMERO (fuso do tenant, domingo configurável) —
  // a mesma régua da tela de Conexões e do agente. Ver janela-do-canal.ts.
  const foraDaJanela = await adiarAteAJanelaAbrir(ctx.admin, ctx.organizationId, sessionId);
  if (foraDaJanela) return foraDaJanela;

  const daily = await checkDailyLimit(ctx.admin, ctx.organizationId, sessionId);
  return daily.allowed ? null : (daily.retry_at ?? null);
}

async function execute(ctx: ActionCtx, config: Record<string, unknown>): Promise<ActionResultDetail> {
  if (!actionSchema.safeParse({ type:"send_whatsapp_message",config }).success) {
    return { type:"send_whatsapp_message",status:"failed",error:"invalid_config" };
  }
  const sessionId = typeof config.channel_session_id === "string" ? config.channel_session_id : null;
  const template = typeof config.template === "string" ? config.template : null;
  const templateName = typeof config.template_name === "string" ? config.template_name : null;
  const templateLanguage = typeof config.template_language === "string" ? config.template_language : null;
  if (!sessionId || (!template && !(templateName && templateLanguage))) {
    return { type: "send_whatsapp_message", status: "failed", error: "missing_config" };
  }
  // Guardas compartilhadas com send_ai_message — ver guarda-do-contato.ts
  // (existe/bloqueado/telefone/consentimento, este último um gate FIXO).
  const guarda = checarGuardasDeContato(ctx);
  if (!guarda.ok) return { type: "send_whatsapp_message", status: "skipped", detail: { reason: guarda.reason } };
  const contact = guarda.contact;

  // O espaçamento é COMPARTILHADO com a ação de IA (mesmo número, mesmo
  // contador) — ver lib/automation/throttle.ts.
  await espacarEnvio(sessionId);

  try {
    const values = config.template_values as Record<string, string> | undefined;
    const renderedValues = Object.fromEntries(Object.entries(values ?? {}).map(([key,value]) => [key,renderTemplate(value, ctx.context)]));
    const official = templateName && templateLanguage ? await loadOfficialTemplate(ctx.admin,ctx.organizationId,sessionId,
      {name:templateName,language:templateLanguage},renderedValues) : null;
    const conversationId = await ensureConversation(ctx.admin, ctx.organizationId, contact.id, sessionId);
    const body = official?.body ?? renderTemplate(template ?? "", ctx.context);
    const message = await sendAutomationMessage(
      ctx,
      { conversation_id: conversationId, ...(templateName ? {
        type: "template", template_name: templateName, template_language: templateLanguage ?? "",
        template_values: renderedValues,body,
      } : { type: "text", body }) } as Parameters<typeof sendMessageHandler>[2],
    );
    // O desfecho vem do ESTADO DA MENSAGEM, nunca da ausência de exceção:
    // `sendMessageHandler` marca `failed`/`queued` e devolve normalmente (ver
    // lib/automation/desfecho-do-envio.ts para o defeito medido).
    return await reportarEnvio(ctx, "send_whatsapp_message", message as unknown as MensagemEnviada, conversationId);
  } catch (err) {
    return {
      type: "send_whatsapp_message",
      status: "failed",
      error: err instanceof Error ? err.message.replace(/^official_template_/,"template_") : "action_failed",
    };
  }
}

registerAction({ type: "send_whatsapp_message", postponeUntil, execute });
