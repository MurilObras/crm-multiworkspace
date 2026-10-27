# Respostas pendentes e avisos do Inbox

A resposta fixa vive no snapshot privado response_delivery do job. O registro de envio continua sendo a autoridade de transporte por job/seq. Nova mensagem, pausa humana e aprovação revogada continuam vetando antes da rede.

A chave response_key identifica uma resposta lógica, não uma entidade nova: a origem permanece o job com FK. A auditoria guarda conversa e chave; cada mensagem física recebe a chave e a quantidade esperada. A RPC scoped distingue pendente, parcial, incerto e histórico; resolução exige as partes confirmadas, sem inferir por contato ou horário.

O snapshot guarda texto privado e próximas chamadas de envio do mesmo lote para evitar regeneração. As partes aprovadas não são reagrupadas se o limite mudar. O marcador de fechamento remove esse conteúdo quando termina o atendimento. A migration 0242 remove-o quando o contato é anonimizado ou excluído. Nenhum corpo, token ou URL assinada entra no log. Registros antigos sem chave permanecem históricos, sem reconstituição fictícia.

Uma parte queued interrompe a sequência: as próximas permanecem no plano aprovado para retomada, mesmo se o canal voltar antes do intervalo entre partes. Somente confirmação de envio permite avançar.

A sequência reservada de uma mídia obrigatória não indica a ordem de entrega: o texto pode estar confirmado em seq >= 3 antes da mídia reservada em seq 2. A retomada conta todos os envios confirmados fora do grupo atual, preservando contexto e limite físico. Mídia já confirmada não recebe outra tentativa do plano. A espera mínima no contexto automático é reagendada sem falhar. O snapshot distingue explicitamente prelúdio de resposta; antes de iniciar o modelo, um marcador durável impede repetir a conversa após interrupção. Snapshots antigos sem fase assumem resposta e não autorizam regeneração por inferência.

Tempo mínimo é uma configuração do agente, editável junto ao Estilo de resposta, desligada por padrão. Processamento conta no piso; aguardar devolve o job à fila depois que modelo/tools cessam. O número inteiro não fica sob lock durante essa espera.

Living System Checklist:
1. Entrada: inbound/job e confirmação do transporte.
2. Saída: mesma conversa, memória e aviso atualizado.
3. Registro: before_send_traces, send_ledger, messages e llm_calls.
4. Tela: Inbox/RetentionNotice e Execuções.
5. Porta: Inbox e configuração do agente, já na navegação.
6. Anti-morte: retomada fixa; tentativas limitadas e Central para job morto.
7. Configuração: Tempo mínimo de resposta, salvar e reler; ausente desliga.
8. Continuidade: pausas humanas e pedidos pendentes revalidados antes do envio.
9. Retorno: confirmação resolve a ocorrência relacionada; falha mantém o estado explícito.
10. Mapa: outbound-delivery-finalization.architecture.json.

Validação: revisão estática antes de executar testes; checagens locais, banco descartável e E2E; revisão posterior; CI no mesmo commit. Não há autorização de merge ou deploy. PR 20 fora do escopo.
