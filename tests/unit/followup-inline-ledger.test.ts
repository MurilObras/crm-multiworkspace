import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { enviarTextoFixoPendente } from '@/lib/followup/enviar-texto-fixo';
import { sendInlineTurnMessage } from '@/lib/agent-engine/edge/crm/inline-send';

const { sink, complete } = vi.hoisted(() => ({ sink: vi.fn(), complete: vi.fn() }));
vi.mock('@/app/api/v1/messages/_handler', () => ({ sendMessageHandler: sink }));
vi.mock('@/lib/followup/turn-bridge', () => ({ completeTurnForEnrollment: complete }));
vi.mock('@/lib/ai/elegibilidade/consulta-supabase', () => ({ decidirElegibilidadeDaConversaViaSupabase: async () => ({ permite: true }) }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

type Row = Record<string, unknown>;
let tables: Record<string, Row[]>;
let transportStatus: string;
let failAfterTransport: boolean;
let failLedgerSave: boolean;
let failDone: boolean;
let failSentSave: boolean;
function db(): SupabaseClient {
  return { from(table: string) {
    const predicates: Array<(r: Row) => boolean> = [];
    let mode = 'read'; let patch: Row = {};
    const value = (r: Row, k: string) => k === 'metadata->>idempotency_key'
      ? (r.metadata as Row)?.idempotency_key : r[k];
    const execute = () => {
      const rows = tables[table];
      if (!rows) throw new Error(`unexpected_table:${table}`);
      if (mode === 'insert') {
        if (table === 'send_ledger' && rows.some((r) => r.job_id === patch.job_id && r.seq === patch.seq)) {
          return { data: null, error: { code: '23505', message: 'duplicate' } };
        }
        const row = { id: `${table}-${rows.length}`, status: 'requested', crm_message_id: null, ...patch };
        rows.push(row); return { data: [{ ...row }], error: null };
      }
      const found = rows.filter((r) => predicates.every((p) => p(r)));
      if (mode === 'update') {
        if (table === 'messages' && patch.status === 'sent' && failSentSave) {
          failSentSave = false; return { data: null, error: { message: 'sent write failed' } };
        }
        if (table === 'send_ledger' && patch.status === 'accepted' && failLedgerSave) {
          failLedgerSave = false; return { data: null, error: { message: 'ledger write failed' } };
        }
        if (table === 'job_queue' && patch.status === 'done' && failDone) {
          failDone = false; return { data: null, error: { message: 'job write failed' } };
        }
        found.forEach((r) => Object.assign(r, patch));
      }
      return { data: found.map((r) => ({ ...r })), error: null };
    };
    const q = {
      select: () => q, order: () => q, limit: () => q,
      eq(k: string, v: unknown) { predicates.push((r) => value(r, k) === v); return q; },
      is(k: string, v: unknown) { predicates.push((r) => value(r, k) === v); return q; },
      insert(p: Row) { mode = 'insert'; patch = p; return q; },
      update(p: Row) { mode = 'update'; patch = p; return q; },
      async maybeSingle() { const r = execute(); return { ...r, data: r.data?.[0] ?? null }; },
      async single() { return q.maybeSingle(); },
      async then(resolve: (v: ReturnType<typeof execute>) => unknown) { return resolve(execute()); },
    };
    return q;
  } } as unknown as SupabaseClient;
}

beforeEach(() => {
  vi.clearAllMocks(); transportStatus = 'sent'; failAfterTransport = false; failLedgerSave = false; failDone = false; failSentSave = false;
  tables = {
    job_queue: [{ id: 'job', organization_id: 'org', contact_id: 'contact', kind: 'followup_turn', status: 'pending',
      payload: { followup_enrollment_id: 'enrollment', node_id: 'node', fixed_body: 'Oi' } }],
    followup_enrollments: [{ id: 'enrollment', organization_id: 'org', contact_id: 'contact', current_node_id: 'node', conversation_id: 'conv' }],
    conversations: [{ id: 'conv', organization_id: 'org', contact_id: 'contact', channel_session_id: 'session',
      is_group: false, status: 'open', last_inbound_at: null, channel_sessions: { provider: 'waha' } }],
    channel_sessions: [{ id: 'session', organization_id: 'org', provider: 'waha', status: 'WORKING', archived_at: null }],
    messages: [], send_ledger: [],
  };
  sink.mockImplementation(async (admin: SupabaseClient, ctx, input, options) => {
    const { data: message } = await admin.from('messages').insert({ organization_id: ctx.organization_id, contact_id: 'contact',
      conversation_id: input.conversation_id, direction: 'outbound', status: 'queued', metadata: input.metadata, error_code: null,
    }).select('*').single();
    await options.beforeSend(message);
    if (transportStatus !== 'queued') await options.beforeTransport(message);
    await admin.from('messages').update({ status: transportStatus }).eq('id', message.id);
    if (failAfterTransport) { failAfterTransport = false; throw new Error('after transport accepted'); }
    return { ...message, status: transportStatus };
  });
});

describe('inline reutiliza send_ledger e a mensagem sob custódia do CRM', () => {
  it('falha ao gravar sent após aceite não deixa queued para o watchdog reenviar', async () => {
    const admin = db(); failSentSave = true;
    expect(await enviarTextoFixoPendente(admin)).toBe(0);
    expect(tables.messages![0]!.status).toBe('sending');
    expect(await enviarTextoFixoPendente(admin)).toBe(0);
    expect(tables.messages).toHaveLength(1); expect(sink).toHaveBeenCalledOnce();
    expect(complete).not.toHaveBeenCalled();
  });
  it('queued + retry gera uma única mensagem; confirmação posterior completa o passo', async () => {
    const admin = db(); transportStatus = 'queued';
    expect(await enviarTextoFixoPendente(admin)).toBe(0);
    expect(await enviarTextoFixoPendente(admin)).toBe(0);
    expect(complete).not.toHaveBeenCalled();
    expect(sink).toHaveBeenCalledOnce(); expect(tables.messages).toHaveLength(1); expect(tables.send_ledger).toHaveLength(1);
    tables.messages![0]!.status = 'delivered';
    expect(await enviarTextoFixoPendente(admin)).toBe(1);
    expect(sink).toHaveBeenCalledOnce(); expect(complete).toHaveBeenCalledOnce();
    expect(tables.job_queue![0]!.status).toBe('done');
  });
  it.each(['transport', 'ledger', 'done'] as const)('falha posterior em %s + retry não repete transporte', async (where) => {
    failAfterTransport = where === 'transport'; failLedgerSave = where === 'ledger'; failDone = where === 'done';
    const admin = db();
    await enviarTextoFixoPendente(admin);
    expect(tables.job_queue![0]!.status).toBe('pending');
    await enviarTextoFixoPendente(admin);
    expect(sink).toHaveBeenCalledOnce(); expect(tables.messages).toHaveLength(1);
    expect(tables.job_queue![0]!.status).toBe('done'); expect(tables.send_ledger![0]!.status).toBe('accepted');
  });
  it('duas reservas concorrentes do mesmo job não enviam duas vezes', async () => {
    const admin = db(); const ctx = { organization_id: 'org', actor: { type: 'webhook_source' as const, id: 'enrollment' }, requestId: 'req' };
    const prepare = async () => ({ conversation_id: 'conv', type: 'text' as const, body: 'Oi' });
    await Promise.all([sendInlineTurnMessage(admin, ctx, 'job', 'contact', prepare), sendInlineTurnMessage(admin, ctx, 'job', 'contact', prepare)]);
    expect(sink).toHaveBeenCalledOnce(); expect(tables.messages).toHaveLength(1);
  });
  it('enrollment explícito não vira ambíguo quando o contato tem outra conversa', async () => {
    tables.conversations!.push({ ...tables.conversations![0], id: 'other-conv', channel_session_id: 'other-session' });
    expect(await enviarTextoFixoPendente(db())).toBe(1);
    expect(sink.mock.calls[0]?.[2].conversation_id).toBe('conv');
  });
  it.each([{ organization_id: 'other-org' }, { contact_id: 'other-contact' }])('vínculo explícito fora do escopo %j não envia', async (over) => {
    Object.assign(tables.conversations![0]!, over);
    expect(await enviarTextoFixoPendente(db())).toBe(0); expect(sink).not.toHaveBeenCalled();
  });
  it('sem conversation_id mantém a resolução automática atual', async () => {
    tables.followup_enrollments![0]!.conversation_id = null;
    expect(await enviarTextoFixoPendente(db())).toBe(1); expect(sink).toHaveBeenCalledOnce();
  });
  it('tentativa existente sem mensagem não autoriza outro transporte', async () => {
    tables.send_ledger!.push({ id: 'ledger', organization_id: 'org', contact_id: 'contact', job_id: 'job', seq: 1, status: 'requested', crm_message_id: null });
    expect(await enviarTextoFixoPendente(db())).toBe(0); expect(sink).not.toHaveBeenCalled();
    expect(tables.send_ledger).toHaveLength(1);
  });
  it('chave de outro tenant não pode ser adotada após conflito', async () => {
    tables.send_ledger!.push({ id: 'ledger', organization_id: 'foreign', contact_id: 'contact', job_id: 'job', seq: 1, status: 'accepted', crm_message_id: 'foreign-message' });
    expect(await enviarTextoFixoPendente(db())).toBe(0); expect(sink).not.toHaveBeenCalled();
  });
});
