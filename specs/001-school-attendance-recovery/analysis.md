# Análise de consistência do planejamento

**Data:** 09/11/2026. A primeira parte preserva a análise documental anterior à autorização. A execução e a revisão do código estão registradas ao final.

## Cobertura dos requisitos

| Requisito | Tarefas futuras |
|---|---|
| FR-001 | T008–T009 |
| FR-002 | T005–T007, T012 |
| FR-003 | T005, T007, T009 |
| FR-004 | T012 |
| FR-005 | T010–T011 |
| FR-006 | T013–T014 |
| FR-007 | T015–T016 |
| FR-008 | T017–T020 |
| FR-009 | T018–T019, T027, T029 |
| FR-010 | T003, T021–T022 |
| FR-011 | T023 |
| FR-012 | T024–T025 |
| FR-013 | T005–T006, T012, T028 |
| FR-014 | T004, T030 |

SC-001 é coberto por esta análise; SC-002 por T024–T025; SC-003 por T007–T009; SC-004 por T005/T012/T017; SC-005 por T016; SC-006 por T017–T019; SC-007 por T021–T023; SC-008 por T029.

## Ajustes feitos apenas no planejamento

- Separada ausência de resposta da alegação de ausência de notificação: recibo do suporte confirma entrega/leitura.
- Separadas falhas históricas de áudio da atualização atual; item sem derivação classificado como mensagem interna.
- Suspeita de envio ao encerrar internamente não convertida em bug confirmado: amostra de 12 casos sem esse efeito em cinco minutos.
- Resolução pelo Inbox exige escolha explícita e confirmação real, não bolha otimista/HTTP 200.
- Recuperação após crash não reenvia a resposta e não sobrepõe decisão humana posterior.
- Pagamento não reativa inscrição cancelada manualmente e não remove exclusividade de fluxo.
- Não foi criada exigência de perfeição: saída da revisão futura tem severidade, cobertura e limite de rodadas.

## Pontos que bloqueiam implementação

1. **T002:** fechar consumidor/travas após mapear todos os escritores de confirmação. O plano declara a arquitetura preferida, mas não afirma que o schema atual já garante a coordenação.
2. **T004:** autorização do usuário. A instrução vigente proíbe implementar agora.
3. **Validação futura:** nenhum teste de produto foi executado. Revisão do documento não comprova correção do CRM.

## Resultado da revisão externa

Revisão do planejamento concluída pelo Plandex, em modo chat, com comandos e aplicação automática desligados. Contexto continha somente documentos anonimizados; sem dados brutos de atendimento. Evidência privada: `plandex-plan-review.txt`, no diretório de diagnóstico local. Não equivale a revisão de código, teste ou aprovação da implementação.

| Achado do Plandex | Avaliação e tratamento no plano |
|---|---|
| Áudio em fila/falha/incerto precisa de cobertura própria | Reforçado em T005 e no roteiro: matriz de texto e áudio para cada estado, não apenas teste de texto com áudio no caminho feliz. |
| Coordenação durável/travas ainda não fechadas | Válido e mantido como bloqueador técnico T002; não declarar essa arquitetura comprovada antes da reprodução e do desenho final. |
| UI deve distinguir atribuição de aptidão | Já previsto em US2/T011; contrato agora exige estado explícito e acesso ao caso sem resolução implícita. |
| Corrida no encerramento silencioso | Já prevista em US6/T024 e protegida em parte na rota atual; manter regressão, sem converter suspeita em patch automático. |
| Rejeitar vínculo de contato cruzado | Reforçado em T013: testar UUID inexistente, de outro contato e de outra organização na ponte real. |
| Suporte deve separar recibo de resolução | Há componente `ResponsibleDeliveryStatus.tsx` existente; reutilizar e avaliar complemento de recibos, não criar painel paralelo. |
| Isolamento também em crash/replay | Reforçado em T005/T012; duas organizações, envio e recuperação com IDs cruzados, sem consumir/resolver consulta alheia. |

Algumas recomendações repetiam requisitos já escritos; foram tratadas como reforço de cobertura, não como novos bugs confirmados. Nenhum achado foi aplicado em código.

## Verificação da entrega documental

Conferência documental concluída: 10 documentos, 30 tarefas sequenciais e únicas, nenhum link local quebrado. Git sem alterações de arquivos de produto em relação à base; somente os 10 Markdown novos de planejamento. Nenhuma suíte de implementação, CI, E2E ou homologação WhatsApp foi executada nesta fase. Resultado em `planning-validation.json`, fora do Git.

**Veredito:** planejamento estruturado e revisado, pronto para discussão/aprovação. Implementação bloqueada pela instrução vigente e pelo fechamento técnico de T002. Não há alegação de CRM corrigido.

## Execução autorizada e revisões da implementação

O usuário autorizou posteriormente implementar e testar com PROGRAME atualizada, sem merge, deploy ou mensagens a leads. T004 foi atendida. T002 foi fechado com intenção privada, confirmação por trigger, consumidor de evento e revisão monotônica de comando. O código é genérico; nenhuma configuração de workspace foi alterada em produção.

| Rodada/bloco | Achado confirmado | Correção e evidência focal |
|---|---|---|
| B — revisão independente | Nenhum P0/P1/P2 no patch de identidade | Ponte real com relink descartado apenas na IA; catálogo humano preservado; 10 testes focais da ponte aprovados. |
| A — rodada 1 | Confirmação baseada em status editável poderia ser indevida; consulta antiga fora do resumo; seleção de áudio inválida | Intenção privada e mensagem vinculada protegida; consulta de existência separada/fail-closed; envio de áudio bloqueado sem seleção. Reprodução antes dos patches e novas regressões. |
| A — rodada 2 | Encerramento interno poderia liberar resposta preparada; FK do autor impedia exclusão; uma consulta não poderia cancelar a resposta de outra | Marcador atômico `internal_no_send`, trava comum com CAS do transporte, descarte via lease existente; FK preserva histórico sem autor; `case_reply_turn` limita o corte ao próprio caso. |
| A — rodada 3 | Nenhum P0/P1/P2 pendente identificado na versão revisada | Revisor independente conferiu o delta e executou 17/17 testes da migração/consumidor; liberou apenas para testes de fechamento. |

Revisão não significa ausência absoluta de defeitos. A fase seguinte valida estáticos, suíte unitária completa, baseline install/update, invariantes e jornadas pela tela. Qualquer falha impede avançar sem tratamento; o limite de rodadas não autoriza publicar.

### Limites que permanecem explícitos

- Aguardando pagamento: preparar passagem explícita pela configuração existente, preservando orçamento e cancelamentos. Nenhuma inscrição real foi reativada.
- Áudio: a falha histórica de credencial já estava corrigida na base. Recibos ficaram visíveis; processamento simulado não comprova fidelidade semântica. Não foi inventado patch de transcritor.
- Encerramento silencioso preserva a incerteza de envio já iniciado; não promete impedir retroativamente uma entrega que já cruzou a rede.
- Homologação WhatsApp da versão nova depende de publicação futura, não autorizada nesta execução. Nenhuma conversa real foi usada como receiver de testes.

### Sistema vivo

Entrada: opção explícita no Composer e contrato `resolve_case_id`. Saída: caso/eventos/checkpoint e `ai.handoff_resolved`. Observação: endpoint de progresso, Inbox e Casos com recibos. Recuperação: `caseResolutionHandler` no dispatcher existente, com replay idempotente. Laço de retorno: motivo parcial/impedido volta à consulta acionável e à conferência humana; nova pergunta usa a decisão registrada, sem repetir o inbound já respondido. Mapa: `docs/architecture/inbox-case-resolution.architecture.json`.

### Ajustes encontrados nos testes de fechamento

A primeira execução ampla com a preparação correta do SQL terminou com 801 arquivos aprovados e quatro reprovados (8.851 testes aprovados, 24 falhas e uma falha esperada). Os resultados foram preservados, sem tratá-los como aprovação.

- Completadas as traduções dos controles, estados e motivos novos do Inbox/Casos.
- O bloco da migration 0247 no baseline foi colocado antes da varredura final de permissões, mantendo o espelho SQL integral e o endurecimento como último bloco.
- Dois dublês de atualização de conversa aceitam agora os filtros encadeados de ID e organização, como o cliente real; o filtro de organização do produto foi preservado.
- Acrescentada jornada pela tela para anexar WAV sintético, normalizar/subir o áudio no Storage local e preservar `resolve_case_id`, sem concluir prematuramente consulta nem iniciar transporte externo.

Retestes pontuais dos quatro arquivos anteriormente reprovados: 37 testes aprovados. Typecheck e lint dos arquivos complementados sem erros. A suíte completa deve ser repetida na cópia local atualizada; estes retestes não substituem esse gate, o banco real, o build ou o E2E.

### Resultado amplo confirmado até aqui

Estáticos repetidos: typecheck, lint, regras de canais, papéis e conferência de release aprovados; lint com avisos, sem erros. `pnpm test:unit`: 805 arquivos aprovados, 8.875 testes aprovados e uma falha esperada preexistente em `agenda-separar-historico.test.tsx` (compromisso em andamento classificado no histórico); os quatro smoke tests de importação também passaram. A falha esperada de Agenda fica fora deste patch e não foi ocultada nem alterada.

Na preparação do banco foram corrigidos dois problemas locais, preservando os resultados inválidos: gravação Windows com CRLF em corpo SQL validado por hash (restaurado LF como no Git, sem mudar texto/hash) e configuração privada de dois processos concorrentes sobre o banco recriado por arquivo (repetição com exatamente um processo). Instalação e reaplicação estritas do baseline passaram. Retestes após restaurar LF: 10 testes unitários do baseline/playbook aprovados; invariantes, build e E2E permanecem dependentes da execução completa.

O gate amplo de banco encontrou ainda duas lacunas de validação: faltava registrar a prova comportamental da tabela nova na varredura de completude, e o transporte de teste `pg` perdia microssegundos que o PostgREST preserva. Foram acrescentadas provas com duas organizações, JWT/papel real, leitura própria/recusa vizinha em ambos os sentidos, negação de escrita e controle positivo do serviço; a tabela foi registrada em `PROVA_PROPRIA`, sem ampliar dívida nem afrouxar políticas. O parser de datas foi corrigido somente no pool do teste de avanço, com regressão de roundtrip; a comparação otimista do produto foi preservada. Reteste focal: 63 testes de banco aprovados.

Repetição ampla final do banco: 184 arquivos aprovados, 1.579 testes aprovados e um desativado preexistente (`webhooks-inbound.test.ts`, cenário vazio de rate limit 429, que declara cobertura unitária do fallback). Instalação e reaplicação com `ON_ERROR_STOP=1` aprovadas, incluindo a varredura final de permissões. Nenhuma configuração ou dado de produção foi alterado.

## Fechamento da validação local

| Gate | Resultado observado |
|---|---|
| Tipos, lint e regras do projeto | Aprovados; lint com 0 erros e 322 avisos. Conferência de release sem escrever versão. |
| Suíte unitária completa | 805 arquivos aprovados; 8.875 testes aprovados, uma falha esperada preexistente de Agenda e quatro smoke tests aprovados. |
| Banco real e baseline | 184 arquivos aprovados; 1.579 testes aprovados e um desativado preexistente; install/update estritos aprovados. |
| Build | `pnpm e2e:build` aprovado; bundle verifica Supabase local, sem URL de produção. |
| Jornadas pela tela | 14/14 aprovadas em cinco specs: Inbox/resolução, gatilho de caso, ciclo de escalação, conversa vira lead e áudios pré-gravados. |
| Evidência visual | Desktop 1280×720 e celular 390×844 inspecionados; escolha e envio acessíveis. O canal sintético parado deixa explícito que fila não é entrega. |
| Identidade da versão | 53 arquivos TypeScript/SQL de código e testes comparados entre checkout e cópia de validação; zero divergências na forma canônica LF do Git. |

Os testes de UI cobrem o fluxo real até persistência/fila, upload e normalização no Storage local, sem transporte WhatsApp externo. Confirmação, recuperação, concorrência e bloqueios são exercitados no PostgreSQL real; não se confundem com prova de entrega a um número real. Os logs/capturas completos e resultados inválidos anteriores ficam na pasta privada de validação, fora do Git.

### Pendências separadas e gate de publicação

- T017/T019/T020: validar e aplicar a configuração de acompanhamento de pagamento, sem reativar cancelamentos manuais ou duplicar fluxos. Nenhuma inscrição real foi alterada.
- T021/T022/T029: homologação semântica de áudio e eventual recuperação histórica em ambiente publicado/contato de teste autorizado; nenhuma mensagem a leads nesta execução.
- CI remoto e imagens de distribuição não foram acionados por push/PR; são gates posteriores antes de qualquer merge autorizado. Os checks locais não são apresentados como CI remoto.
- Achado preexistente fora do patch: o E2E registrou `[ai_agents/publish] event_log error` por `entity_kind` nulo. A rota `app/api/v1/ai/agents/[id]/publish/route.ts` não foi alterada e sua gravação fire-and-forget omite esse campo. A interface publicou a versão, mas esse rastro de evento não foi validado; fica para investigação/correção separada, sem alegação de que os logs estão livres de erros.

**Veredito:** bloco de código validado localmente dentro deste escopo e com as exceções acima declaradas. Não é autorização de merge/deploy, nem declaração de CRM sem defeitos. PR 20 não foi alterado; produção e conversas reais permanecem intactas.
