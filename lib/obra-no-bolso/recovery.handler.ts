import type { EventHandler } from "@/lib/event-log/dispatcher";
import { createAdminClient } from "@/lib/supabase/admin";
import { prepareObraOutreach } from "./outreach";

/** Libera apenas o segmento do fluxo existente; não cria um segundo remetente. */
export const obraRecoveryHandler: EventHandler = {
  key: "obra-subscription-recovery", events: ["obra_subscription.recovery"],
  async handle(row) {
    const admin = createAdminClient();
    try {
      const prepared = await prepareObraOutreach(admin, row);
      if (!prepared.ready) return { consumer_key: this.key, ...prepared.result };
      const { data, error } = await admin.rpc("fn_arm_obra_recovery", {
        p_org: row.organization_id, p_event: row.id, p_contact: prepared.contactId,
      });
      if (error) throw new Error("obra_recovery_unavailable");
      return { consumer_key: this.key, status: data === true ? "ok" : "skipped" };
    } catch {
      // Indisponibilidade não é cancelamento, nem permissão de usar estado antigo.
      return { consumer_key: this.key, status: "retry", retry_at: new Date(Date.now() + 60_000).toISOString() };
    }
  },
};
