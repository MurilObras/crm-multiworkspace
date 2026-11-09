# Tasks: recuperação da continuidade do atendimento

**Input:** `spec.md`, `assessment.md`, `plan.md`, `research.md`, `data-model.md`, `contracts/attendance.md`.
**Status:** implementação autorizada em 09/11/2026, com revisão/correção limitada e testes. Sem merge, deploy ou mensagens aos leads; operações em produção não fazem parte desta execução.

## Fase 0 — Preparação

- [X] T001 Reconferir requisitos e revisão documental em `specs/001-school-attendance-recovery/analysis.md` pelo fluxo oficial Spec Kit; preservar parecer Plandex anterior como evidência, sem segundo processo concorrente.
- [X] T002 Mapear todos os escritores de confirmação em `lib/channels/`, `lib/waha/`, `app/api/v1/messages/_handler.ts` e workers; fechar coordenação/travas em `specs/001-school-attendance-recovery/contracts/attendance.md`.
- [X] T003 Preparar amostra de áudio para avaliação semântica em `specs/001-school-attendance-recovery/research.md`, preservando a classificação já confirmada da mensagem interna e sem reprocessar produção.
- [X] T004 Autorização explícita recebida para implementar, revisar/corrigir e testar. Configuração de produção e homologação por mensagens ficam fora desta execução; sem merge/deploy.

## US1 — Resposta marcada resolve e retoma

- [X] T005 [US1] Criar matriz texto/áudio de envio confirmado, falho, em fila e incerto em novo `tests/invariants/inbox-case-resolution.test.ts`, com duas organizações sintéticas e crash/replay cruzado; observar falha antes do patch.
- [X] T006 [US1] Estender intenção validada em `lib/schemas/messaging.ts`, `app/api/v1/messages/route.ts` e `app/api/v1/messages/_handler.ts`, incluindo hash de idempotência e recusa de associação/metadado forjados.
- [X] T007 [US1] Implementar coordenação compartilhada em novo `lib/escalacao/resolucao-vinculada.ts` e consumidor `workers/case-resolution-worker.ts`, segundo T002; adicionar migration+baseline+MANIFEST somente se o desenho exigir.
- [X] T008 [US1] Incluir escolha de consulta e opção desmarcada em novo `components/inbox/PendingCaseResolution.tsx`, `components/inbox/Composer.tsx`, `hooks/inbox/useSendMessage.ts` e `hooks/ai/useCases.ts`; limpar seleção por conversa/envio.
- [X] T009 [US1] Cobrir texto, áudio, nota interna, duas consultas, troca de conversa e fechamento da aba em novos `tests/unit/inbox-case-resolution.test.tsx` e `tests/e2e/inbox-case-resolution.spec.ts`; produzir evidência visual sintética.

## US2 — Retomada verdadeira

- [X] T010 [US2] Reproduzir consulta pendente após devolução em `tests/unit/escalacao-retomada.test.ts` e `tests/invariants/inbox-case-resolution.test.ts`.
- [X] T011 [US2] Bloqueio e acesso implementados no Composer (`PendingCaseResolution.tsx`), no retorno da retomada, no painel Casos e no mapa de textos; a barra de comando conserva a atribuição existente. Não resolver dúvida por inferência.
- [X] T012 [US2] Provar proteção de opt-out, decisão humana posterior, consulta adicional, ausência de replay antigo e recuperação com IDs de outro workspace em `tests/e2e/inbox-case-resolution.spec.ts` e `tests/invariants/inbox-case-resolution.test.ts`.

## US3 — Aceite e identidade do cartão

- [X] T013 [US3] Reproduzir erro de vínculo na ponte real em novo `tests/unit/agent-lead-identity.test.ts`: UUID inexistente, de outro contato e de outra organização; verificar o contato preservado no fim da cadeia e contrato humano legítimo.
- [X] T014 [US3] Restringir relink somente na edição operacional da IA em `lib/ai/runtime/tools.ts`; preservar contrato administrativo humano e validação no servidor.
- [X] T015 [US3] Acrescentar busca por contato confiável se necessária em `lib/mcp/tools/leads.ts` e `app/api/v1/leads/_handler.ts`; validar organização/funil e não inferir identidade por nome.
- [X] T016 [US3] Provar ficha, etapa, etiquetas, falha parcial e repetição sem duplicação em novos `tests/invariants/school-trial-acceptance.test.ts` e reutilizar a jornada existente do funil, sem duplicar uma nova tela de agendamento; preparar instruções pelas telas somente na etapa autorizada.

## US4 — Aguardando pagamento

- [ ] T017 [US4] Reproduzir conflito de finalidade e inscrição única em `tests/invariants/followup-silence-resume.test.ts`, incluindo pausa e cancelamento humanos.
- [X] T018 [US4] Preparar configuração e passagem explícita em futuro `specs/001-school-attendance-recovery/contracts/payment-followup.md`, reutilizando seis retornos comerciais e janela publicados, sem ressuscitar cancelamento manual.
- [ ] T019 [US4] Aplicar e verificar pelas telas somente na escola, após autorização operacional, com recarga e evidência privada segundo `specs/001-school-attendance-recovery/quickstart.md`.
- [ ] T020 [US4] Se as telas não suportarem passagem segura, registrar reprodução e revisão de escopo em `specs/001-school-attendance-recovery/plan.md` antes de propor patch em `lib/followup/`; não criar novo motor por suposição.

## US5 — Áudio e suporte

- [ ] T021 [US5] Validar processamento e semântica de áudio novo/cópia histórica segundo `specs/001-school-attendance-recovery/quickstart.md`; usar `tests/unit/media-derive-worker.test.ts` e `tests/unit/media-derive.test.ts` para processamento, sem apresentar mock como prova de compreensão.
- [ ] T022 [US5] Provar ausência de resposta no reprocessamento em `tests/invariants/inbound-retomada-e-midia.test.ts`; só depois preparar recuperação pelas telas, sem aplicá-la agora.
- [X] T023 [US5] Verificar aviso, recibos e consulta em `tests/invariants/responsible-whatsapp.test.ts`; avaliar complemento no endpoint `app/api/v1/ai/cases/[id]/responsibles/route.ts` e componente existente `app/app/ai/cases/_components/ResponsibleDeliveryStatus.tsx`; propor patch no transcritor somente com falha atual reproduzida.

## US6 — Encerramento silencioso

- [X] T024 [US6] Acrescentar regressão de encerramento silencioso contra entrega preparada/iniciada/incerta em `tests/invariants/inbox-case-resolution.test.ts` e `tests/unit/case-reply-panel.test.tsx`.
- [X] T025 [US6] Verificar `app/api/v1/ai/cases/[id]/reply/route.ts` contra T024; corrigir apenas falha concreta, sem enqueue de resposta no encerramento interno.

## Revisão e validação futuras

- [X] T026 Revisar blocos A–D com o componente Superpowers `requesting-code-review` e seu template original `code-reviewer.md`; Graphify apoia impacto quando útil, especialistas Agency somente quando proporcionais. Até três rodadas por bloco; tratar parecer com `receiving-code-review` e registrar em `specs/001-school-attendance-recovery/analysis.md`.
- [X] T027 Executar estáticos e suíte unitária completa; guardar resultados privados conforme `specs/001-school-attendance-recovery/quickstart.md`; não substituir suíte ampla por recorte verde.
- [X] T028 Executar banco/RLS quando aplicável, build e E2E das jornadas; atualizar `docs/testing/user-journey-map.md` e fragmento `.changes/` durante a implementação.
- [ ] T029 Homologar apenas no contato de teste confirmado e registrar evidência privada conforme `specs/001-school-attendance-recovery/quickstart.md`, sem mensagens a leads.
- [X] T030 Apresentar resultado, limitações e gate de publicação em `specs/001-school-attendance-recovery/analysis.md`; não fazer merge/deploy nesta execução.

## Dependências e estratégia

T001–T004 bloqueiam patches. US1 fornece coordenação para US2/US6. US3 é bloco independente de integridade. US4/US5 priorizam comprovação e configuração existente. T026 precede suíte ampla T027–T028; reproduções de regressão acompanham cada bloco antes de seu patch. T029 exige código validado e contato de teste confirmado. T030 não concede autorização de publicação.

Sem despacho paralelo de agentes programado. Execução futura em blocos, seguindo `programe.md`; especialização não duplica coordenação/revisão. Não enviar código ou dados para serviço externo sem autorização vigente. PR 20 fora do escopo.

## Estado após revisão de código

Autorização vigente: código e testes locais; sem merge, deploy ou mensagens a leads. T027–T028 concluídas: 805 arquivos unitários, 184 arquivos de banco, build e 14 testes E2E aprovados; detalhes e exceções em `analysis.md`. T017/T019/T020 e T029 são pendências operacionais; T021/T022 exigem validação semântica/recuperação histórica de áudio e não foram marcadas por mocks. A proteção técnica contra resposta antiga está coberta, mas não substitui homologação de uma cópia real. Nenhuma configuração de produção foi alterada e cancelamentos manuais foram preservados.
