# Feature Specification: continuidade do atendimento da escola

**Feature Branch:** `fix/school-handoff-audio-followups`
**Created:** 2026-11-09
**Status:** implementação autorizada em 09/11/2026; publicação e mensagens a leads proibidas nesta execução.
**Input:** seis problemas relatados e escolha explícita sobre resolução da consulta pelo Inbox.

## User Scenarios & Testing

### US1 — Responder pelo Inbox e liberar o atendimento (Priority: P1)

Como atendente, quero indicar quando minha resposta resolve uma consulta específica, sem fechar pendências com um cumprimento.

**Independent Test:** conversa sintética com consulta aberta e pausa humana; enviar resposta marcada, confirmar transporte e fazer nova pergunta.

**Acceptance Scenarios:**

1. **Given** consulta aberta, **When** abrir o campo de resposta, **Then** mostrar “Esta resposta resolve a consulta e libera o Júnior”, desmarcada.
2. **Given** opção desmarcada, **When** enviar mensagem, **Then** preservar comportamento atual; não encerrar consulta automaticamente.
3. **Given** opção marcada e consulta selecionada, **When** texto ou áudio tiver transporte confirmado, **Then** concluir somente essa consulta, registrar a mensagem que a resolveu e devolver o atendimento, salvo bloqueio restante ou decisão humana posterior.
4. **Given** mensagem em fila, falha ou entrega incerta, **When** atualizar a tela, **Then** não anunciar resolução nem liberar IA por causa desse envio.
5. **Given** várias consultas elegíveis, **When** marcar a opção, **Then** exigir escolha de uma; não concluir todas.
6. **Given** consulta resolvida e controle devolvido, **When** chegar outra pergunta, **Then** responder usando o contexto humano, sem permanecer preso ao caso encerrado.
7. **Given** outra consulta, opt-out ou nova decisão humana, **When** concluir a selecionada, **Then** preservar o bloqueio restante e explicar qual é.

### US2 — Devolver ao automático com estado verdadeiro (Priority: P1)

**Independent Test:** devolver conversa ainda bloqueada por consulta; a interface deve explicar o impedimento e permitir abri-lo.

1. Devolver não inventa resposta nem fecha consultas por conta própria.
2. A interface distingue atribuição à IA de aptidão efetiva para responder.
3. Retomada não repete pergunta, áudio ou resposta antiga já atendida pelo humano.
4. Pausa/cancelamento manual de follow-up permanecem; fechar consulta só remove o bloqueio dessa consulta.

### US3 — Registrar aceite de experimental com identidade estável (Priority: P1)

**Independent Test:** repetir aceite com tentativa de vínculo errado, usando dados sintéticos.

1. Edição operacional da IA preserva contato e oportunidade corretos.
2. Registrar atleta, unidade e data/horário completos; conferir etapa e etiquetas antes de confirmar ao responsável.
3. Falha parcial produz pendência recuperável; não confirma agendamento inexistente nem duplica cartão.
4. Respeitar turma, feriados, fuso e remarcação. Não presumir presença, vaga garantida, matrícula ou pagamento.

### US4 — Acompanhar aguardando pagamento (Priority: P2)

**Independent Test:** pessoa decide pagar e fica em silêncio; o acompanhamento deve corresponder à etapa e parar quando necessário.

1. Mostrar fluxo atual, próxima data ou motivo de parada.
2. Pagamento não depende de continuar na etapa de experimental.
3. Passagem do pós-aula não mantém dois fluxos vivos nem repete retornos enviados.
4. Cancelamento humano anterior exige nova ação explícita, sem reativação automática.
5. Prazo combinado com a família prevalece. Sem prazo novo, reaproveitar cadência comercial publicada; não criar nova régua de cobrança.
6. Proativos somente segunda–sexta, 08h–20h, America/Sao_Paulo; aquecimento ligado. Resposta, recusa, comprovante em conferência, matrícula ou humano interrompem/reavaliam conforme política publicada.

### US5 — Áudio compreendido e suporte visível (Priority: P2)

**Independent Test:** cópia autorizada de áudio antigo e áudio novo no contato de teste; comparar transcrição e significado.

1. Distinguir arquivo ausente, falha de processamento e conteúdo incompreensível.
2. Reprocessar histórico não envia mensagem ao lead nem apaga atendimento humano.
3. Persistindo falha em áudio novo, abrir/atualizar consulta contextual ao coordenador conforme configuração, sem aviso genérico ao cliente nem duplicação da mesma pendência.
4. Mostrar envio, entrega e leitura do aviso sem tratá-los como resolução da consulta.
5. Texto não vazio não prova compreensão correta.

### US6 — Encerramento silencioso preservado (Priority: P1, regressão)

**Independent Test:** encerrar internamente com entregas concorrentes e observar mensagens e filas.

1. Não criar turno de resposta nem transmitir resposta ao cliente por esse encerramento.
2. Não liberar resposta antiga preparada depois do encerramento.
3. Transporte iniciado/incerto exige conferência; não prometer silêncio retroativo.
4. Acompanhamento independente pode continuar se ativo; a tela diferencia isso de resposta ao caso. Pausa/cancelamento manual não são desfeitos.

## Requirements

- **FR-001:** opção explícita no Inbox, desmarcada, associada à consulta selecionada e ao envio específico.
- **FR-002:** validar ator, organização, acesso, caso, conversa, contato e mensagem; não aceitar IDs/metadados como autoridade do navegador.
- **FR-003:** coordenar resolução e retomada após transporte confirmado, com recuperação durável sem reenvio.
- **FR-004:** preservar controle humano posterior, outras consultas, bloqueios e opt-out.
- **FR-005:** tornar impedimentos da retomada visíveis e acionáveis.
- **FR-006:** impedir alteração do vínculo do contato na edição operacional feita pela IA.
- **FR-007:** conferir ficha, etapa e etiquetas após aceite de experimental; recuperar falhas parciais sem duplicação.
- **FR-008:** passagem controlada ao acompanhamento de pagamento, respeitando inscrição única e cancelamento manual.
- **FR-009:** preservar cadência aprovada, prazo combinado, janela, dias úteis e aquecimento.
- **FR-010:** separar áudio histórico de falha atual; avaliar processamento e significado, sem resposta automática no reprocessamento.
- **FR-011:** diferenciar notificação enviada/entregue/lida de consulta resolvida.
- **FR-012:** preservar encerramento interno sem envio, inclusive em concorrência.
- **FR-013:** isolamento de workspaces, auditoria sem dados pessoais e testes com duas organizações.
- **FR-014:** implementar e testar somente o plano aprovado; nenhuma alteração operacional em produção, mensagem a leads, merge ou deploy nesta execução.

## Key Entities

Consulta, pedido ao coordenador, mensagem humana, intenção de resolução, conversa, contato, oportunidade, etapa e inscrição de acompanhamento. Relações e transições em [data-model.md](data-model.md).

## Success Criteria

- **SC-001:** todos os requisitos e cenários têm tarefa e teste futuro identificados.
- **SC-002:** zero resposta adicional causada pelo encerramento interno nas regressões, incluindo fila preparada.
- **SC-003:** envio marcado e confirmado resolve uma consulta, uma vez, com rastro e sem envio duplicado.
- **SC-004:** zero liberação indevida em envio falho/incerto, opt-out, cancelamento manual ou controle humano posterior.
- **SC-005:** aceite persiste vínculo, ficha, etapa e etiquetas após recarregar.
- **SC-006:** pagamento tem um acompanhamento elegível ou motivo explícito de parada.
- **SC-007:** áudios do roteiro têm significado validado; falha encaminha ao coordenador sem interpretação inventada.
- **SC-008:** nenhuma mensagem de homologação chega a lead real; somente contato de teste autorizado.

## Assumptions e limites

Correções genéricas preservam demais workspaces. Configuração comercial e reparação operacional somente na escola. Não inferir identidade por nome ou UUID aproximado. Não modificar preço, promoção, turma, prazo ou condição comercial. PR 20, dashboard, novos canais e troca de stack de IA ficam fora.
