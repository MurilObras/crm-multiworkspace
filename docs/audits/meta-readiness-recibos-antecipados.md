# Correção B — recibos Meta antecipados

## Causa confirmada

`sendMessageHandler` insere a mensagem em `queued` sem `external_id`, chama o
transporte e só depois grava `sent` + `external_id`. O webhook pode chegar nesse
intervalo. Um UPDATE que afeta zero linhas não distinguia ausência de correlação
de duplicata já aplicada; ambos eram confirmados com HTTP 200.

## Infraestrutura e estratégia

A rota Meta aplica os recibos diretamente. `webhook_events_log` é utilizado por
outros endpoints para registro/dedupe; seu INSERT não agenda retry por si só.
`event_log` possui consumo por chave (`consumed_by`) e retry pelo drain, mas
adotá-lo aqui exigiria novo produtor/consumidor para recibos.

A solução mínima utiliza a reentrega HTTP do próprio provedor:

1. Conferir existência da mensagem por organização, sessão, ID externo e direção.
2. Se ainda não existir no escopo, retornar `pending_correlation`.
3. Processar os demais eventos do lote e responder 503 se qualquer recibo estiver
   pendente. Não confirmar definitivamente esse lote com 2xx.
4. Na reentrega, se `external_id` já estiver disponível, aplicar os updates
   condicionais existentes. Duplicata ou evento atrasado de mensagem conhecida
   pode concluir sem regravar nem regredir status.

Falha de consulta retorna 500, também retentável. Status desconhecidos e WABAs
fora do escopo mantêm seu tratamento explícito de evento ignorado.

Não há fila, polling, tabela ou migration nova. A retenção e cadência de retry
são as do webhook da Meta; não há armazenamento local adicional nem promessa de
retry indefinido. Um ID que nunca apareça permanece não confirmado durante as
reentregas do provedor, sem criar mensagens ou procurar em outro tenant/sessão.

## Concorrência e testes

Se a gravação do `external_id` preceder a leitura, o recibo aplica imediatamente.
Se ocorrer depois, o 503 conservador solicita uma nova tentativa. Status continua
protegido pelos predicados no UPDATE, incluindo `read` diante de `delivered` ou
`failed` atrasado.

`tests/unit/meta-webhook-status.test.ts` cobre os dois interleavings, recibos
antecipados sent/delivered/read/failed, duplicatas, lotes mistos, ausência contínua
e isolamento por organização/sessão/direção.
