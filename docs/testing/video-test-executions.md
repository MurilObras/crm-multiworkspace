# Vídeo, ensaio e identificação das execuções

Escopo: nova branch a partir de origin/main 2dce9a7f. Sem merge, publicação,
alteração de produção ou trabalho no PR 20. Nenhuma configuração de workspace é alterada.

## Decisões

- Vídeo espera até 90s; áudio e outras mídias continuam com 30s. Não há retry automático de transporte incerto.
- Retorno sem o ID da tentativa não é uma confirmação automática. Para reparar
  um caso antigo, um gerente compara o vídeo recebido no WhatsApp e seleciona a
  cópia confirmada no histórico da mesma conversa, contato, sessão e workspace.
- A confirmação exige job terminal sem lease. Mensagem e ledger mudam na mesma
  transação; rejeição, fila, outro canal/contato/workspace ou vídeo apagado não
  podem ser convertidos em entrega. O eco é preservado para auditoria, vinculado
  ao original e omitido do histórico de atendimento. A atribuição humana não muda.
- Custo desconhecido permanece NULL. A migration 0233 e o baseline removem NOT
  NULL/default de custo de ai_agent_runs, sem inventar tarifa ou custo zero.
- Tela de teste mantém erro visível e usa uma tentativa HTTP com espera de 120s.
- Execuções combinam produção de llm_calls e testes completos de ai_agent_runs;
  uma chamada agent_test bem-sucedida não mascara a falha do ensaio.

## Critério de liberação para testes

Revisão estática dos três fluxos, incluindo isolamento por organização, locks,
rollback, replay, paginação, erro visível, migration/baseline e cobertura de regressão.
Qualquer falha acionável reabre correção e revisão. Testes só começam depois de
uma rodada sem falhas acionáveis; aprovação de revisão não significa testes aprovados.

## Loop de revisão

1. Corrigidos: custo desconhecido persistido como zero pelo default, erro de
   gravação sem motivo salvo, e erro da tela exibido apenas como aviso temporário.
2. Corrigidos: estado terminal real da fila é failed (não cancelled); job com
   lease nunca pode ser conciliado. Cursor agora valida UUID/data antes de montar
   filtros. Nova conversa limpa também o erro anterior. Dois tipos de execução
   usam paginação conjunta e não duplicam a chamada interna do ensaio.
3. Revisão final estática concluída sem nova falha acionável. Tipos de custo
   regenerados da nulabilidade no schema descartável; nenhuma execução de teste
   foi usada para antecipar a aprovação do loop. Liberada a fase de testes.
4. Primeira bateria: 77/78 testes isolados passaram. Corrigido o botão de nova
   conversa, que ainda bloqueava a limpeza do erro sem histórico. Checagem de
   tipos detectou a ação de auditoria ausente do registro canônico; adicionada.
   Revisão dos dois ajustes concluída antes de repetir os testes.
5. CI detectou rotina específica de canal fora de lib/channels. Movida para a
   camada canônica, sem alterar o protocolo. Imports e isolamento revisados
   antes de repetir checagens locais e CI.
6. Invariantes completos: 1370 casos passaram e oito falharam no mesmo duplo de
   PostgREST, que não implementava o novo filtro IS NULL. O duplo agora traduz o
   filtro para SQL real e ganhou uma prova de paginação excluindo o eco conciliado.
   Nenhuma restrição de teste foi removida.
7. Revisão da janela do próprio envio: transporte de vídeo agora dura mais que
   a janela antiga de reconhecimento. Janela alinhada ao timeout somente para
   vídeo em sending; fila parada mantém 60s. A data usada é a última atualização
   do transporte, cobrindo retomadas antigas. Formatos diferentes não se protegem.
   Revisão concluída antes de testar controles de 65s, 95s, fila e intervenção humana.
8. Primeiro E2E: parte 1 aprovada; parte 2 teve 144 casos aprovados e parou nos
   dados da nova fixture (contacts.name, não full_name). Dois cenários da mesma
   sequência não executaram por causa dessa preparação. Fixture corrigida e
   inserts tipados pelo schema gerado para conferir todos os campos antes de
   repetir a sequência completa; nenhum cenário foi dispensado.
9. Controle complementar: fila antiga com atualização recente não é transporte.
   Mantida a janela por criação para queued; somente sending usa a atualização
   recente. Nova bateria de eco/transporte aprovada com 55/55. Revisão e tipos
   da fixture concluídos antes da nova rodada completa de E2E.
10. Segunda rodada completa: vídeo e identificação das execuções aprovados.
    O teste do erro visível encontrou também os alertas globais da página; o
    erro esperado estava presente. Seletor restrito ao tabpanel Teste, sem
    relaxar a asserção. Revisão concluída antes de repetir o E2E completo.
11. Revisão final adicional: a cópia conciliada ainda participava da seleção
    da última mídia, bloqueando pedidos como “reenvie aquele vídeo”. Excluída
    desse histórico, preservando o original confirmado e a proteção contra
    repetição sem pedido. Regressão cobre pedido nomeado e referência ao último vídeo.
12. A ordenação conjunta de execuções truncava timestamps para milissegundos,
    podendo inverter duas fontes e pular uma linha na paginação. Reutilizado o
    comparador que preserva a precisão do Postgres; regressão verifica duas
    páginas com timestamps no mesmo milissegundo. Segunda revisão estática
    concluída sem novo achado acionável antes de repetir as checagens.
13. Conferência dos demais leitores de histórico: o eco conciliado também
    podia encerrar o trecho pendente de perguntas pelo horário de chegada do
    webhook, descartando uma pergunta do mesmo segundo. Excluído dos limites
    de assunto/primeiro contato; regressão conserva as duas perguntas reais.
    Revisão estática dos leitores concluída antes de repetir os testes.
14. Nova rodada: eventos de edição/apagamento buscavam somente ID curto, mas
    a confirmação conserva o ID completo do eco. Alinhados aos dois formatos
    e restritos à sessão autenticada, além do workspace. Regressão executa a
    confirmação seguida dos dois eventos contra PostgreSQL, incluindo cópias
    de controle em outra organização e conexão. Revisão concluída antes dos testes.

## Cobertura de validação

- API/UI: custo NULL, erro persistente, tentativa única e identificação de testes.
- PostgreSQL isolado: reconciliação atômica, replay, rollback e isolamento entre
  workspaces/conversas/sessões/contatos; migration idempotente.
- Transporte local simulado: vídeo conclui além do teto de outras mídias.
- E2E com Supabase local, canal parado e vídeo gerado: confirmação pelas telas,
  histórico após recarregar, identificação de teste com chamada OK mas ensaio
  falho e apresentação de erro na tela. Nenhum envio real ao WhatsApp.

## Resultados locais

- Bateria isolada: 78/78 após correção; nova prova de reenvio acrescentada e
  suíte PostgreSQL repetida com 16/16. São 79 casos únicos aprovados nesta etapa.
- Typecheck completo aprovado após os últimos ajustes.
- Lint dos arquivos alterados aprovado; o único aviso de importação foi corrigido
  e os arquivos afetados foram conferidos novamente, sem avisos.
- E2E e invariantes completos rodam no ambiente descartável do GitHub Actions.
  Resultado válido é o do HEAD atual: `gh pr checks 30`. Links, contagens e
  exceções preexistentes estão na descrição do PR; um commit novo exige nova rodada.
- Após as correções de CI: confirmação/isolamento repetidos (20/20); transporte,
  eco e atendimento humano repetidos (54/54). Lint de canais e de papéis aprovados.
- A tentativa exploratória de suíte completa no Windows foi interrompida após
  sondas dependentes de utilitários Linux falharem. Não foi usada como aprovação;
  a suíte completa obrigatória roda no runner Linux isolado do CI.

## Living System Checklist

Entrada: botão de confirmação no Inbox e Teste do agente. Saída: mensagens e
send_ledger conciliados, resultado do ensaio e listagem paginada. Erro/retorno:
409 conserva incerteza; falha de teste ganha motivo salvo e erro visível. Auditoria:
message.delivery_confirmed e triggers existentes. Porta: Inbox existente, restrita
a gerente; abas Teste/Execuções existentes. Sem novo worker, cron ou automação.
