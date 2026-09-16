# Correção D — um protocolo de crash/retry

## Causa raiz

Compartilhar a tabela não bastava: inline e worker decidiam de forma diferente
para os mesmos estados. Além disso, o claim inline não participava do lease que
o reaper recupera, e o watchdog podia reenviar mensagens que pertenciam ao ledger.

## Protocolo

`sendTurnMessage` e o adaptador inline chamam **executeOutboundAttempt**.
`decideOutboundRecovery` é a política única. A tentativa usa a mesma key
`(job_id, seq)` e, para mensagens novas, `messages.id = send_ledger.id`.

| Estado persistido | Decisão |
|---|---|
| requested sem message | Retomar preparação com a mesma key sob lease válido |
| queued/failed com fase prepared | Retry pré-rede seguro, na mesma message |
| rejeição comprovada e retentável | Retry da mesma identidade, sob orçamento da fila |
| rejeição permanente | Encerrar job, sem reenvio |
| sending/started ou uncertain | Encerrar como `outbound_delivery_uncertain`, sem reenvio |
| sent/delivered/read com external_id | Confirmar; replay não chama transporte |
| estado desconhecido ou legado sem prova | Incerto; nunca inferir sucesso ou retry seguro |

As fases vivem em `messages.metadata.outbound_attempt`, com o snapshot do input.
Não há tabela, coluna, enum ou migration nova. A prova de rejeição é tipada
(`DeliveryRejectedError`), não inferida de timeout. O adapter oficial preserva
essa prova para rejeições explícitas e erros locais anteriores à requisição.

## Limite inevitável

O CAS `prepared → started` é gravado antes da chamada HTTP. Um crash entre esse
marcador e a chamada é indistinguível de um crash depois do aceite sem resposta.
Por segurança, ambos são incertos. Não se promete exactly-once remoto: garante-se
que os consumidores não reenviam automaticamente uma chamada possivelmente aceita.

## Lease e concorrência

- Inline usa `claimJobs`, incluindo cap global, lane, locked_by, locked_at e attempts.
- Claim do worker recebe token de execução único, mesmo ao retomar no mesmo processo.
- Os CTEs de preparação/entrada na rede validam owner sob lock da linha do job.
  O reaper não consegue trocar o owner no meio dessas escritas.
- O CAS da message e sua PK impedem dois transportes concorrentes para a mesma fase.
- Inline usa `completeJob` com a progressão do enrollment na mesma transação.
  O agent-engine protege a progressão intermediária com `withJobLease`.
- Owner vencido não finaliza/requeueia o novo lease; rollback descarta seus efeitos.
- O watchdog não disputa mensagens marcadas com identidade/estado do ledger.
- O cron de sending continua encerrando mensagens vencidas; ele preserva metadata.
  `failed` após started continua incerto e não libera rotação de key.

## Dependência operacional

As escritas críticas do inline passaram de REST isolado para o pool PostgreSQL já
usado pelo worker (`getRequestPool` / `SUPABASE_DB_URL`). Isso permite os locks e a
conclusão atômica sem inventar RPCs/fila/tabelas novas. Sem a conexão PostgreSQL,
esse caminho falha fechado. O fragmento de release declara a ação necessária para
instalações que ainda não tinham essa configuração.

## Evidência

`followup-inline-ledger.test.ts` agora roda os SQLs reais em PostgreSQL embarcado
(PGlite, dependência somente de desenvolvimento), com snapshots persistidos:
lease expirado, reserva sem mensagem, queued, sending/requested, rejeição explícita,
timeout, cron stuck, troca inline↔worker, concorrência e owner inválido.
Também prova rollback de progressão quando a conclusão do job falha após envio.

O motor embarcado usa uma conexão serializada; esses testes não são um benchmark
de múltiplos servidores nem substituem a bateria completa de RLS/baseline em Docker.
Verificam o protocolo e as transações reais, em vez de simular crash só por exceptions.
