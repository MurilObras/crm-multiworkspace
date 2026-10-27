import type pg from 'pg';
import { checkpointOutputSchema, parseCheckpoint } from './checkpoint-contract';
import { CheckpointSchemaError, isStructuredSchemaRejection } from '../edge/llm/checkpoint-error';
import { runModelCall, type LlmEdgeConfig, type RunModelCallDeps, type RunModelCallInput } from '../edge/llm/run-model-call';

/** Só memória: nunca recebe ferramentas nem instruções comerciais. */
export async function checkpointCall(db: pg.Pool, cfg: LlmEdgeConfig,
  input: RunModelCallInput, deps: RunModelCallDeps) {
  let failure: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const call = await runModelCall(db, cfg, { ...input, purpose: 'checkpoint', tools: undefined,
        maxSteps: 1, system: 'Registre somente memória factual confirmada. Obedeça ao esquema JSON solicitado. Nunca responda ao cliente.',
        outputSchema: checkpointOutputSchema }, deps);
      const text = call.result.text;
      const start = text.indexOf('{'), end = text.lastIndexOf('}');
      const output = parseCheckpoint(call.result.output ?? JSON.parse(text.slice(start,end+1)));
      return { ...call, result: { ...call.result, text: JSON.stringify(output) } };
    } catch (error) {
      if (isStructuredSchemaRejection(error)) throw new CheckpointSchemaError(error);
      failure = error;
      // Recusa/budget/configuração não são falhas de formatação e não gastam outra chamada.
      const name = error instanceof Error ? error.name : '';
      if (!['AI_NoObjectGeneratedError', 'AI_NoOutputGeneratedError', 'ZodError', 'SyntaxError', 'AI_UnsupportedFunctionalityError'].includes(name)) throw error;
      deps.log?.warn('checkpoint: formato recusado; recuperação limitada sem ferramentas', { category: name, attempt: attempt + 1 });
      if (name === 'AI_UnsupportedFunctionalityError') {
        // Compatibilidade anterior para provedores SEM esse recurso. A rejeição
        // de schema inválido sai acima e nunca chega aqui. Continua JSON validado,
        // sem ferramentas e sem voltar ao atendimento comercial.
        const fallback = await runModelCall(db, cfg, { ...input, purpose: 'checkpoint', tools: undefined,
          maxSteps: 1, system: 'Retorne somente JSON válido para a memória interna. Sem ferramentas ou resposta ao cliente.', outputSchema: undefined }, deps);
        const text = fallback.result.text;
        const output = parseCheckpoint(JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)));
        return { ...fallback, result: { ...fallback.result, text: JSON.stringify(output) } };
      }
    }
  }
  throw new Error('checkpoint inválido — não repetir atendimento', { cause: failure });
}
