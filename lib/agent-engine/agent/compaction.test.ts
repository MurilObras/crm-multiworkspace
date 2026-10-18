import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LeadContext } from '../edge/crm/get-lead-context';

const mocks = vi.hoisted(() => ({ call: vi.fn(), note: vi.fn() }));
vi.mock('../edge/llm/run-model-call', () => ({ runModelCall: mocks.call }));
vi.mock('./lead-notes', () => ({ applySaveLeadNote: mocks.note }));

import { maybeCompact } from './compaction';

const context: LeadContext = {
  lead_id: 'contact', conversation_id: 'conversation', last_human_decision: null,
  contact: { name: null, phone: null, email: null, tags: [], is_blocked: false },
  messages: Array.from({ length: 40 }, () => ({ direction: 'inbound', body: 'fato', sent_at: '2026-10-17T12:00:00Z' })),
};

beforeEach(() => { mocks.call.mockReset(); mocks.note.mockReset(); });

describe('flush e compaction com a credencial do agente', () => {
  it('repassa a mesma identidade às duas chamadas e mantém a ordem das notas', async () => {
    const order: string[] = [];
    mocks.call.mockImplementation(async (_db, _cfg, args) => {
      order.push(args.purpose);
      return { result: { text: args.purpose === 'flush' ? '{"notes":[{"headline":"Preferência","body":"Treino à tarde"}]}' : '{"rolling_summary":"Resumo confirmado"}' } };
    });
    mocks.note.mockImplementation(async () => { order.push('note'); return { ok: true }; });
    const llmOverride = { provider: 'openai', credentialId: 'school-credential' };
    const result = await maybeCompact({} as never, {}, { tenantId: 'org', leadId: 'contact', jobId: 'job' }, {
      context, previousSummary: '', notesIndexMaxTokens: 1000,
      knobs: { triggerMessages: 40, transcriptMaxTokens: 400, model: 'modelo-escolhido', llmOverride },
    }, { log: { warn: vi.fn() } as never });
    expect(order).toEqual(['flush', 'note', 'compaction']);
    expect(result?.rolling_summary).toBe('Resumo confirmado');
    for (const [, , input] of mocks.call.mock.calls) {
      expect(input).toMatchObject({ tenantId: 'org', model: 'modelo-escolhido', llmOverride });
    }
  });

  it('não chama memória antes do limiar', async () => {
    await maybeCompact({} as never, {}, { tenantId: 'org', leadId: 'contact' }, {
      context: { ...context, messages: context.messages.slice(1) }, previousSummary: '', notesIndexMaxTokens: 1000,
      knobs: { triggerMessages: 40, transcriptMaxTokens: 400 },
    }, { log: { warn: vi.fn() } as never });
    expect(mocks.call).not.toHaveBeenCalled();
  });
});
