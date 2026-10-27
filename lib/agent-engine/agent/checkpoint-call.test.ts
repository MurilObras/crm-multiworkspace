import { beforeEach, describe, it, expect, vi } from 'vitest';
const mock = vi.hoisted(() => vi.fn());
vi.mock('../edge/llm/run-model-call', () => ({ runModelCall: mock }));
import { checkpointCall } from './checkpoint-call';
import { checkpointOutputSchema } from './checkpoint-contract';
import { CheckpointSchemaError } from '../edge/llm/checkpoint-error';
const input = { tenantId: 'org', jobId: 'job', system: 'TOM COMERCIAL', messages: [], tools: { mutante: {} }, model: 'configured' };
const args = [{} as never, {} as never, input as never, {}] as const;
beforeEach(() => { mock.mockReset(); });
describe('fechamento isolado', () => {
  it('preserva modelo, normaliza contrato legado e nunca recebe ferramentas comerciais', async () => {
    mock.mockResolvedValue({ result: { text: '', output: { rolling_summary: 'confirmado', declaracao: null } } });
    const call = await checkpointCall(...args);
    expect(JSON.parse(call.result.text)).toEqual({ commitments: [], objections: [], next_action: null, rolling_summary: 'confirmado' });
    expect(mock.mock.calls[0]![2]).toMatchObject({ purpose: 'checkpoint', model: 'configured', maxSteps: 1, outputSchema: checkpointOutputSchema });
    expect(mock.mock.calls[0]![2].tools).toBeUndefined();
    expect(mock.mock.calls[0]![2].system).not.toContain('TOM COMERCIAL');
  });
  it('corrige conteúdo inválido uma única vez sem inventar resumo', async () => {
    mock.mockResolvedValue({ result: { text: 'invalido' } });
    await expect(checkpointCall(...args)).rejects.toBeDefined(); expect(mock).toHaveBeenCalledTimes(2);
  });
  it.each([429, 503])('preserva falhas transitórias %s para retomada pela fila', async statusCode => {
    const e = Object.assign(new Error('indisponível'), { statusCode });
    mock.mockRejectedValue(e); await expect(checkpointCall(...args)).rejects.toBe(e);
    expect(mock).toHaveBeenCalledTimes(1);
  });
  it('rejeição determinística vira falha técnica sem retry ou texto livre', async () => {
    mock.mockRejectedValue(Object.assign(new Error("Invalid schema for response_format 'response': Missing 'prazo'."), { statusCode: 400 }));
    await expect(checkpointCall(...args)).rejects.toBeInstanceOf(CheckpointSchemaError);
    expect(mock).toHaveBeenCalledTimes(1);
  });
  it('não remove o contrato se o provedor não suportar saída estruturada', async () => {
    const e = new Error('não suportado'); e.name = 'AI_UnsupportedFunctionalityError'; mock.mockRejectedValue(e);
    await expect(checkpointCall(...args)).rejects.toBe(e); expect(mock).toHaveBeenCalledTimes(1);
    expect(mock.mock.calls[0]![2].outputSchema).toBeDefined();
  });
});
