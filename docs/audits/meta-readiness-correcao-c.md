# Correção C — retries, vínculo explícito e guardas

## F3: uma intenção de envio, uma identidade durável

O inline usa `sendInlineTurnMessage`, acesso Supabase à tabela `send_ledger` já
usada pelo agent-engine. A chave continua sendo `(job_id, seq)` e a única bolha
inline usa `seq=1`; `send_ledger.id` continua em `messages.metadata.idempotency_key`.
Não há tabela, migration ou fila nova.

Antes de preparar ou enviar, procura tentativa existente. Se houver, lê a
mensagem por chave, organização, contato e direção e reconcilia o ledger.
`sent`/`delivered`/`read` confirmam; `queued`/`sending` aguardam; `failed` não
avança. Não rotaciona chave nem reenvia tentativa já existente.

Na primeira tentativa, prepara o envio e reserva o ledger pelo índice único.
Um concorrente que perca a reserva só reconcilia. O hook `beforeSend` vincula a
mensagem antes da rede. O hook `beforeTransport` marca `sending` imediatamente
antes do transporte, impedindo que falha na gravação de `sent` deixe uma mensagem
possivelmente entregue na fila `queued` do watchdog. Se a gravação do desfecho/step/job falhar depois do
transporte, o retry encontra a mensagem existente e não repete o envio.

Uma reserva sem mensagem correlacionável é mantida não confirmada, sem reenvio
automático no escuro. Não se tenta reconstruir identidade de envios históricos
por texto ou proximidade de timestamps. O recheck/dead do fluxo permanece o
mecanismo existente para tentativas que não se resolvem.

Falha ao completar o nó agora mantém o job retentável, em vez de marcar `done`
com a conclusão perdida. Tentativas falhas do sink ficam terminais no job inline.

## F6: a conversa do enrollment vem primeiro

Agent-engine lê o enrollment por organização, contato e ID, antes de selecionar
destino. Se há `conversation_id`, restringe a leitura a essa conversa, com os
mesmos filtros de tenant/contato e validação da sessão. Ausência do vínculo
referenciado bloqueia, sem fallback.

O resolver Supabase aceita `conversationId` e aplica a mesma prioridade no inline.
Outras conversas do contato não tornam esse vínculo ambíguo. Só quando o campo é
nulo continua a seleção automática centralizada do Bloco 3.

## F7: erro de leitura não autoriza campanha

Consulta de resposta (`stopped_reply`) e consultas de contato verificam `error`.
Contato ausente, ID/organização inesperados ou estado de bloqueio não confirmado
impedem transporte. O hook imediatamente anterior à rede repete também as guardas
de contato, anonimização, fusão e telefone, além de opt-out.

Reservas, dedupe, quotas e retries continuam nos RPCs existentes. Falha de guarda
finaliza como falha conservadora; não libera uma reserva para reenvio incerto.

## Testes

- `followup-inline-ledger`: inline + ledger reais, sink dublado com persistência;
  queued/retry, concorrência, falha após transporte/ledger/done, tenant e vínculo.
- `followup-official-runtime`: vínculo explícito no PostgreSQL, contato/tenant
  incorretos bloqueados e fallback automático quando não há vínculo.
- `tests/campaigns/worker`: falha inicial e final de consulta, contato ausente ou
  inesperado e ausência de transporte, incluindo replay.
