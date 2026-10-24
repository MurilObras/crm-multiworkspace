# Envio contextual de mídias

## Contrato

`ai_agents.config.media_replay_policy` usa `explicit_media_request` por padrão (compatibilidade). `explicit_repeat` exige intenção clara de repetição para áudio, imagem e vídeo. Ambos exigem permissão de reenvio do arquivo e entrega anterior confirmada; tentativa pendente/incerta ou mesma inbound não ganha outra cópia. A impressão digital protege arquivos recadastrados com outro ID.

O classificador considera o catálogo ativo antes dos filtros de histórico/preferência. `job_queue.payload.media_intent_decision` guarda escopo, hash da interação pendente, hash da aprovação, intenção e autorização. A decisão é escrita sob lease e reaproveitada no retry. Não é aceita como argumento de tool. Alteração de transcrição, política ou aprovação invalida a prova. A escolha não libera etapa nem pausa: `freshAudios` e o sink revalidam as proteções reais, inclusive imediatamente antes do transporte.

Recepção não concorre com uma mídia específica. Pedidos sobre usar áudio para registrar dados não significam receber uma gravação. Preferência temporária é aplicada à mensagem atual sem substituir a preferência durável. Os marcadores JSON existentes têm versão para reconciliar preferências antigas.

Após a mídia, `send_message` veta explicações adicionais. Texto de contexto deve preceder o arquivo. URLs avulsas não contornam decisões de catálogos gerenciados. Turnos legados sem catálogo conservam o contrato anterior de URLs aprovadas.

## Telas

- Conversa → Mídias aprovadas → Política de reenvio. Cada workspace/agente mantém configuração independente, salva pelo PATCH existente com revisão e auditoria.
- Teste → Cenário fictício de mídia: primeira solicitação, item correspondente já entregue ou preferência anterior por texto; etapa fictícia selecionável pelo nome.
- Arquivos planejados são lembrados apenas no histórico fictício. “Nova conversa de teste” limpa o estado. Nenhuma mensagem real, contato ou preferência de cliente é alterada.
- O ensaio usa o mesmo contrato de classificação e autorização. `planned` não é confirmação de transporte. Roteador, pausas reais, pacing, spinning, canal, fila e entrega exigem os testes de integração/transporte.
- Execuções → detalhe: leitura por `llm_calls.job_id` → job → ledger → mensagem, com escopo explícito. Não há aproximação temporal nem reconstrução de registros antigos.

## Matriz de validação

1. Pedidos naturais de demonstração, despesa e lembrete sem palavra de formato; assunto específico vence recepção.
2. Primeira utilização, assunto repetido e “de novo/outra vez/reenviar” nos três formatos.
3. Política antiga/nova; reenvio desligado; arquivo desativado ou alterado; fingerprint com outro ID.
4. Preferência geral, preferência temporária, novo pedido de formato e uso do produto por áudio.
5. Retry, mesma inbound, tentativa preparada/incerta, nova mensagem durante preparação/assinatura do Storage.
6. Etapa alterada, atendimento humano, opt-out, isolamento de organização/contato e lease perdido.
7. Ensaio com planejamento, sem entrega fictícia, sem fallback de transporte e com contexto antes da mídia.

As provas estão em `contextual-media-intent.test.ts`, `media-run-diagnostic.test.ts`, `test-conversation.test.ts`, `conversation-audios.test.ts`, `audio-rule.test.ts`, invariantes `inbound-retomada-e-midia`, testes de outbound e E2E `audios-pre-gravados`/`video-test-executions`.

## Ativação e entrega

Nenhuma migration, tabela ou coluna nova. Nenhum workspace é alterado por instalação. Após publicação autorizada, selecionar explicitamente o agente desejado e habilitar `explicit_repeat`; preservar os demais na compatibilidade. Conferir condições, catálogo opcional/contextual e conhecimento pelas telas, sem acrescentar URL alternativa de material desativado.

Este PR não autoriza merge, publicação nem mensagens reais. Após autorização, homologar apenas no contato de teste combinado e preservar o histórico. Primeira entrega será evidenciada no ambiente isolado, sem apresentar continuidade de contato antigo como novo lead.

## Sistema vivo

- Entrada: configuração operacional existente e turno inbound; saída: catálogo escolhido → tool/required plan → sink.
- Visibilidade: TestPanel, Runs/RunDetailDrawer, estado real de messages/send_ledger e atividade de veto existente.
- Navegação: abas já existentes de Conversa, Teste e Execuções.
- Anti-morte: persistência sob lease, hash da fonte/aprovação, ledger e guardas atuais de retomada.
- Retorno: operador identifica motivo no diagnóstico, corrige condição/aprovação/política pelas telas e retesta em cenário fictício. Pendência/incerteza não dispara reenvio automático.
- Mapa: `docs/architecture/audios-pre-gravados.architecture.json` liga classificador, prova persistida, pré-voo, ensaio e diagnóstico.

## Evidências locais — 2026-10-24

Validação com Node 22 e pnpm 9.15.9, sem canal WhatsApp real conectado ao ambiente de teste:

| Verificação | Resultado |
| --- | --- |
| Typecheck, lint, canais e hierarquia de papéis | Aprovados; lint sem erros, com avisos preexistentes |
| Build E2E com configuração sintética local | Aprovado, incluindo conferência do destino do bundle |
| `pnpm test:db tests/invariants/inbound-retomada-e-midia.test.ts` | 47 aprovados; baseline instalado e reaplicado em Postgres descartável |
| Suíte Vitest completa em Linux isolado | 8.570 aprovados; quatro arquivos excederam limites de teste/preparação e foram retestados separadamente |
| Reteste final, incluindo esses quatro arquivos e a fonte final dos módulos afetados | 10 arquivos, 203 testes aprovados, sem skips |
| `node --test tests/unit/event-log-imports.smoke.cjs` | 4 aprovados |
| Playwright `audios-pre-gravados` e `video-test-executions` | 10 cenários aprovados (5 + 5, com repetição da spec afetada) |

O E2E revelou um status inválido na fixture de `send_ledger`; a preparação foi corrigida para `accepted` e a spec inteira passou novamente. Nenhum limite de tempo foi ampliado e nenhuma exclusão foi adicionada. A revisão após os testes não encontrou outra falha relevante neste escopo.

As capturas de política salva, planejamento, repetição bloqueada e diagnóstico foram inspecionadas. O cenário da interface do ensaio usa uma resposta HTTP controlada para conferir apresentação e continuidade do estado fictício; classificação/autorização e ferramentas são exercitadas separadamente com adaptadores controlados nos testes do runtime e banco. Esses resultados não comprovam acurácia de um provedor de IA ao vivo nem entrega real no WhatsApp. Logs e capturas locais ficam no diretório ignorado `.superpowers/evidence/contextual-media-intent` e nos diretórios das specs. O CI deverá conferir novamente a fonte do PR, incluindo ambas as partes do E2E.
