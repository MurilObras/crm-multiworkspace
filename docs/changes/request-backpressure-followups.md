# Contenção de consultas e acompanhamento em lotes

O acesso de sessão usa prazos explícitos para Auth e dados. Os GETs principais
do Inbox compartilham um orçamento de oito segundos entre suas consultas e
cancelam leituras dependentes quando o cliente fecha a requisição. O processo
aceita até 64 desses GETs simultâneos; o excesso recebe 503 sem fila em memória.
Não há cache global de usuário, sessão ou permissão. A validação continua usando
getUser e as leituras continuam com RLS e filtros explícitos de organização.

O orçamento limita as operações de rede reais, incluindo o corpo. Não é um
Promise.race que abandona trabalho em execução. Bibliotecas podem terminar sua
própria reconciliação de sessão antes de devolver a falha; a ocupação continua
sendo contabilizada até o handler terminar. Operações longas de IA/upload não
receberam indiscriminadamente o orçamento curto dos GETs.

O cliente HTTP é o único dono das novas tentativas: até duas em leituras com
HTTP429/503, dentro do prazo total e descartando o corpo anterior. Timeout,
cancelamento, erro de leitura/validação da resposta e escritas sem contrato
auditado não repetem automaticamente. POSTs para messages e automation-rules,
com chave explícita e deduplicação persistida no servidor, podem recuperar a
mesma operação após perder a resposta de rede: no máximo três tentativas, com
o mesmo corpo, chave e orçamento total. A consulta periódica da entrega ao
responsável não sobrepõe leituras e cancela ao desmontar o componente.

## Acompanhamento

fn_silence_contact_page seleciona até 50 contatos por organização/cursor, usando
a conversa aberta mais recente. Exclui inscritos ativos/pausados, números de
responsáveis, consultas humanas pendentes, contatos bloqueados e gate allowlist
sem autorização. A RPC não transfere conversas nem metadata ao processo web.

fn_enroll_silence_batch mantém fn_enroll_silence_episode como fonte da decisão
atômica final. Uma resposta pode permitir continuação do episódio anterior;
conversão, encerramento ou pausa humana não recebem um novo orçamento. As duas
RPCs novas só podem ser executadas por service_role. Migration0244, baseline e
manifesto precisam ser distribuídos juntos pelo fluxo normal de atualização.

Cursor confirmado mantém progresso quando acaba o prazo, sem mudar a ordem dos
fluxos retornados pela base (contatos podem pertencer a mais de um segmento).
Esse estado em memória é limitado a256 entradas e contém apenas identificadores;
reinício pode repetir seleção, mas a RPC não repete a inscrição/retomada.
Cron e relógio da interface compartilham um guard por processo. Entre réplicas,
claims e episódios continuam protegidos pelo banco; o guard local não é um
lock distribuído. A rodada usa45s de orçamento de dados e seu disparador espera55s.
O guard só libera após a conclusão real da rodada, mesmo em erro.

## Disposição da fila

withJobExecution registra transições efetivadas pelo próprio job/owner/pool.
completeJob registra após COMMIT; cancelJob/rescheduleJob só registram quando
o CAS autônomo encontra a linha. Uma mudança dentro de cliente transacional
não fornece esse recibo ao executor. Isso evita concluir novamente um job já
reagendado e mantém visível perda de lease real ou erro sem transição confirmada.

## Observação e validação

read_request_finished e read_capacity_exceeded são consumidos pelo logger
estruturado. Registram rota canônica, duração, leituras em voo e memória, sem
URL, query, conteúdo de cliente ou credencial. São o laço de retorno para comparar
incidentes posteriores. O healthcheck TCP e o heap não foram ampliados.

Validar em ambiente isolado: dependência lenta, cancelamento, excesso de leituras,
ausência de retry de escritas não auditadas, recuperação deduplicada da resposta
nas duas rotas auditadas, paginação, pausas humanas, continuação sem zerar etapas,
permissões das RPCs, rollback e perda verdadeira do lease. Não executar
esses cenários contra leads ou bancos de produção.

A correção contém trabalho e remove desperdício comprovado. Ela não atribui,
sem perfil de memória, o esgotamento do heap a uma função específica nem comprova
a causa interna de incidentes no provedor de dados.


## Ferramentas de apoio desta correção

Graphify (Graphify-Labs/graphify, revisão 16218bf) foi usado obrigatoriamente para
extrair o grafo local, sem LLM, e conferir consumidores de serviceFetch,
runSilenceSweep e withJobExecution. O mapeamento identificou o relógio da
interface como segundo consumidor da varredura; ambos receberam o mesmo guard.
O grafo é apoio à investigação, não prova de execução ou substituto dos testes.

Plandex (plandex-ai/plandex, CLI/servidor 2.2.1) foi usado obrigatoriamente em
projeto local separado, com aplicação e execução automática desabilitadas.
A análise do plano e a revisão de código foram concluídas. A revisão complementar
de 06/11 conferiu a recuperação idempotente e o isolamento/restauração das fixtures
E2E. Inspeção direta e regressões executáveis completam a verificação; respostas
ausentes ou timeouts não contam como aprovação. Nenhum desses repositórios virou
dependência do CRM em produção.
