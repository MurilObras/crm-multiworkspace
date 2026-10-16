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

## Validação preparada, ainda não executada

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
- E2E e invariantes completos aguardam o ambiente descartável do GitHub Actions.

## Living System Checklist

Entrada: botão de confirmação no Inbox e Teste do agente. Saída: mensagens e
send_ledger conciliados, resultado do ensaio e listagem paginada. Erro/retorno:
409 conserva incerteza; falha de teste ganha motivo salvo e erro visível. Auditoria:
message.delivery_confirmed e triggers existentes. Porta: Inbox existente, restrita
a gerente; abas Teste/Execuções existentes. Sem novo worker, cron ou automação.
