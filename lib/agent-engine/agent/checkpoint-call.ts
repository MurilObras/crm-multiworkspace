import type pg from 'pg';
import type { z } from 'zod';
import { runModelCall, type LlmEdgeConfig, type RunModelCallDeps, type RunModelCallInput } from '../edge/llm/run-model-call';

/** Só memória: nunca recebe ferramentas nem instruções comerciais. */
export async function checkpointCall(db: pg.Pool, cfg: LlmEdgeConfig,
  input: RunModelCallInput, schema: z.ZodType, deps: RunModelCallDeps) {
  let failure: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const call = await runModelCall(db, cfg, { ...input, purpose: 'checkpoint', tools: undefined,
        maxSteps: 1, system: 'Registre somente memória factual confirmada. Obedeça ao esquema JSON solicitado. Nunca responda ao cliente.',
        outputSchema: schema }, deps);
      const text=call.result.text;
      const start=text.indexOf('{'),end=text.lastIndexOf('}');
      const output = schema.parse(call.result.output ?? JSON.parse(text.slice(start,end+1)));
      return { ...call, result: { ...call.result, text: JSON.stringify(output) } };
    } catch (error) {
      failure = error;
      // Recusa/budget/configuração não são falhas de formatação e não gastam outra chamada.
      const name = error instanceof Error ? error.name : '';
      if (!['AI_NoObjectGeneratedError','AI_NoOutputGeneratedError','ZodError','AI_UnsupportedFunctionalityError','SyntaxError'].includes(name)) throw error;
      deps.log?.warn('checkpoint: formato recusado; recuperação limitada sem ferramentas', { category: name, attempt: attempt + 1 });
      if (name === 'AI_UnsupportedFunctionalityError') {
        const fallback = await runModelCall(db, cfg, { ...input, purpose: 'checkpoint', tools: undefined,
          maxSteps: 1, system: 'Retorne somente JSON válido para a memória interna. Sem ferramentas ou resposta ao cliente.', outputSchema: undefined }, deps);
        const start = fallback.result.text.indexOf('{'), end = fallback.result.text.lastIndexOf('}');
        const output = schema.parse(JSON.parse(fallback.result.text.slice(start, end + 1)));
        return { ...fallback, result: { ...fallback.result, text: JSON.stringify(output) } };
      }
    }
  }
  throw new Error('checkpoint inválido — não repetir atendimento', { cause: failure });
}
