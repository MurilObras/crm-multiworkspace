# Memória e tempo do atendimento

## Contrato e recuperação

O contrato interno continua aceitando memórias antigas. O DTO enviado ao provedor declara todos os campos como obrigatórios e fecha os objetos, inclusive itens de listas. Campos sem valor usam null. A declaração null é normalizada para ausência, não para uma avaliação positiva. Declaração avaliada e vazia conserva suas listas vazias e nada_a_declarar=true. Promessas sem prazo conservam prazo=null.

Referência: [Structured Outputs, OpenAI](https://developers.openai.com/api/docs/guides/structured-outputs). A política é conferida no JSON efetivamente serializado pelo SDK. Essa validação local não substitui o smoke remoto.

Uma rejeição HTTP 400 explicitamente de schema no checkpoint recebe checkpoint_schema_invalid. O worker a dispõe como falha técnica dead na primeira tentativa, com aviso crítico atômico sob o mesmo lease; não usa cancelamento comercial. O contador real não é falsificado. HTTP 429, 5xx e indisponibilidade continuam sujeitos ao backoff. Conteúdo JSON inválido mantém uma recuperação limitada, sempre com schema e sem ferramentas; não há fallback para texto livre.

O marcador turn_closing continua sendo persistido antes da chamada de memória. Retentativas executam apenas esse fechamento. A reconciliação de entrega, CAS/lease, deduplicação do checkpoint e proteção contra memória mais recente são preservadas. Jobs mortos anteriormente não são reabertos nesta entrega. Não há migration, tabela ou coluna nova, mudança de modelo, prompt comercial ou configuração de workspace.

## Diagnóstico e relógios

Observações agregadas da homologação anterior, sem identificação de clientes:

| Medição observada | Resultado | Limite da evidência |
| --- | --- | --- |
| Entrada registrada até preparação do primeiro texto | aproximadamente 53–77 s | sent_at no CRM não comprova recebimento no WhatsApp |
| Transporte de vídeo no adapter | aproximadamente 22–29 s | subconjunto de 3 vídeos; não é tempo só de inferência |
| Preparação desses vídeos | aproximadamente 5,8–6,6 s | distinta do transporte |
| Transporte de áudio/foto | aproximadamente 1,6–1,8 s | uma amostra de cada formato |
| Tentativas de texto, duração total | normalmente 4,6–6,4 s; uma de 21 s | inclui banco, verificações e finalização |
| Fechamento | 8 jobs com cinco rejeições 400 cada | falha após a resposta, não explica sozinha a demora anterior |

Não foi identificado intervalo configurado de 20 segundos entre texto e vídeo. Throttle padrão é 1,2 s com jitter até 0,8 s. O intervalo entre registros de mensagens não equivale à duração exclusiva do transporte.

Logs existentes outbound_attempt_timing já distinguem preparação, verificações, transporte, resultado e finalização de cada seq. llm_calls.latency_ms da conversa abrange ferramentas e transporte. Somá-lo a esses envios duplica tempo.

Novas medições, sem conteúdo, telefone, URL assinada ou credencial:

- dispatch_timing: idade do evento desde o registro no CRM, debounce configurado, job e coalescência. Inclui o tempo até concluir o dispatch; não é o instante exato da entrada no WhatsApp.
- queue_attempt_timing: idade do job e espera desde run_after desta tentativa. Retry/coalescência podem modificar run_after; isso não reconstrói o debounce original.
- job_attempt_timing: parede da tentativa inteira, inclusive fases internas e disposição do job.
- turn_phase_timing: roteamento, contexto, estágio, jailbreak, intenção de mídia, conversa, checkpoint e persistência. Cada linha tem job, workspace, tentativa, fase, resultado e duração. conversation inclui ferramentas explicitamente; fases aninhadas não são somadas ao pai.

Para um atendimento, correlacionar event_log/job/llm_calls/send_ledger/messages e os logs por job e seq. Apresentar linha do tempo com intervalos, não a soma de todas as paredes. O horário do log encerra a fase; elapsed_ms fornece seu início aproximado no mesmo processo. A medição não aumenta consultas ao banco nem altera intervalos de proteção.

**Gargalos comprovados:** transporte/preparação de vídeo e fechamento inválido repetido. **A investigar com novas medições após publicação autorizada:** participação de espera ociosa do drain, debounce, inferência auxiliar e banco no primeiro texto. Não há evidência para trocar modelo, encurtar proteções ou prometer um SLA. Recomenda-se comparar os novos intervalos antes de escolher outra otimização; o transporte depende também do canal/provedor.

## Validação e limites

Sequência: revisão/correção estática; checagens locais; banco descartável e ambas as partes do E2E em runners externos; revisão posterior ao resultado. Nenhum build/teste pesado na VPS. Evidências brutas com dados reais permanecem ignoradas em .superpowers/evidence.

Smoke pago e sintético: configurar fora da VPS CHECKPOINT_PROVIDER_SMOKE=true, CHECKPOINT_TEST_OPENAI_API_KEY (credencial própria de teste) e CHECKPOINT_TEST_OPENAI_MODEL; executar pnpm exec tsx scripts/smoke-checkpoint-provider.ts. Não lê arquivos .env, banco ou mensagens reais. Três exemplos: avaliação vazia, promessa sem prazo e promessa com prazo. Nunca imprime erros brutos do SDK. Sem credencial segura, sai com código 2 e PENDENTE, sem chamadas; não declarar aceitação remota nem aprovação completa.

Living System Checklist: entrada pelo fechamento do turno; saída na memória existente; registro llm_calls/job_queue; telas Execuções e Central já navegáveis; falha não morre em silêncio; configuração comercial preservada; continuidade limitada ao fechamento; evidência em testes SDK/banco/E2E e mapa outbound-delivery-finalization. Merge/deploy dependem de autorização específica. PR 20 fora do escopo.
