import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { expect, test, type Page } from '@playwright/test';

/** Interface e backend reais, com canal local parado: nenhum WhatsApp externo. */
const evidence = '.superpowers/evidence/inbox-case-resolution';
const session = randomUUID();
const agent = randomUUID();
const contacts = [randomUUID(), randomUUID()];
const conversations = [randomUUID(), randomUUID()];
const cases = [randomUUID(), randomUUID()];
const uploadedPaths: string[] = [];
let admin: SupabaseClient;
let creds: { org_id: string; password: string; users: Record<string, { id: string; email: string }> };

async function insert(table: string, value: Record<string, unknown> | Record<string, unknown>[]) {
  const result = await admin.from(table).insert(value);
  if (result.error) throw new Error(`Fixture ${table}: ${result.error.code}`);
}
async function login(page: Page) {
  await page.goto('/login'); await page.locator('#email').fill(creds.users.agent!.email);
  await page.locator('#password').fill(creds.password);
  await page.getByRole('button', { name: /entrar/i }).click();
  await page.waitForURL(/\/app(\/|$)/, { timeout: 60_000 });
}

test.describe('Inbox — responder e resolver explicitamente', () => {
  test.describe.configure({ mode: 'serial', timeout: 180_000 });
  test.beforeAll(async () => {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname)) {
      throw new Error('Exige Supabase LOCAL explícito; sem fallback para ambiente de produção.');
    }
    creds = JSON.parse(fs.readFileSync(path.join(process.cwd(), '.e2e-creds.json'), 'utf8')) as typeof creds;
    admin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
    fs.mkdirSync(evidence, { recursive: true });
    await insert('ai_agents', { id: agent, organization_id: creds.org_id, name: 'Consultor de teste', kind: 'mcp_agent', system_prompt: 'Base sintética.' });
    await insert('channel_sessions', { id: session, organization_id: creds.org_id,
      waha_session_name: `e2e-case-${session}`, status: 'STOPPED', webhook_secret_encrypted: 'synthetic' });
    for (let index = 0; index < conversations.length; index++) {
      const now = new Date().toISOString();
      await insert('contacts', { id: contacts[index], organization_id: creds.org_id, display_name: `Consulta sintética ${index} ${agent.slice(0, 5)}`,
        phone_number: `+5511${parseInt(contacts[index]!.slice(0, 8), 16).toString().padStart(10, '0')}` });
      await insert('conversations', { id: conversations[index], organization_id: creds.org_id,
        contact_id: contacts[index], channel_session_id: session, active_ai_agent_id: agent, status: 'claimed',
        assigned_to_user_id: creds.users.agent!.id, assigned_at: now, bot_silenced_until: 'infinity', last_message_at: now,
        last_inbound_at: now, last_message_preview: 'Dúvida comercial sintética.' });
    }
    await insert('agent_cases', cases.map((id, index) => ({ id, organization_id: creds.org_id, conversation_id: conversations[0],
      agent_id: agent, title: index === 0 ? 'Condição comercial' : 'Horário especial', summary: 'Consulta sintética.',
      blocker: 'Aguardando confirmação humana.', status: 'awaiting_human' })));
  });
  test.afterAll(async () => {
    if (!admin || !creds) return;
    if (uploadedPaths.length) {
      const removed = await admin.storage.from('whatsapp-media').remove(uploadedPaths);
      if (removed.error) throw new Error('Limpeza do áudio sintético falhou.');
    }
    for (const [table, ids] of [['conversations', conversations], ['contacts', contacts], ['channel_sessions', [session]], ['ai_agents', [agent]]] as const) {
      const result = await admin.from(table).delete().eq('organization_id', creds.org_id).in('id', [...ids]);
      if (result.error) throw new Error(`Limpeza ${table}: ${result.error.code}`);
    }
  });

  test('seleção explícita, nota interna e envio em fila não liberam prematuramente o automático', async ({ page }) => {
    await login(page); await page.goto(`/app/inbox?id=${conversations[0]}`);
    const checkbox = page.getByRole('checkbox', { name: /Esta resposta resolve a consulta e libera o Consultor de teste/ });
    await expect(checkbox).toBeVisible({ timeout: 60_000 }); await expect(checkbox).not.toBeChecked();
    await checkbox.check();
    await page.getByRole('textbox', { name: 'Mensagem', exact: true }).fill('A condição foi confirmada.');
    await expect(page.getByRole('button', { name: 'Enviar', exact: true })).toBeDisabled();
    await page.getByLabel('Consulta resolvida por esta resposta').selectOption(cases[1]!);
    await page.getByRole('button', { name: 'Nota interna', exact: true }).click();
    await expect(checkbox).toHaveCount(0);
    await page.getByRole('button', { name: 'Responder', exact: true }).click();
    await expect(checkbox).not.toBeChecked();
    await checkbox.check(); await page.getByLabel('Consulta resolvida por esta resposta').selectOption(cases[1]!);
    const responsePromise = page.waitForResponse(response => response.url().endsWith('/api/v1/messages') && response.request().method() === 'POST');
    await page.getByRole('textbox', { name: 'Mensagem', exact: true }).press('Enter');
    const response = await responsePromise;
    expect(response.ok()).toBe(true);
    const body = await response.json();
    expect(body.data.status).toBe('queued');
    expect(response.request().postDataJSON()).toMatchObject({ conversation_id: conversations[0], resolve_case_id: cases[1], type: 'text' });
    await expect(checkbox).not.toBeChecked();
    await expect(page.getByRole('status').filter({ hasText: /Aguardando confirmação do envio/ })).toBeVisible();
    const rows = await admin.from('agent_cases').select('id,status').eq('organization_id', creds.org_id).in('id', cases);
    expect(rows.error).toBeNull(); expect(rows.data?.map(row => row.status)).toEqual(['awaiting_human', 'awaiting_human']);
    const conversation = await admin.from('conversations').select('assigned_to_user_id,bot_silenced_until').eq('organization_id', creds.org_id).eq('id', conversations[0]!).single();
    expect(conversation.error).toBeNull(); expect(conversation.data?.assigned_to_user_id).toBe(creds.users.agent!.id);
    await page.screenshot({ path: `${evidence}/queued-case-remains-open.png`, fullPage: true });
    await page.reload(); await expect(checkbox).not.toBeChecked();
    await expect(page.getByRole('status').filter({ hasText: /Aguardando confirmação do envio/ })).toBeVisible();
  });

  test('áudio anexado preserva a consulta escolhida sem resolver antes da entrega', async ({ page }) => {
    await login(page); await page.goto(`/app/inbox?id=${conversations[0]}`);
    const checkbox = page.getByRole('checkbox', { name: /Esta resposta resolve a consulta/ });
    await expect(checkbox).toBeVisible({ timeout: 60_000 }); await checkbox.check();
    await page.getByLabel('Consulta resolvida por esta resposta').selectOption(cases[0]!);
    // WAV PCM silencioso válido: percorre o upload real sem gravar voz ou usar rede externa.
    const wav = Buffer.alloc(8044);
    wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(8000, 40);
    await page.getByLabel('Escolher áudio pré-gravado', { exact: true }).setInputFiles({ name: 'resposta-sintetica.wav', mimeType: 'audio/wav', buffer: wav });
    const dialog = page.getByRole('dialog', { name: 'Enviar anexo' }); await expect(dialog).toBeVisible();
    const uploadPromise = page.waitForResponse(response => response.url().endsWith(`/conversations/${conversations[0]}/media`) && response.request().method() === 'POST');
    const messagePromise = page.waitForResponse(response => response.url().endsWith('/api/v1/messages') && response.request().method() === 'POST');
    await dialog.getByRole('button', { name: 'Enviar', exact: true }).click();
    const uploadResponse = await uploadPromise; expect(uploadResponse.ok()).toBe(true);
    const uploaded = (await uploadResponse.json()).data; uploadedPaths.push(uploaded.storage_path);
    const response = await messagePromise; expect(response.ok()).toBe(true);
    const body = await response.json(); expect(body.data.status).toBe('queued');
    expect(response.request().postDataJSON()).toMatchObject({ type: 'audio', resolve_case_id: cases[0], media_storage_path: uploaded.storage_path });
    await expect(dialog).toHaveCount(0); await expect(checkbox).not.toBeChecked();
    const state = await admin.from('case_resolution_intents').select('status,case_id').eq('organization_id', creds.org_id).eq('message_id', body.data.id).single();
    expect(state.error).toBeNull(); expect(state.data).toMatchObject({ status: 'pending', case_id: cases[0] });
    const pending = await admin.from('agent_cases').select('status').eq('organization_id', creds.org_id).eq('id', cases[0]!).single();
    expect(pending.error).toBeNull(); expect(pending.data?.status).toBe('awaiting_human');
  });

  test('controle cabe no celular e a escolha não vaza ao trocar conversa', async ({ page }) => {
    await login(page); await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/app/inbox?id=${conversations[0]}`);
    const checkbox = page.getByRole('checkbox', { name: /Esta resposta resolve a consulta/ });
    await expect(checkbox).toBeVisible({ timeout: 60_000 }); await checkbox.check();
    const select = page.getByLabel('Consulta resolvida por esta resposta'); await select.selectOption(cases[0]!);
    const geometry = await select.evaluate(element => { const rect = element.getBoundingClientRect();
      return { inside: rect.left >= 0 && rect.right <= innerWidth + 1, height: rect.height }; });
    expect(geometry.inside).toBe(true); expect(geometry.height).toBeGreaterThanOrEqual(30);
    await page.screenshot({ path: `${evidence}/mobile-case-selection.png`, fullPage: true });
    await page.goto(`/app/inbox?id=${conversations[1]}`); await expect(checkbox).toHaveCount(0);
    await page.goto(`/app/inbox?id=${conversations[0]}`); await expect(checkbox).not.toBeChecked();
  });
});
