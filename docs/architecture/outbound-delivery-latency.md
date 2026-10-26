# Esperas e recuperação da entrega

```mermaid
flowchart TD
  turn[inbound-turn: modelo e tools] --> gates[runBeforeSend: exclusão por canal e guardas]
  gates --> attempt[executeOutboundAttempt: ledger, lease e CAS]
  attempt --> handler[sendMessageHandler]
  handler --> channel[Adapter: transporte com prazo próprio]
  edge[crmEdgeConfigFromEnv] --> fetch[serviceFetch]
  admin[createAdminClient] --> fetch
  attempt --> budget[AsyncLocalStorage: orçamento desta tentativa]
  budget --> fetch
  edge --> handler
  handler --> fetch
  handler --> admin
  fetch --> supabase[Supabase REST e Storage]
  attempt --> timings[outbound_attempt_timing por job e sequência]
  attempt --> delivery[Mensagem e ledger: confirmação ou incerteza]
  delivery --> inbox[Inbox e execuções existentes]
  turn --> stop[deliveryFailed: impedir próximos steps e tools do lote]
  stop --> drain[execution.drain antes de devolver o controle]
  attempt --> stop
  drain -->|retomada segura| queue[Fila: recuperar mesma identidade se seguro]
  queue --> attempt
```

`serviceFetch` está nos dois clients de serviço, nunca no client autenticado do
browser. `withServiceRequestBudget` cria um escopo por tentativa. Instâncias dos
clients podem ser compartilhadas, mas o relógio não passa para outra tentativa,
cliente ou organização. O transporte inicia uma fase independente. No pós-envio,
cada request conserva seu prazo, sem herdar o tempo gasto pela etapa anterior.

O sinal do fetch limita espera por headers e body. Ele **não prova rollback de
uma escrita no servidor**. Por isso não substitui a identidade persistida, o lease,
o CAS nem a reconciliação por ACK. Não há Promise.race liberando ferramentas ainda
ativas. Recusa de mídia/guardrail corrigível não é tratada como falha fatal de
transporte; o modelo pode continuar por texto quando permitido.

O estado de entrega continua visível nas telas atuais; duração por fase é log
operacional. Não foi adicionada configuração comercial, regra de workspace ou
tela de telemetria. Os limites HTTP não são uma promessa de tempo total: inferência,
fila, consultas SQL e transporte também compõem a latência.

Diagnóstico, prazos, evidências e checklist:
[Esperas no caminho de envio](../testing/inbound-delivery-latency.md).
