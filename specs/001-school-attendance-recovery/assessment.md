# Bug Assessment: continuidade, acompanhamentos, áudios e funil

- **Slug:** school-attendance-recovery
- **Created:** 2026-11-09
- **Source:** relato do usuário e registros do Escola Atlético Oficial, consultados em leitura.
- **Verdict:** falhas confirmadas, configuração incompatível e suspeitas não confirmadas.
- **Severity:** high para continuidade e agendamento; medium para clareza operacional.
- **Estado:** avaliação e proposta; nenhuma correção aplicada.

## Resultado da investigação

| ID | Relato | Evidência | Encaminhamento |
|---|---|---|---|
| B01 | Devolveu ao agente, mas ele não respondeu | Conversa alvo em automático; consulta de áudio ainda `awaiting_human`, com pedido ao coordenador pendente. O runtime interrompe turnos enquanto esse pedido estiver pendente. | Falha de continuidade confirmada. Mostrar bloqueio e oferecer conclusão explícita da consulta; não remover a proteção. |
| B02 | Aguardando pagamento sem follow-up | No snapshot havia um cartão nessa etapa. O comercial estava cancelado manualmente; o pós-aula estava ativo, com avaliação prevista para 09/11 às 14:13 BRT. O grafo exige etapa de experimental. Há limite de um fluxo vivo por contato. | Lacuna de configuração/transição. Preparar passagem para pagamento sem ressuscitar cancelamento manual. Não está provado que uma avaliação vencida deixou de executar. |
| B03 | Resposta no Inbox não fecha caso nem devolve o agente | Envio humano e resolução do caso são operações distintas. Consulta pendente, pausa e atribuição humana podem continuar bloqueando. | Implementação futura: opção aprovada “Esta resposta resolve a consulta e libera o Júnior”, desmarcada por padrão. |
| B03-S | Encerrar sem mensagem parece enviar | Em 12 encerramentos internos recentes: zero `case_reply_turn` e zero outbound de IA nos cinco minutos seguintes. A rota não enfileira resposta para `resolved_internal`. | Não reproduzido na amostra. Preservar silêncio e ampliar regressão de concorrência; a amostra não exclui todo acompanhamento futuro independente. |
| B04 | Áudios claros não são entendidos | Cinco arquivos dos contatos indicados falharam em 06/11 por resolução de credencial, antes da última atualização. No recorte pós-atualização: 26 áudios `ready`; o único sem derivação é mensagem interna do responsável, sem evento de derivação. Não foi julgada a fidelidade semântica desses textos. | Falha histórica confirmada; regressão atual não demonstrada. Recuperação controlada e avaliação de compreensão antes de propor novo transcritor. |
| B05 | Sem resposta ao áudio e sem aviso ao suporte | Áudios históricos falharam e consulta segue pendente. O aviso correspondente ao suporte tem confirmação de entrega e leitura. | Falta de continuidade confirmada. Ausência de notificação não confirmada e contrariada pelo recibo. Distinguir aviso de caso resolvido. |
| B06 | Aceitou experimental, mas cartão não avançou | Atualização falhou com `crm_leads_contact_id_fkey`: o modelo forneceu `contact_id` diferente do vínculo existente. Abriu consulta humana e manteve o cartão em atendimento. | Falha de código confirmada. Preservar identidade na edição operacional da IA; validar ficha, etapa e etiquetas antes da confirmação. |

## Reproduções futuras em ambiente isolado

1. Consulta pendente, resposta pelo Inbox e devolução ao automático; verificar bloqueio da próxima pergunta.
2. Aguardando pagamento com fluxo pós-aula que exige experimental; avançar relógio controlado.
3. Chamada de atualização com identificador de contato incorreto; observar recusa e ausência de avanço.
4. Encerramento interno concorrente com entrega preparada, iniciada ou incerta; medir efeitos.
5. Reprocessar cópia de áudio histórico e comparar texto com conteúdo ouvido, sem disparar resposta real.

## Caminhos confirmados

- `lib/escalacao/retomada.ts`: solta atribuição/pausa, mas não resolve consultas automaticamente.
- `lib/agent-engine/agent/inbound-turn.ts`: verifica espera do responsável antes do modelo e do envio.
- `lib/responsibles/service.ts`: lê a espera durável.
- `app/api/v1/ai/cases/[id]/reply/route.ts`: encerramento interno sem enqueue de resposta.
- `components/inbox/Composer.tsx`, `hooks/inbox/useSendMessage.ts`: envio humano sem resolução explícita de consulta.
- `lib/mcp/tools/leads.ts`, `lib/ai/runtime/tools.ts`: vínculo opcional de contato exposto ao modelo na edição.
- `workers/media-derive-worker.ts`, `lib/messaging/media/reprocess.ts`: derivação e reprocessamento existentes.
- `lib/followup/silence-sweep.ts`, `lib/followup/engine.ts`: condições e cancelamentos governam inscrição/retomada.

## Riscos

Fechar consultas por qualquer mensagem apaga dúvidas pendentes. Liberar IA antes de transporte confirmado permite concorrência. Reprocessar histórico não deve enviar resposta nova. Trocar fluxo não pode renovar orçamento ou revogar cancelamento humano. Não corrigir identidade por semelhança de UUID. Evidência de leitura não equivale a correção aplicada.
