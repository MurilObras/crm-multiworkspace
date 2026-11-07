# Validação de lembretes e próxima ação — 07/11/2026

Branch: `fix/experimental-reminder-memory`. Base: `b72bf62eed099380dd2cfc74e8770cf65e584dcc` (produção 3.10.0). Implementação inicial: `4044edaa`. Sem migration, merge, deploy ou alteração do PR 20.

## Correções

1. Uma espera adaptativa retomada após nova mensagem não pode avançar usando o plano anterior à resposta. O motor pede outro plano do grafo, mantém o nó/etapas já percorridas e só arma o prazo atual quando a ponte confirma a decisão. Callback duplicado não renova o prazo. Pausa, cancelamento, epoch e CAS continuam prevalecendo. Se o planejamento não terminar, o fluxo abre pendência em vez de enviar com plano antigo. Esperas fixas preservam a regra anterior.
2. O fechamento do turno espelha a próxima ação confirmada no checkpoint em `lead_state`, na mesma transação protegida pelo lease. Preserva estágio e qualificação. O CAS usa a versão lida na abertura: mudança posterior de ferramenta/pessoa vence. Marcador legado sem versão não inventa autorização; contato anonimizado não é reidratado. BIGINT recebido como texto é preservado sem arredondamento.

## Revisão

- Três rodadas manuais; a primeira identificou incompatibilidade entre BIGINT do PostgreSQL e o marcador de fechamento, corrigida antes da validação final. As duas seguintes não identificaram outro defeito concreto no escopo.
- Três consultas somente de leitura ao Plandex com os arquivos completos e o diff; nenhuma falha concreta adicional demonstrada. Sem aplicação automática, compras ou recarga.
- Graphify mapeou as dependências e os consumidores do motor, bridge, fechamento e testes. A análise do grafo orienta o escopo; não substitui execução.
- Comentários e mapa de jornada foram ajustados para distinguir a retomada fixa da adaptativa.

## Execução local

| Verificação | Resultado |
| --- | --- |
| Unitários focados de tempo/ponte/nós | 106 aprovados |
| PostgreSQL focado: retomada, fechamento e memória | 24 aprovados |
| PostgreSQL geral | 1.559 aprovados, 1 previamente marcado como skip |
| E2E Chromium, cinco arquivos, um worker, sem retries | 13 aprovados |
| Build de produção contra Supabase descartável local | Aprovado |
| Typecheck, lint, lint de canais e papéis | Sem erros; 322 avisos de lint preexistentes |
| Conferência do fragmento de release | Aprovada, sem gerar versão |
| Unitários gerais — repetição com dois workers | 8.815 aprovados e 1 falha esperada declarada; 800 arquivos aprovados |

A primeira execução geral dos unitários teve 8.813 aprovados, dois timeouts no `beforeEach` do PGlite e uma falha esperada declarada pelo teste. Os arquivos afetados (`inbound-pending` e `confirm-video-delivery`) passaram na repetição isolada: 34/34, sem mudar código, asserções nem prazos. A execução geral foi repetida com menos concorrência e passou integralmente, sem mudar asserções nem prazos. Os quatro testes adicionais do runner Node (registry, loop, cron e pdf) também passaram.

O skip de banco é `webhooks-inbound.test.ts`: limite de requisições, explicitamente delegado ao teste unitário do fallback em memória. Não é um cenário novo omitido desta correção.

Baseline e atualização foram aplicados no banco descartável pelo runner. Os testes não têm chaves reais de IA nem conexão com WhatsApp; usam PostgreSQL, APIs, telas e seams de modelo/transporte controlados, conforme a camada. [Capturas desta execução](../../evidence/experimental-reminder-memory/README.md).

## Prova real de áudio e limite da homologação

Somente a conversa de teste da Escola Atlético Oficial recebeu uma gravação sintética de 17 segundos. O serviço de produção transcreveu o conteúdo e o Júnior respondeu por texto corretamente: turma de 5 a 8 anos no Pontal Sul, terças e quintas, 19h30–20h30. Também respeitou o pedido de não agendar. O job terminou sem erro e o contato ficou com zero inscrições ativas de follow-up. Não foram enviadas mensagens aos leads nem alterado o aquecimento.

Essa prova confirma a compreensão daquele áudio claro na versão já publicada. Não valida as duas correções da branch nem garante toda gravação. A validação das correções no WhatsApp depende de publicar a branch em ambiente autorizado; permanece pendente pela instrução de não fazer deploy. Não foram reprocessados áudios dos leads.

## Laço operacional

- Declaração: plano com `decidido_em`, mensagem-âncora e versão da próxima ação.
- Consumidores: motor do follow-up, callback da ponte e publicação do checkpoint. Não há nova tabela/configuração órfã.
- Evidência: `timing_plan_decidido`, próximo prazo na fila/dossiê e próxima ação confirmada no estado.
- Retorno: planejamento que não conclui fica terminal com aviso existente `followup_dead`; não cai silenciosamente no envio antigo.
- Proteções: resposta nova, pausa humana, CAS, lease, callback repetido, outro workspace e anonimização estão cobertos nas regressões.

Os logs completos, revisões e capturas da execução estão no artefato local `C:/Users/muril/.cache/crm-validation/experimental-reminder-memory-20261107`. Nenhum segredo ou dado real dos leads foi adicionado ao repositório.
