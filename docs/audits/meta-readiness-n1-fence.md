# N1 — fence das escritas tardias no sink

O `transportStarted` local não é prova do estado compartilhado: A pode estar no
pré-voo enquanto B, após expiração do lease de A, já entrou no transporte.

O executor fornece `writeAttemptState` ao sink. Todas as escritas de estado da
tentativa gerenciada — resultado, erro, veto e requeue — usam esse caminho, que:

- toma lock no job e verifica organização, contato, status running e locked_by;
- filtra a mensagem pela organização, contato e chave do ledger;
- compara a fase persistida com a fase esperada no mesmo UPDATE;
- não sobrescreve um estado confirmado com identificador externo;
- mescla apenas os campos de fase/retry e queued_reason ao metadata atual, sem
  restaurar o snapshot antigo de metadata do executor.

Owner ou fase divergente causa `OutboundLeaseLostError`, sem escrita. A transição
para incerto na reconciliação também usa esse fence. A política de retry não foi
alterada: started continua incerto quando a confirmação se perde; só o owner
válido pode registrar uma prova de rejeição/ausência de transporte.

O teste de corrida mantém A aguardando o pré-voo, expira seu lease, deixa B entrar
na rede, libera a falha tardia de A e então expira B para C reconciliar. Verifica:
message e ledger intactos após A, uma única chamada de transporte, C encerrando a
tentativa como incerta e ausência de escrita até pelo sucesso tardio de B.

Os controles adicionais isolam as duas proteções: owner antigo com fase ainda
prepared, e owner igual com fase já alterada para started. Os casos de erro e
requeue usam o sink real e PostgreSQL embarcado; o transporte é sintético.
