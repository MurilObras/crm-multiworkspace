# Implementation Plan: continuidade e operação da escola

**Branch:** `fix/school-handoff-audio-followups` | **Date:** 2026-11-09 | **Spec:** [spec.md](spec.md)
**Status:** implementação autorizada em 09/11/2026. Seguir PROGRAME atualizada; sem merge, deploy, mensagens aos leads ou alterações operacionais em produção.

## Summary

Corrigir continuidade humana/IA e registro de experimental; preparar acompanhamento de pagamento e validar áudios históricos sem repetir correção já publicada. Resolução pelo Inbox será explícita e vinculada ao transporte confirmado. Proteções de controle humano e envio permanecem.

## Technical Context

- **Language/Version:** TypeScript 6, Node 22+, React 19, Next.js 16, pnpm 9.15.9.
- **Primary Dependencies:** componentes/hooks atuais do Inbox e Casos, Zod, Supabase, engine e WAHA existentes.
- **Storage:** Postgres e Storage privado. Priorizar mensagens/eventos existentes; nenhuma tabela nova presumida.
- **Testing:** futuramente Vitest, banco efêmero/RLS, Playwright e WhatsApp restrito ao contato de teste.
- **Target Platform:** web desktop/mobile e runtime Linux da VPS.
- **Project Type:** CRM multiworkspace existente; correções e configuração, sem nova plataforma.
- **Performance Goals:** consultar pendências por organização/conversa, sem varrer a carteira inteira; manter consultas e lotes limitados.
- **Constraints:** zero reenvio por retry da resolução, identidade estável, pausa/cancelamento humano preservados e confirmação antes de sucesso.
- **Scale/Scope:** código genérico preserva outros workspaces; configuração e reparação operacional somente na escola.

## Constitution Check

1. Nesta etapa, patches e testes isolados autorizados. Nenhum ajuste operacional em produção, envio a leads, merge ou deploy.
2. Autoridade: `AGENTS.md` e `CLAUDE.md` atuais. Não criar regras concorrentes.
3. Tenancy/RBAC: IDs validados contra organização confiável, acesso do usuário e relações entre entidades.
4. Regra compartilhada: Inbox e Casos não terão implementações divergentes de resolver/devolver.
5. Idempotência: preparado/incerto não é enviado; repetição não duplica evento, resolução ou resposta.
6. Schema, se necessário: migration nova + baseline idempotente + MANIFEST + permissões + tipos gerados + teste de duas organizações.
7. Operação: evento tem consumidor, rastro e tela; falha parcial aparece como parcial.
8. Futuro aceite: testes reais relevantes, evidência visual, documentação e fragmento `.changes/`.

## Project Structure

Documentos: `specs/001-school-attendance-recovery/`.

Fontes previstas: `components/inbox/`, `hooks/inbox/`, `app/api/v1/messages/`, `app/api/v1/ai/cases/`, `lib/escalacao/`, `lib/responsibles/`, `lib/ai/runtime/`, `lib/mcp/tools/`, `workers/` e, condicionalmente, `lib/followup/`.

Diretórios de produto limitados aos blocos autorizados, com regressões antes dos patches e revisão antes da suíte de fechamento.

## Blocos futuros

### A — Consulta, resposta humana e retomada (US1, US2, US6)

1. Reproduzir bloqueio por consulta pendente, resposta em fila/falha e retomada com decisão humana concorrente.
2. Listar consultas abertas acessíveis da conversa. Adicionar opção aprovada, desmarcada, com escolha explícita de caso quando necessário. Associar escolha à conversa e ao envio, inclusive áudio; nunca à nota interna.
3. Estender contrato de envio com intenção validada de resolução. Não usar metadado arbitrário como autoridade.
4. Persistir intenção antes do transporte; aplicar encerramento e retomada em coordenação durável compartilhada depois de transporte confirmado. `sent`, `delivered` e `read` com confirmação consistente são elegíveis; `queued`, `sending`, `failed` e incerto não são.
5. Recuperar crash após transporte sem reenviar a resposta. Não depender de aba aberta ou segundo POST do navegador.
6. Revalidar consulta, pedido externo, conversa e decisão humana mais recente. Manter outra consulta impeditiva e opt-out. Informar resolução parcial se o caso concluiu mas a IA não pôde ser liberada.
7. Tornar explícita na tela Casos a opção de responder e continuar. Cabeçalho de devolução deve mostrar consulta impeditiva, sem concluí-la por inferência.
8. Preservar encerramento silencioso, bloqueando liberação tardia de resposta preparada e reconhecendo transporte iniciado/incerto.

**Arquivos previstos:** `components/inbox/Composer.tsx`, novo `components/inbox/PendingCaseResolution.tsx`, `hooks/inbox/useSendMessage.ts`, `hooks/ai/useCases.ts`, schema canônico de mensagens, `app/api/v1/messages/route.ts`, `app/api/v1/messages/_handler.ts`, novo serviço em `lib/escalacao/resolucao-vinculada.ts`, consumidor junto a `workers/`, `lib/escalacao/retomada.ts`, `components/inbox/ConversationHeader.tsx`, `app/app/ai/cases/_components/CaseReplyPanel.tsx` e `lib/ai/case-copy.ts`.

**Desenho a fechar antes de patch:** mapear todos os escritores de status e definir consumidor/travas que cubram envio imediato, eco, retry e recuperação. Preferência: intenção estruturada na mensagem e consumidor idempotente de confirmação existente. Confirmar compatibilidade com a regra atual de devolução; se exigir função transacional, propor migration específica. Não escolher um caminho client-side frágil para evitar uma migration.

### B — Integridade da ficha e avanço (US3)

1. Reproduzir UUID incorreto na ponte real da ferramenta, com dados sintéticos.
2. Impedir relink na edição operacional da IA. Preservar administração humana e a FK; não corrigir UUID por aproximação.
3. Localizar oportunidade por contato confiável e funil permitido, evitando paginar toda a carteira.
4. Atualizar ficha, etapa e etiquetas com resultado verificado em cada passo. Retry conclui apenas pendências; não duplica cartão nem confirma agendamento parcialmente salvo.
5. Usar campos operacionais definidos pelo funil; não criar duas fontes concorrentes de data/unidade em descrição e campos.

**Arquivos previstos:** `lib/ai/runtime/tools.ts`, `lib/mcp/tools/leads.ts`, `lib/agent-engine/edge/crm/mcp-tools.ts`, `app/api/v1/leads/_handler.ts` se necessário ao filtro, testes da ponte e agendamento. Instruções comerciais só serão ajustadas pelas telas na etapa autorizada.

### C — Continuidade de pagamento (US4)

1. Provar incompatibilidade pós-aula/pagamento e exclusividade da inscrição em ambiente isolado.
2. Preparar configuração de pagamento usando seis retornos comerciais publicados e contexto da etapa, sem nova régua/condição comercial.
3. Na mudança de finalidade, finalizar explicitamente o fluxo antigo e registrar a passagem. Não reativar cancelamento manual sem nova decisão humana.
4. Mostrar próxima avaliação ou motivo de parada; intenção de pagar não confirma matrícula/pagamento.

**Preferência:** telas existentes. Código somente se reprodução comprovar que a transição segura não é suportada. Nesse caso, revisar escopo antes de patch; não criar segundo motor nem remover exclusividade de fluxo.

### D — Áudio e suporte (US5)

1. Preservar classificação já confirmada: item sem derivação é interno do coordenador. Para novos casos, distinguir mensagem interna, revogada, sem mídia persistida ou falha atual.
2. Avaliar transcrição e significado em cópias autorizadas e áudio novo de teste.
3. Preparar recuperação histórica pelas telas, provando ausência de envio automático. Não executar agora.
4. Validar consulta ao coordenador, não duplicação de notificação e recibos de envio/entrega/leitura.

**Preferência:** reprocessamento/configuração existentes. Novo patch de transcrição somente com falha atual reproduzida. `ready` não substitui avaliação de significado.

## Ordem, revisão, testes e parada

1. Revisar este plano, resolver pendências e obter autorização de implementação.
2. Implementar A e B em marcos pequenos, com teste de regressão reproduzindo cada falha antes do patch; revisar/corrigir por bloco.
3. Preparar C e D isoladamente, sem tocar leads reais.
4. Até três rodadas de revisão por bloco. Corrigir achados concretos e revisar novamente. Causa desconhecida persistente ou mudança de regra exige pausa e relato; não empilhar remendos.
5. Saída da revisão: nenhum P0/P1/P2 aberto no escopo, critérios de concorrência cobertos e melhorias cosméticas registradas à parte. Não prometer ausência absoluta de defeitos.
6. Só então executar suíte ampla: estáticos, unitária completa, banco/RLS quando aplicável, build e E2E das jornadas. Conferir checks obrigatórios reais antes de PR.
7. Homologação WhatsApp apenas com contato de teste confirmado, aquecimento mantido e nenhum disparo a lead.
8. Merge/deploy são etapas futuras; esta entrega não os libera.

## Complexity Tracking

Sem tabela, biblioteca de IA ou refatoração global presumidas. A coordenação durável é necessária para não perder resolução em crash. Se persistência e travas atuais forem insuficientes, propor schema mínimo, documentar impacto e revisar o plano antes de implementar.
