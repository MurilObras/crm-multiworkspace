// @vitest-environment node
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { outboundPostgres, ORG, CONTACT, CONV } from '../helpers/outbound-postgres';
import { getAdapter } from '@/lib/channels';
import { sendAutomationMessage, resumeQueuedAutomationMessage } from '@/lib/automation/send-message';
import { acquireActionIntent, finishActionIntent, actionStillWaiting } from '@/lib/automation/action-intent';
import { desfechoDoEnvio } from '@/lib/automation/desfecho-do-envio';
import type { ActionCtx } from '@/lib/automation/types';
import { SubscriptionLookupUnavailableError } from '@/lib/obra-no-bolso/subscription-errors';
import { OutboundPreflightDeferredError } from '@/lib/channels/delivery-error';

const holder = vi.hoisted(() => ({ pool: undefined as unknown, refresh: vi.fn() }));
vi.mock('@/lib/agent-engine/db/request-pool', () => ({ getRequestPool: () => holder.pool }));
vi.mock('@/lib/obra-no-bolso/outreach', () => ({ refreshObraOutreachForTransport: holder.refresh }));
vi.mock('@/lib/automation/janela-do-canal', () => ({ adiarAteAJanelaAbrir: async () => null }));
vi.mock('@/lib/automation/throttle', () => ({ checkDailyLimit: async () => ({ allowed: true }) }));
vi.mock('@/lib/audit', () => ({ audit: vi.fn(async () => {}) }));
vi.mock('@/lib/ai/elegibilidade/consulta-supabase', () => ({ decidirElegibilidadeDaConversaViaSupabase: async () => ({ permite: true }) }));

let db: Awaited<ReturnType<typeof outboundPostgres>>;
const EVENT = '10000000-0000-4000-8000-000000000011';
const RULE = '10000000-0000-4000-8000-000000000012';
beforeAll(async () => {
  db = await outboundPostgres(); holder.pool = db.pool;
  await db.pool.query(`alter table automation_rule_runs alter column id set default gen_random_uuid(),
    add column rule_id uuid, add column rule_identity uuid, add column event_id uuid,
    add column action_index integer, add column message_id uuid, add column status text,
    add column execution_state text, add column execution_updated_at timestamptz,
    add column actions_result jsonb`);
  await db.pool.query('create unique index intents on automation_rule_runs(organization_id,event_id,rule_identity,action_index) where action_index is not null');
  await db.pool.query('create table automation_event_plans(organization_id uuid,event_id uuid,rules jsonb)');
  await db.pool.query('create function fn_automation_run_live(uuid,uuid,uuid) returns boolean language sql as $$ select true $$');
  // Estas provas isolam o protocolo de retomada. Guardas comerciais/horário têm
  // provas próprias com as funções reais em obra-subscription.test.ts.
  await db.pool.query('create or replace function fn_obra_outreach_send_live(p_org uuid,p_event uuid,p_contact uuid,p_rule uuid) returns boolean language sql as $$ select true $$');
  await db.pool.query('create function fn_obra_access_send_live(uuid,uuid,uuid,uuid) returns boolean language sql as $$ select true $$');
}, 60_000);
beforeEach(async () => {
  vi.restoreAllMocks(); holder.refresh.mockReset(); await db.seed();
  await db.pool.query('truncate automation_rule_runs');
  await db.pool.query('insert into event_log(id,organization_id,entity_id) values($1,$2,$3)', [EVENT,ORG,CONTACT]);
  await db.pool.query('insert into automation_rules(id,organization_id,is_active) values($1,$2,true)', [RULE,ORG]);
});
afterAll(async () => { vi.restoreAllMocks(); await db?.close(); });

const context = (): ActionCtx => ({ admin: db.supabase, organizationId: ORG, ruleId: RULE, ruleName: 'Ativação',
  event: { id: EVENT, organization_id: ORG, event_type: 'obra_subscription.outreach', entity_id: CONTACT,
    entity_kind: 'contact', payload: {}, metadata: {}, consumed_by: [], attempts: 0 },
  context: { contact: { id: CONTACT, phone_number: '+5511000000000' } }, requestId: 'synthetic-test' });
const input = { conversation_id: CONV, type: 'text' as const, body: 'Parabéns!' };

it('aguarda duas falhas de consulta e retoma a mesma mensagem uma única vez', async () => {
  vi.spyOn(getAdapter('waha'), 'isConfigured').mockReturnValue(true);
  const transport = vi.spyOn(getAdapter('waha'), 'send').mockResolvedValue({ externalId: 'synthetic-confirmed' });
  holder.refresh.mockRejectedValueOnce(new SubscriptionLookupUnavailableError())
    .mockRejectedValueOnce(new SubscriptionLookupUnavailableError()).mockResolvedValue(undefined);
  const ctx = context();
  const id = await acquireActionIntent(db.pool, ctx, 0, 'send_whatsapp_message');
  expect(id).toBeTruthy();
  const message = await sendAutomationMessage({ ...ctx, actionIntentId: id! }, input);
  expect(holder.refresh).toHaveBeenCalledOnce();
  expect(transport).not.toHaveBeenCalled();
  expect(message).toMatchObject({ id, status: 'queued', metadata: {
    outbound_attempt: { phase: 'prepared' }, queued_reason: 'subscription_lookup_unavailable' } });
  await finishActionIntent(db.pool, ORG, id!, desfechoDoEnvio('send_whatsapp_message', message));
  const run = (await db.pool.query('select status,execution_state,message_id from automation_rule_runs where id=$1', [id])).rows[0];
  expect(run).toMatchObject({ status: 'adiado', execution_state: 'pending', message_id: id });
  expect(await actionStillWaiting(db.pool, ORG, EVENT, RULE, 0)).toBe(true);
  const waiting = await resumeQueuedAutomationMessage(ctx, 0, 'send_whatsapp_message');
  expect(waiting?.result.status).toBe('postponed');
  await finishActionIntent(db.pool, ORG, id!, waiting!.result);
  expect(transport).not.toHaveBeenCalled();
  const resumed = await resumeQueuedAutomationMessage(ctx, 0, 'send_whatsapp_message');
  expect(resumed).toMatchObject({ id, result: { status: 'success', detail: { message_id: id } } });
  await finishActionIntent(db.pool, ORG, id!, resumed!.result);
  expect(transport).toHaveBeenCalledOnce();
  expect(holder.refresh).toHaveBeenCalledTimes(3);
  expect((await db.pool.query('select id,status,external_id from messages')).rows)
    .toEqual([{ id, status: 'sent', external_id: 'synthetic-confirmed' }]);
  expect(await resumeQueuedAutomationMessage(ctx, 0, 'send_whatsapp_message')).toBeNull();
  expect(await acquireActionIntent(db.pool, ctx, 0, 'send_whatsapp_message')).toBeNull();
  expect(await actionStillWaiting(db.pool, ORG, EVENT, RULE, 0)).toBe(false);
  expect(transport).toHaveBeenCalledOnce();
});

it.each(['subscription_integration_unavailable', 'subscription_key_unavailable', 'subscription_snapshot_untrusted',
  'subscription_snapshot_invalid', 'subscription_lookup_invalid'])(
  '%s continua sendo impedimento definitivo, sem usar estado antigo', async (reason) => {
    vi.spyOn(getAdapter('waha'), 'isConfigured').mockReturnValue(true);
    const transport = vi.spyOn(getAdapter('waha'), 'send');
    holder.refresh.mockRejectedValueOnce(new Error(reason));
    const ctx = context();
    const id = await acquireActionIntent(db.pool, ctx, 0, 'send_whatsapp_message');
    const message = await sendAutomationMessage({ ...ctx, actionIntentId: id! }, input);
    expect(message).toMatchObject({ status: 'failed', metadata: { outbound_attempt: { phase: 'prepared' } } });
    await finishActionIntent(db.pool, ORG, id!, desfechoDoEnvio('send_whatsapp_message', message));
    expect(await actionStillWaiting(db.pool, ORG, EVENT, RULE, 0)).toBe(false);
    expect(await resumeQueuedAutomationMessage(ctx, 0, 'send_whatsapp_message')).toBeNull();
    expect(transport).not.toHaveBeenCalled();
  });

it.each(['force_human', 'is_blocked'])('retomada revalida %s e não envia após a consulta se recuperar', async (flag) => {
  vi.spyOn(getAdapter('waha'), 'isConfigured').mockReturnValue(true);
  const transport = vi.spyOn(getAdapter('waha'), 'send');
  holder.refresh.mockRejectedValueOnce(new SubscriptionLookupUnavailableError()).mockResolvedValue(undefined);
  const ctx = context();
  const id = await acquireActionIntent(db.pool, ctx, 0, 'send_whatsapp_message');
  const message = await sendAutomationMessage({ ...ctx, actionIntentId: id! }, input);
  await finishActionIntent(db.pool, ORG, id!, desfechoDoEnvio('send_whatsapp_message', message));
  await db.pool.query(`update contacts set ${flag}=true where organization_id=$1 and id=$2`, [ORG,CONTACT]);
  const resumed = await resumeQueuedAutomationMessage(ctx, 0, 'send_whatsapp_message');
  expect(resumed?.result.status).toBe('failed');
  await finishActionIntent(db.pool, ORG, id!, resumed!.result);
  expect(transport).not.toHaveBeenCalled();
  expect(await actionStillWaiting(db.pool, ORG, EVENT, RULE, 0)).toBe(false);
});

it('erro de espera vindo depois de STARTED mantém incerteza e nunca autoriza reenvio', async () => {
  vi.spyOn(getAdapter('waha'), 'isConfigured').mockReturnValue(true);
  holder.refresh.mockResolvedValue(undefined);
  const transport = vi.spyOn(getAdapter('waha'), 'send')
    .mockRejectedValueOnce(new OutboundPreflightDeferredError('subscription_lookup_unavailable'));
  const ctx = context();
  const id = await acquireActionIntent(db.pool, ctx, 0, 'send_whatsapp_message');
  const message = await sendAutomationMessage({ ...ctx, actionIntentId: id! }, input);
  expect(message).toMatchObject({ status: 'failed', metadata: { outbound_attempt: { phase: 'uncertain' } } });
  await finishActionIntent(db.pool, ORG, id!, desfechoDoEnvio('send_whatsapp_message', message));
  expect(await resumeQueuedAutomationMessage(ctx, 0, 'send_whatsapp_message')).toBeNull();
  expect(await acquireActionIntent(db.pool, ctx, 0, 'send_whatsapp_message')).toBeNull();
  expect(transport).toHaveBeenCalledOnce();
});

it('uma automação de outro domínio não passa a consultar o aplicativo', async () => {
  vi.spyOn(getAdapter('waha'), 'isConfigured').mockReturnValue(true);
  const transport = vi.spyOn(getAdapter('waha'), 'send').mockResolvedValue({ externalId: 'synthetic-other' });
  const ctx = context(); ctx.event.event_type = 'lead.created';
  const id = await acquireActionIntent(db.pool, ctx, 0, 'send_whatsapp_message');
  const message = await sendAutomationMessage({ ...ctx, actionIntentId: id! }, input);
  expect(message.status).toBe('sent');
  expect(holder.refresh).not.toHaveBeenCalled();
  expect(transport).toHaveBeenCalledOnce();
});
