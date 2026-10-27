/** Smoke pago, opt-in, só exemplos fictícios. Nunca lê .env nem credenciais do CRM. */
import { generateText, Output } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { checkpointOutputSchema, parseCheckpoint } from '../lib/agent-engine/agent/checkpoint-contract';

async function main() {
  const key = process.env.CHECKPOINT_TEST_OPENAI_API_KEY;
  const model = process.env.CHECKPOINT_TEST_OPENAI_MODEL;
  if (process.env.CHECKPOINT_PROVIDER_SMOKE !== 'true' || !key || !model) {
    process.stderr.write('PENDENTE: configure CHECKPOINT_PROVIDER_SMOKE=true, CHECKPOINT_TEST_OPENAI_API_KEY e CHECKPOINT_TEST_OPENAI_MODEL em ambiente de teste fora da VPS. Nenhuma chamada realizada.\n');
    process.exitCode = 2;
  } else {
    const examples = [
      { text: 'Conversa fictícia: cliente agradeceu. Não houve intenção nem promessa. Registre avaliação vazia.', check: (v: ReturnType<typeof parseCheckpoint>) => v.declaracao?.nada_a_declarar === true && v.declaracao.promessas.length === 0 && v.declaracao.intencoes.length === 0 },
      { text: 'Conversa fictícia: vendedor prometeu confirmar uma condição; nenhum prazo foi combinado. Registre a promessa sem inventar prazo.', check: (v: ReturnType<typeof parseCheckpoint>) => v.declaracao?.promessas.some(p => p.prazo === null) },
      { text: 'Conversa fictícia: vendedor prometeu retornar em 2030-01-02T12:00:00Z. Registre esse prazo exatamente.', check: (v: ReturnType<typeof parseCheckpoint>) => v.declaracao?.promessas.some(p => p.prazo === '2030-01-02T12:00:00Z') },
    ];
    try {
      for (const [index, example] of examples.entries()) {
        const call = await generateText({ model: createOpenAI({ apiKey: key })(model),
          system: 'Registre somente memória factual confirmada no esquema solicitado, incluindo a declaração do turno. Nunca responda ao cliente.',
          messages: [{ role: 'user', content: example.text }], output: Output.object({schema: checkpointOutputSchema}),
          maxRetries: 0, abortSignal: AbortSignal.timeout(45_000),
        });
        if (!example.check(parseCheckpoint(call.output))) throw Error('synthetic_semantics_failed');
        process.stdout.write(`Exemplo fictício ${index + 1}: contrato e significado aprovados.\n`);
      }
    } catch {
      // A exceção do SDK pode carregar headers/requestBody. Nunca imprimi-la aqui.
      process.stderr.write('FALHOU: o smoke não aprovou todos os exemplos. Nenhum dado real ou WhatsApp utilizado.\n');
      process.exitCode = 1;
    }
  }
}
void main();
