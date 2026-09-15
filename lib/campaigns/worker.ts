import type { SupabaseClient } from "@supabase/supabase-js";
import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import { ensureConversation } from "@/lib/automation/start-conversation";
import { checarGuardasDeContato } from "@/lib/automation/guarda-do-contato";
import type { EventHandler, EventRow, HandlerResult } from "@/lib/event-log/dispatcher";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Campaign, RecipientStatus } from "./schema";
import { campaignStepSchema } from "./schema";
import { isTemplateStep, prepareCampaignTemplate } from "./template-step";

const key = "whatsapp_campaign_send";

interface StepClaim {
  step_id?: string;
  contact_id?: string;
  done?: boolean;
  retry_at?: string;
}

/**
 * O consumidor deterministico da campanha. Cada evento carrega um `step_index`
 * e, para os passos que nao sao o primeiro, um `contact_id` (o passo 0 e
 * drenado por um unico evento de lote). A cota por hora e compartilhada pelo
 * mesmo canal porque a reserva acontece no banco (claim_whatsapp_campaign_step)
 * com lock na sessao do canal — nunca em memoria do processo.
 */
export async function processCampaign(admin: SupabaseClient, row: EventRow): Promise<HandlerResult> {
  const org = row.organization_id;
  const campaignId = row.entity_id;
  const result = (status: HandlerResult["status"], extra = {}): HandlerResult => ({ consumer_key: key, status, ...extra });
  if (!campaignId) return result("skipped");

  const stepIndex = typeof row.payload?.step_index === "number" ? row.payload.step_index : 0;
  const payloadContactId = typeof row.payload?.contact_id === "string" ? row.payload.contact_id : null;

  const { data, error } = await admin.from("whatsapp_campaigns").select("*")
    .eq("organization_id", org).eq("id", campaignId).maybeSingle();
  if (error) throw new Error("campaign_read_failed");
  if (!data) return result("skipped");
  const campaign = data as Campaign;
  if (campaign.status === "scheduled") {
    const { data: start, error: startError } = await admin.rpc("start_scheduled_whatsapp_campaign", {
      p_organization_id: org, p_campaign_id: campaignId,
    });
    if (startError) throw new Error("campaign_start_failed");
    if (start?.retry_at) return result("retry", { retry_at: start.retry_at });
    if (start?.status !== "running") return result("skipped");
    campaign.status = "running";
    campaign.started_at = start.started_at;
  }
  if (campaign.status !== "running") return result("skipped");
  if (stepIndex < 0 || stepIndex >= campaign.steps.length) return result("skipped");

  const { data: claim, error: claimError } = await admin.rpc("claim_whatsapp_campaign_step", {
    p_organization_id: org, p_campaign_id: campaignId, p_step_index: stepIndex,
    ...(payloadContactId ? { p_contact_id: payloadContactId } : {}),
  });
  if (claimError) throw new Error("campaign_claim_failed");
  const c = claim as StepClaim;
  if (c.done) return result("ok");
  if (c.retry_at) return result("retry", { retry_at: c.retry_at });
  if (!c.step_id || !c.contact_id) return result("skipped", { detail: "campaign_claim_empty" });

  const stepId = c.step_id;
  const contactId = c.contact_id;

  let status: RecipientStatus = "failed";
  let reason: string | null = "send_uncertain_manual_inspection";
  let messageId: string | null = null;

  const loadContact = () => admin.from("contacts")
    .select("id, phone_number, is_blocked, consent, is_anonymized, is_merged_into")
    .eq("organization_id", org).eq("id", contactId).maybeSingle();

  try {
    const step = campaignStepSchema.safeParse(campaign.steps[stepIndex]);
    if (!step.success) {
      reason = "campaign_step_invalid";
      throw new Error(reason);
    }
    const { data: contact } = await loadContact();
    if (!contact) {
      reason = "contact_missing";
      throw new Error(reason);
    }
    // Recusa tem precedencia: um contato bloqueado (ou que recusou marketing)
    // nunca recebe nenhum passo.
    if (contact.is_blocked || contact.consent?.marketing?.declined_at) {
      status = "skipped_opt_out";
      reason = "contact_opt_out";
      throw new Error(reason);
    }
    const guard = checarGuardasDeContato({
      admin, organizationId: org, ruleId: campaignId, ruleName: campaign.name,
      event: row, context: { contact }, requestId: row.id,
    });
    if (!guard.ok || contact.is_anonymized || contact.is_merged_into) {
      reason = guard.ok ? "contact_unavailable" : guard.reason;
      throw new Error(reason);
    }

    // Resposta do contato apos o inicio da campanha interrompe os proximos passos.
    const { data: replied } = await admin.from("messages").select("id")
      .eq("organization_id", org).eq("contact_id", contactId)
      .eq("channel_session_id", campaign.channel_session_id)
      .eq("direction", "inbound").gt("created_at", campaign.started_at).limit(1).maybeSingle();
    if (replied) {
      status = "stopped_reply";
      reason = "contact_replied";
      throw new Error(reason);
    }

    const { data: channel, error: channelError } = await admin.from("channel_sessions")
      .select("id").eq("organization_id", org).eq("id", campaign.channel_session_id)
      .eq("status", "WORKING").is("archived_at", null).maybeSingle();
    if (channelError || !channel || !campaign.created_by) {
      reason = "channel_or_creator_unavailable";
      throw new Error(reason);
    }

    let official;
    if (isTemplateStep(step.data)) {
      try {
        official = await prepareCampaignTemplate(admin, org, campaign.channel_session_id, step.data);
      } catch (err) {
        reason = err instanceof Error ? err.message : "campaign_template_invalid";
        throw err;
      }
    }
    const conversationId = await ensureConversation(admin, org, contactId, campaign.channel_session_id);
    const { data: conversation, error: convError } = await admin.from("conversations").select("id")
      .eq("id", conversationId).eq("organization_id", org).eq("contact_id", contactId)
      .eq("channel_session_id", campaign.channel_session_id).eq("is_group", false).maybeSingle();
    if (convError || !conversation) throw new Error("campaign_conversation_mismatch");

    const message = await sendMessageHandler(admin, {
      organization_id: org, actor: { type: "user", id: campaign.created_by }, requestId: row.id,
    }, {
      conversation_id: conversationId,
      ...(official ? { type: "template" as const, body: official.body,
        template_name: official.template.name, template_language: official.template.language,
        template_values: official.template.values }
        : { type: "text" as const, body: step.data.message }),
      metadata: { campaign_id: campaignId, campaign_step_index: stepIndex, campaign_contact_id: contactId },
    }, { beforeSend: async (message) => {
      messageId = message.id;
      const { data: linked, error: linkError } = await admin.from("whatsapp_campaign_recipient_steps")
        .update({ message_id: message.id }).eq("organization_id", org).eq("campaign_id", campaignId)
        .eq("contact_id", contactId).eq("step_index", stepIndex).eq("id", stepId)
        .eq("status", "failed").is("message_id", null).select("id").single();
      if (linkError || !linked) throw new Error("campaign_message_link_failed");
      const { data: recontact } = await loadContact();
      if (recontact?.is_blocked || recontact?.consent?.marketing?.declined_at) {
        status = "skipped_opt_out";
        reason = "contact_opt_out";
        throw new Error(reason);
      }
    } });
    messageId = message.id;
    if (message.status === "sent" && message.external_id) {
      status = "sent";
      reason = null;
    } else if (message.error_code) {
      reason = message.error_code;
    }
  } catch {
    // Inclusive timeout e queda depois do aceite: jamais chamar send de novo.
  }

  // Finaliza atomico: grava o desfecho e, se 'sent', agenda o proximo passo
  // (linha + evento) na mesma transacao. Replay idempotente retorna false.
  const { error: finalizeError } = await admin.rpc("finalize_whatsapp_campaign_step", {
    p_organization_id: org, p_campaign_id: campaignId, p_contact_id: contactId,
    p_step_index: stepIndex, p_status: status, p_message_id: messageId, p_failure_reason: reason,
  });
  if (finalizeError) throw new Error("campaign_finalize_failed");
  return result("retry", { retry_at: new Date(Date.now() + 5000).toISOString() });
}

export const campaignHandler: EventHandler = {
  key, events: ["whatsapp_campaign.requested"],
  handle: (row) => processCampaign(createAdminClient(), row),
};
