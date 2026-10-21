# Follow-up e comando humano

Correção dos achados da auditoria de 21/10/2026. Sem dependência da integração de assinatura e sem IDs de organizações no código.

## Contrato

- `cancel_on_reply=true` encerra inscrições vivas inclusive `active` em espera e pausas. `tr_cancel_followup_on_reply` cancela na persistência do inbound; `reactivity.ts` cobre replay/contatos irmãos. `false` mantém fluxos que consomem respostas.
- `fn_followup_job_live` exige organização, contato, inscrição executável, nó atual e ocupação de envio. `node_epoch` muda ao trocar de nó, distinguindo uma volta à mesma etapa de um recheck. A barreira roda antes do modelo e antes da rede. O CAS final bloqueia a linha da inscrição e revalida comando humano.
- Pausa aguarda liberação sem consumir tentativas. Cancelamento, falha terminal e nó obsoleto encerram somente tentativas `prepared`, sob lease e CAS. Envios confirmados ou incertos são preservados.
- `fn_followup_complete_step` registra evento e avanço juntos. Uma intervenção após a leitura impede o avanço. Se o transporte já confirmou, registra `action_sent` sem mudar a pausa; o motor reconhece a prova ao retomar e não envia de novo.
- `fn_claim_due_followup_enrollments` mantém rodízio por organização e não consome rechecks durante comando humano. Jobs anteriores à retomada respeitam a grace registrada no evento; rechecks posteriores não prolongam essa grace.
- A barreira de um job preparado obedece à última remarcação humana. Antecipar a data ou deixar vencer o novo prazo não mantém um prazo anterior, mais distante. O job reavalia a espera em até um minuto, sem consumir tentativas nem chamar o modelo; não dorme por dias sobre o prazo antigo. Uma conclusão já em voo também conserva o prazo humano para o próximo passo.
- Pausa manual pelo canal dura 60 minutos e só estende o prazo vigente por UPDATE condicional. `infinity` e metadados de um handoff concorrente vencem. A tela mostra o prazo previsto.
- WAHA usa ID canônico de transporte. Um eco exato é arquivado em `messages.metadata.reconciled_into_message_id`, com a referência original preservada. Texto/horário semelhantes não autorizam apagar mensagem humana. Um envio incerto continua exigindo confirmação, sem inferência por proximidade.
- Resposta interrompe o fluxo; o sweep retoma a MESMA inscrição cancelada por resposta após `threshold_minutes` desde a última inbound. A âncora usa o maior horário entre conversa e mensagens persistidas, sem depender de carimbo atrasado da conversa. Conserva versão, etapa, eventos, tentativas e orçamento de passos. O vencimento é o MAIOR entre o novo silêncio e o prazo anterior salvo no evento; etapas posteriores continuam com seus próprios intervalos. Não repete a primeira mensagem a cada duas horas.
- O saneamento reaplicado pelo baseline considera a âncora do silêncio via `to_jsonb(e)`, inclusive antes da criação da coluna em instalação fresca; uma próxima atualização não cancela novamente a inscrição retomada. O teste de banco reaplica o baseline completo com uma inscrição ativa.
- A ação retomada revalida a janela da última espera visitada, usando o mesmo `nextInSendWindow` do motor. A barreira antes do modelo/transporte reage também a worker atrasado ou canal offline; fora da janela fica aguardando, sem descartar a intenção.
- `silence_anchor_at` separa mensagens do trecho anterior; a retomada muda `node_epoch` mesmo sem mudar de nó. Jobs, callbacks e replays antigos não recuperam permissão. O dossiê traduz `silence_resumed` e mostra a continuação na mesma etapa.
- Sequência concluída/esgotada, cancelamento humano, pausa manual/handoff, conversão, opt-out, fluxo desativado e segmento removido não são rearmados automaticamente. Transporte incerto e jobs em execução seguram a retomada. Uma confirmação tardia conserva a prova sem desfazer o cancelamento. Inscrição manual continua explícita para uma nova campanha.

## Evidência e laço de retorno

`tests/unit/followup-human-control-state.test.ts` executa as migrations reais em PostgreSQL embarcado e os adapters de produção. As suítes de banco exercitam baseline install/update, RLS e concorrência em Postgres 15; o E2E verifica a operação pelo frontend.

Os tipos da inscrição e das quatro RPCs privadas foram copiados da saída oficial de `supabase@2.54.11 gen types` (`postgres-meta:v0.93.1`), conectada a uma cópia isolada do baseline completo. Os cinco blocos foram comparados byte a byte com a saída gerada; os demais tipos históricos foram preservados.

O gate de entrega exige revisão antes dos testes e outra revisão depois dos testes/CI/E2E, antes do merge. Achado novo volta para correção, revisão e repetição dos testes afetados; não se libera merge com uma falha conhecida.

Entrada: webhook/message.received e cron followup-flow-worker. Saída: `outbound-attempt.ts` e o sink `/api/v1/messages`. Retorno: ACK/status de messages e send_ledger, callback de conclusão e eventos de pausa/retomada. O dossiê em `/app/ai/followups/enrollments/[id]` explica cancelamento/retomada; a Central continua recebendo falhas terminais. Veto anterior à rede encerra só a intenção segura, pausa conserva o retry, falha de leitura não autoriza envio.
