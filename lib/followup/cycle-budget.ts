import { withServiceRequestBudget } from '@/lib/supabase/service-fetch';

export const FOLLOWUP_CYCLE_BUDGET_MS = 45_000;
declare global {
  var __crmFollowupCycleBusy: boolean | undefined;
}

/** Um processo não acumula ticks por cron e pelo relógio da tela. Entre
 * processos, o claim de enrollment e a RPC de episódio continuam atômicos.
 * Sem Promise.race: o guard só abre depois de cessarem os efeitos da rodada. */
export async function withFollowupCycle<T>(run: () => Promise<T>): Promise<T | null> {
  if (globalThis.__crmFollowupCycleBusy) return null;
  globalThis.__crmFollowupCycleBusy = true;
  try { return await withServiceRequestBudget(FOLLOWUP_CYCLE_BUDGET_MS, run); }
  finally { globalThis.__crmFollowupCycleBusy = false; }
}
