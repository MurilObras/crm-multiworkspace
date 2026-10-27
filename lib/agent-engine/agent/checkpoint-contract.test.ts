// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createOpenAI } from '@ai-sdk/openai';
import { z } from 'zod';
import { checkpointCall } from './checkpoint-call';
import { checkpointContentSchema, checkpointTransportSchema, parseCheckpoint } from './checkpoint-contract';
import { CheckpointSchemaError } from '../edge/llm/checkpoint-error';
import { assertStrictOutputSchema } from '../../../tests/helpers/strict-output-schema';

const base = { commitments: [], objections: [], next_action: null, rolling_summary: 'Conversa fictícia.' };
const empty = { intencoes: [], promessas: [], nada_a_declarar: true };

describe('contratos da memória', () => {
  it('o contrato legado falha na política estrita; o transporte fecha todos os objetos', () => {
    expect(() => assertStrictOutputSchema(z.toJSONSchema(checkpointContentSchema))).toThrow();
    expect(() => assertStrictOutputSchema(z.toJSONSchema(checkpointTransportSchema))).not.toThrow();
  });
  it('o validador também rejeita uma propriedade opcional no item da lista', () => {
    expect(() => assertStrictOutputSchema({ type: 'object', properties: { promessas: { type: 'array', items: {
      type: 'object', properties: { prazo: { type: ['string', 'null'] } }, required: [], additionalProperties: false,
    } } }, required: ['promessas'], additionalProperties: false })).toThrow('propriedades opcionais');
  });
  it('ausência, null e avaliação vazia não se confundem; promessas mantêm prazo', () => {
    for (const declaracao of [undefined, null]) expect(parseCheckpoint({ ...base, declaracao }).declaracao).toBeUndefined();
    expect(parseCheckpoint({ ...base, declaracao: empty }).declaracao).toEqual(empty);
    for (const prazo of [null, '2026-10-30T12:00:00Z']) {
      expect(parseCheckpoint({ ...base, declaracao: { ...empty, nada_a_declarar: false,
        promessas: [{ o_que: 'Confirmar a condição', prazo }] } }).declaracao?.promessas[0]?.prazo).toBe(prazo);
    }
    expect(parseCheckpoint({ rolling_summary: 'Memória antiga' })).toEqual({ ...base, rolling_summary: 'Memória antiga' });
    expect(parseCheckpoint({ ...base, declaracao: { promessas: [{ o_que: 'Retornar' }] } }).declaracao)
      .toEqual({ intencoes: [], promessas: [{ o_que: 'Retornar', prazo: null }], nada_a_declarar: false });
  });
});

function database() {
  const inserts: unknown[][] = [];
  return { inserts, pool: { query: async (sql: string, params: unknown[] = []) => {
    if (sql.includes("settings->'llm'")) return { rows: [{ llm: { provider: 'openai', default_model: 'configured', params: {}, enabled_models: [] } }] };
    if (sql.includes('insert into llm_calls')) { inserts.push(params); return { rows: [{ id: 'call' }] }; }
    return { rows: [] };
  } } as never };
}

it.each([null, empty, { ...empty, nada_a_declarar: false, promessas: [{ o_que: 'Retornar', prazo: null }] },
  { ...empty, nada_a_declarar: false, promessas: [{ o_que: 'Retornar', prazo: '2030-01-02T12:00:00Z' }] }])(
  'valida o JSON de transporte efetivamente produzido pelo SDK e normaliza %j', async declaracao => {
    let captured: Record<string, unknown> | undefined;
    const provider = createOpenAI({ apiKey: 'test-not-a-secret', fetch: async (_url, init) => {
      captured = JSON.parse(String(init?.body));
      const format = (captured!.text as { format: { schema: unknown; strict: boolean } }).format;
      expect(format.strict).toBe(true); assertStrictOutputSchema(format.schema);
      return Response.json({ id: 'resp_test', object: 'response', created_at: 1, model: 'configured', status: 'completed',
        output: [{ id: 'msg_test', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', annotations: [], text: JSON.stringify({ ...base, declaracao }) }] }],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } });
    } });
    const { pool } = database();
    const call = await checkpointCall(pool, { openaiApiKey: 'test-not-a-secret' }, { tenantId: 'org', messages: [{ role: 'user', content: 'Exemplo fictício' }] },
      { registry: { openai: (_key, model) => provider(model) } });
    expect(captured).toBeDefined(); expect(JSON.parse(call.result.text)).toEqual(parseCheckpoint({ ...base, declaracao }));
  });

it('um HTTP 400 real do SDK é registrado como falha técnica e não é repetido', async () => {
  let calls = 0;
  const provider = createOpenAI({ apiKey: 'test-not-a-secret', fetch: async () => {
    calls++; return Response.json({ error: { message: "Invalid schema for response_format 'response': Missing 'prazo'.", type: 'invalid_request_error', code: 'invalid_json_schema' } }, { status: 400 });
  } });
  const { pool, inserts } = database();
  await expect(checkpointCall(pool, { openaiApiKey: 'test-not-a-secret' }, { tenantId: 'org', messages: [{ role: 'user', content: 'Exemplo fictício' }] },
    { registry: { openai: (_key, model) => provider(model) } })).rejects.toBeInstanceOf(CheckpointSchemaError);
  expect(calls).toBe(1); expect(inserts).toHaveLength(1);
  expect(inserts[0]).toContain('checkpoint_schema_invalid');
});
