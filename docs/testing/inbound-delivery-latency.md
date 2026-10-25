# Esperas no caminho de envio

## Diagnóstico de 25/10/2026

Autorização de mídia não prova transporte. Na reprodução anterior à correção,
o texto de contexto foi aprovado às 21:12:06 UTC; o canal recebeu o POST às
21:15:09 e respondeu em 236 ms. O ledger só registrou aceite às 21:17:01. O POST
do vídeo terminou às 21:18:08 e levou 33,3 s. O arquivo chegou ao WhatsApp.
O transporte do arquivo não explica os minutos antes dele.

Nesse intervalo, o app registrou treze falhas de autenticação HTTP 504 no
Supabase; um turno terminou com `canceling statement due to statement timeout`.
O código fazia leituras/escritas REST sem prazo explícito, em série, durante a
exclusão do canal em `runBeforeSend`. O SDK também habilitava retries de GET.
Isso amplifica uma degradação do serviço e retém os outros envios do canal.

**Limite da evidência:** não havia duração por request/etapa. Não é possível
atribuir cada minuto a um endpoint ou provar a causa interna dos 504 do serviço
hospedado. `agent_turn` inclui tools; não mede só inferência. Não foi demonstrada
falta de índice, throttle de minutos ou defeito no transporte do arquivo. Uma
nova reprodução diagnóstica só com texto terminou em aproximadamente 81 s,
incluindo roteamento/manutenção de memória, sem reproduzir os minutos de atraso.
O observador read-only não encontrou espera longa no banco nessa nova amostra.

## Correção e limites

- REST do serviço: 20 s incluindo body; sem retry HTTP automático. Fila e ledger
  continuam governando a retomada e a identidade de mensagem.
- Assinatura de URL: 20 s. Cópia de mídia no worker: até 60 s por request.
- A tentativa compartilha orçamento HTTP pré-transporte de 60 s. O transporte
  usa o prazo do adapter. Pós-envio: outros 20 s. Não é timeout global de turno,
  não limita inferência e não substitui os fences SQL.
- O sinal cancela o fetch real, inclusive body; não usa Promise.race para liberar
  a fila deixando efeitos ativos. Timeout não prova rollback no servidor.
- Upload manual não recebe o teto curto da consulta/assinatura.
- `outbound_attempt_timing` discrimina fases, resultado, job e sequência. Logs HTTP
  registram categoria e tempo até headers. Nada de URL, filtros, telefone, corpo
  ou credenciais. Erro lendo body aparece na fase da tentativa.
- Nenhuma guarda de opt-out, humano, recência, aprovação ou tenant foi removida.
  ACK confirmado prevalece; incerteza não autoriza repetição automática.

## Validação

Planejada, antes da execução: receiver HTTP real com headers/body travados,
503 sem retry oculto, orçamento acumulado e isolamento de escopos; sucesso de
escrita e upload manual preservado (`service-fetch.test.ts`). Timeout pré-rede
retoma a mesma mensagem uma vez; timeout após confirmação não duplica
(`followup-inline-ledger.test.ts`). Os testes existentes cobrem ACK, lease,
humano, mídias e isolamento.

Checagens locais, suíte unitária, baseline install/update/invariantes em pg15 e
E2E de Inbox, catálogo e diagnóstico em Supabase descartável. Resultados serão
acrescentados após execução. Nenhuma suíte usa dados ou clientes reais.

## Living System Checklist

1. Entrada: `sendTurnMessage`, `crmEdgeConfigFromEnv` e admin client canônico.
2. Saída: handler de mensagens, Supabase e adapter do canal.
3. Registro: `outbound_attempt_timing`, `service_request_failed`, ledger existente.
4. Tela: mensagem/erro no Inbox e execuções existentes. Tempos técnicos ficam no
   log operacional; esta correção não cria uma tela de telemetria.
5. Porta: Inbox e configurações/teste/execuções do agente, rotas existentes.
6. Anti-morte: pré-rede conserva identidade e fila; incerteza fica visível sem retry.
7. Configuração: limites internos sem novos segredos ou knobs de instalação.
   Nenhuma regra comercial ou workspace específico é alterado.
8. Continuidade: pausas humana/responsável e follow-ups conservam seus fences.
9. Retorno: fases separam espera do serviço, arquivo e reconciliação; recuperação
   existente informa o operador, sem mascarar falha como entrega.
10. Mapa: `user-journey-map.md`; entradas/saídas estão nomeadas acima.
