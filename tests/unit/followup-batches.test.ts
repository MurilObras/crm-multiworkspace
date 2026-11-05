// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runSilenceSweep, type SilenceSweepDb } from '@/lib/followup/silence-sweep';
import type { FollowupGateDb } from '@/lib/followup/agent-followup-gate';
import { resetServiceRequestBudget, withServiceRequestBudget } from '@/lib/supabase/service-fetch';
import { withFollowupCycle } from '@/lib/followup/cycle-budget';
vi.mock('@/lib/followup/agent-followup-gate', () => ({ resolveAgentForAutomaticTrigger: async () => 'agent' }));
beforeEach(() => { globalThis.__crmSilenceProgress = undefined; globalThis.__crmFollowupCycleBusy = false; });

function fixture() {
  const contacts = Array.from({ length: 125 }, (_, i) => String(i + 1).padStart(4, '0'));
  const batch = vi.fn<NonNullable<SilenceSweepDb['insertEnrollments']>>(async inputs => inputs.map(i => ({ contact_id: i.contact_id, inserted: true })));
  const page = vi.fn<NonNullable<SilenceSweepDb['loadSilentContactPage']>>(async (_o, _c, _s, after) => contacts.filter(c => !after || c > after).slice(0, 50));
  const db: SilenceSweepDb = {
    loadActiveSilencePointers: async () => [{ id: 'pointer', organization_id: 'org', active_version_id: 'version', threshold_minutes: 120, segments: [] }],
    loadTriggerNodeId: async () => 'trigger', loadSilentContactIds: vi.fn(),
    insertEnrollment: vi.fn(), loadSilentContactPage: page, insertEnrollments: batch,
  };
  const run = () => runSilenceSweep({ db, gateDb: {} as FollowupGateDb, clock: () => new Date() });
  return { db, batch, page, run };
}

describe('varredura em lotes', () => {
  it('125 contatos usam três lotes limitados e nenhum RPC individual', async () => {
    const f = fixture();
    expect((await f.run()).enrolled).toBe(125);
    expect(f.batch.mock.calls.map(c => c[0].length)).toEqual([50, 50, 25]);
    expect(f.db.insertEnrollment).not.toHaveBeenCalled();
    expect(f.page.mock.calls.map(c => c[3])).toEqual([null, '0050', '0100']);
  });
  it('retoma depois do último lote confirmado quando acaba o orçamento', async () => {
    const f = fixture();
    f.batch.mockImplementationOnce(async inputs => {
      resetServiceRequestBudget(0); return inputs.map(i => ({ contact_id: i.contact_id, inserted: true }));
    });
    expect((await withServiceRequestBudget(1000, f.run)).enrolled).toBe(50);
    expect((await withServiceRequestBudget(1000, f.run)).enrolled).toBe(75);
    expect(f.page.mock.calls[1]![3]).toBe('0050');
  });
  it('resposta incompleta não confirma cursor nem contabiliza sucesso', async () => {
    const f = fixture(); f.batch.mockResolvedValueOnce([]);
    await expect(f.run()).rejects.toThrow('silence_batch_result_invalid');
    expect(globalThis.__crmSilenceProgress?.cursors.size).toBe(0);
  });
  it('mantém a ordem dos fluxos e limita o lote também no adaptador sem paginação', async () => {
    const f = fixture();
    f.db.loadSilentContactPage = undefined;
    f.db.loadSilentContactIds = async () => Array.from({ length: 125 }, (_, i) => String(i));
    const pointer = (await f.db.loadActiveSilencePointers())[0]!;
    f.db.loadActiveSilencePointers = async () => [{ ...pointer, id: 'z-first' }, { ...pointer, id: 'a-second' }];
    await f.run();
    expect(f.batch.mock.calls.map(c => c[0].length)).toEqual([50,50,25,50,50,25]);
    expect(f.batch.mock.calls.map(c => c[0][0]!.pointer_id)).toEqual(['z-first','z-first','z-first','a-second','a-second','a-second']);
  });
  it('cron e relógio não sobrepõem a rodada; o guard só libera após cessar o trabalho', async () => {
    let release!: () => void;
    const work = new Promise<void>(r => { release = r; });
    const first = withFollowupCycle(async () => { await work; return 'finished'; });
    expect(await withFollowupCycle(async () => 'overlap')).toBeNull();
    release(); expect(await first).toBe('finished');
    expect(await withFollowupCycle(async () => 'next')).toBe('next');
  });
});
