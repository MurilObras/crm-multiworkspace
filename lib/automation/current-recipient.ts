import type { SupabaseClient } from "@supabase/supabase-js";
import { ApiError } from "@/lib/api/types";

export function automaticRecipientReason(data: {
  is_anonymized?: boolean; is_blocked?: boolean; phone_number?: string | null;
  consent?: { marketing?: { declined_at?: unknown } } | null;
}, requirePhone = false) {
  return data.is_anonymized ? "contact_anonymized" : data.is_blocked ? "contact_blocked"
    : data.consent?.marketing?.declined_at ? "consent_declined" : requirePhone && !data.phone_number ? "no_phone" : null;
}

/** Consulta atual, compartilhada por inscrição e transporte. Nunca usa o
 * consentimento fotografado no evento de compra como autorização para enviar. */
export async function currentAutomaticRecipient(db: SupabaseClient, org: string, id: string) {
  const { data, error } = await db.from("contacts")
    .select("id, phone_number, wa_identity, wa_lid, is_blocked, is_anonymized, consent")
    .eq("organization_id", org).eq("id", id).maybeSingle();
  if (error) throw new ApiError(503, "internal_error", undefined, "automation", "recipient_unavailable");
  const reason = !data ? "no_contact" : automaticRecipientReason(data);
  if (reason) throw new ApiError(403, "forbidden", undefined, "automation", reason);
  return data!;
}
