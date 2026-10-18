import { describe, expect, it, vi } from 'vitest';
import { runModelCall } from '@/lib/agent-engine/edge/llm/run-model-call';

const ORG = 'b0000000-0000-4000-8000-000000000001';

function runtime(binding: boolean) {
  const requestedProviders: unknown[] = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes("settings->'llm'")) return { rows: [{ llm: { provider: 'anthropic', default_model: 'modelo-padrao' } }] };
    if (sql.includes('from ai_purpose_bindings')) return { rows: binding ? [{ provider: 'openai', credential_id: null, model_id: 'modelo-configurado', base_url: null, is_enabled: true }] : [] };
    if (sql.includes('from ai_provider_credentials')) { requestedProviders.push(params[1]); return { rows: [] }; }
    if (sql.includes('insert into llm_calls')) return { rows: [{ id: 'call' }] };
    return { rows: [] };
  });
  const factory = vi.fn((_key: string, modelId: string) => ({
    specificationVersion: 'v3', provider: 'openai', modelId,
    doGenerate: async () => ({ content: [{ type: 'text', text: 'ok' }], finishReason: { unified: 'stop', raw: undefined },
      usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } }, warnings: [] }),
  }));
  return { pool: { query } as never, requestedProviders, factory, registry: { openai: factory } as never };
}

describe('a chave do padrão não é pré-requisito para a escolha do painel/agente', () => {
  it('binding OpenAI funciona sem chave Anthropic, inclusive em classificador', async () => {
    const r = runtime(true);
    await runModelCall(r.pool, { openaiApiKey: 'fake-openai' }, { tenantId: ORG, purpose: 'intent_router', messages: [{ role: 'user', content: 'oi' }] }, { registry: r.registry });
    expect(r.requestedProviders).toEqual(['openai']);
    expect(r.factory).toHaveBeenCalledWith('fake-openai', 'modelo-configurado', undefined);
  });

  it('herança do agente funciona sem chave do padrão', async () => {
    const r = runtime(false);
    await runModelCall(r.pool, { openaiApiKey: 'fake-openai' }, {
      tenantId: ORG, purpose: 'flush', model: 'modelo-do-agente', llmOverride: { provider: 'openai', credentialId: null }, messages: [{ role: 'user', content: 'memória' }],
    }, { registry: r.registry });
    expect(r.requestedProviders).toEqual(['openai']);
    expect(r.factory).toHaveBeenCalledWith('fake-openai', 'modelo-do-agente', undefined);
  });

  it('sem escolha válida continua falhando, sem enviar ao provider errado', async () => {
    const r = runtime(false);
    await expect(runModelCall(r.pool, { openaiApiKey: 'fake-openai' }, { tenantId: ORG, purpose: 'flush', messages: [] }, { registry: r.registry })).rejects.toMatchObject({ name: 'llm_not_configured' });
    expect(r.factory).not.toHaveBeenCalled();
  });
});
