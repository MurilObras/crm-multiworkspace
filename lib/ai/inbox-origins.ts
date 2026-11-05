import { createClient } from "@/lib/supabase/server";

type Ref = { id: string; ref_kind: string | null; ref_id: string | null };
export type InboxOrigin = { href: string; label: string; state: string | null };

/** Lotes limitados à página. Só a sessão pode enriquecer uma origem, nunca service_role. */
export async function inboxOrigins(org: string, items: Ref[]): Promise<Map<string, InboxOrigin>> {
  const db = await createClient();
  const result = new Map<string, InboxOrigin>();
  const refs = (kind: string[]) => [...new Set(items.filter(i => kind.includes(i.ref_kind ?? "") && i.ref_id).map(i => i.ref_id!))];
  const jobIds = refs(["job", "job_queue"]);
  const mediaIds = refs(["message"]);
  const enrollmentIds = refs(["followup_enrollment"]);
  const [jobs, media, enrollments] = await Promise.all([
    jobIds.length ? db.from("job_queue").select("id,status,payload,contact_id").eq("organization_id", org).in("id", jobIds) : { data: [] },
    mediaIds.length ? db.from("messages").select("id,conversation_id,media_derived_status").eq("organization_id", org).in("id", mediaIds) : { data: [] },
    enrollmentIds.length ? db.from("followup_enrollments").select("id,conversation_id,contact_id,status").eq("organization_id", org).in("id", enrollmentIds) : { data: [] },
  ]);
  const convRefs = new Map<string, { id: string | null; contact?: string | null; state: string | null }>();
  for (const item of items) {
    if (item.ref_kind === "conversation" && item.ref_id) convRefs.set(item.id, { id: item.ref_id, state: null });
    const job = jobs.data?.find(j => j.id === item.ref_id);
    if (job) {
      const payload = job.payload as Record<string, unknown> | null;
      convRefs.set(item.id, { id: typeof payload?.conversation_id === "string" ? payload.conversation_id : null, contact: job.contact_id, state: job.status });
    }
    const msg = media.data?.find(m => m.id === item.ref_id);
    if (msg) convRefs.set(item.id, { id: msg.conversation_id, state: msg.media_derived_status });
    const enrollment = enrollments.data?.find(e => e.id === item.ref_id);
    if (enrollment) convRefs.set(item.id, { id: enrollment.conversation_id, contact: enrollment.contact_id, state: enrollment.status });
  }
  const ids = [...new Set([...convRefs.values()].map(v => v.id).filter((v): v is string => !!v))];
  const contacts = [...new Set([...convRefs.values()].filter(v => !v.id && v.contact).map(v => v.contact!))];
  const [byId, byContact] = await Promise.all([
    ids.length ? db.from("conversations").select("id,contact_id,status").eq("organization_id", org).in("id", ids) : { data: [] },
    contacts.length ? db.from("conversations").select("id,contact_id,status").eq("organization_id", org).in("contact_id", contacts)
      .order("last_message_at", { ascending: false }).limit(200) : { data: [] },
  ]);
  for (const [itemId, ref] of convRefs) {
    const conv = ref.id ? byId.data?.find(c => c.id === ref.id) : byContact.data?.find(c => c.contact_id === ref.contact);
    if (conv) result.set(itemId, { href: `/app/inbox?id=${encodeURIComponent(conv.id)}`, label: "Abrir atendimento", state: ref.state ?? conv.status });
  }
  return result;
}
