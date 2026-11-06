# Correções operacionais na branch de estabilidade

Escopo aprovado: mesma branch, investigação/implementação, revisão e correção antes dos testes. Sem merge, deploy, PR 20, mudanças no banco real ou mensagens aos leads.

## Critérios de aceite

- Transcrição usa credencial OpenAI independente do provedor de chat; PDF não depende de LLM. Mídia vazia/falha não aparece como interpretada.
- Reprocessamento manual é isolado à derivação, autorizado pelo workspace e pela conversa. Não reabre nem responde a uma mensagem antiga.
- Consulta ao responsável pode ser silenciosa. Encerramento interno fica auditado e não envia mensagem nem reativa opt-out/atendimento humano.
- Falha de áudio pode consultar o responsável conforme opção do agente. Deduplicação por conversa e preservação dos gates de atendimento.
- Follow-up diferencia fila aguardando, transporte confirmado, cancelamento esperado, falha terminal e transporte incerto; nunca avança só por tags ou sucesso do modelo.
- Alertas permitem abrir a origem acessível e distinguem data do evento de situação atual.
- Etiquetas mantêm origem explícita; não sobrescrevem etiquetas particulares do negócio.
- Editor não envia todo o histórico de prompts na abertura; histórico continua acessível sob demanda.

## Trabalho operacional separado

Etiquetar contatos reais, encerrar consultas antigas, conferir agendamentos e publicar uma versão de treinamento são ações posteriores pelas telas. Nenhum nome, telefone, pagamento ou matrícula real será inserido como correção de código. Nenhuma mensagem será enviada nesta implementação.

## Ferramentas

Graphify: mapa de dependências e impactos do worker de mídia e dos callbacks de entrega. Plandex: apoio ao planejamento, sem execução ou aplicação automática. Resposta ausente/timeout não conta como revisão aprovada.

## Verificação

Após fechar a revisão: regressões isoladas de credencial, conteúdo vazio, consulta silenciosa, encerramento concorrente, retry sem resposta antiga, reconciliação de fila/ledger; banco com baseline install/update, isolamento, UI desktop/mobile, typecheck/lint/build e testes de jornadas afetadas. Evidências locais fora do repositório e sem dados reais.

## Contratos operacionais

- `POST /api/v1/messages/:id/reprocess`: papel mínimo agent e visibilidade da mensagem pela sessão; somente mídia recebida, armazenada, não apagada e com falha. Formatos sem extrator são recusados. Uma tarefa de derivação ativa impede outra. O evento não dispara novo turno de resposta. Mutação auditada.
- `POST /api/v1/ai/cases/:id/reply`, ação `resolved_internal`: exige motivo, resolve o caso e registra a decisão sem criar `case_reply_turn`. Guarda NOWAIT impede concorrer com resposta do responsável em trânsito; entrega incerta também bloqueia. Pausas humanas e opt-out não são removidos.
- Configuração de consulta: `notify_client` mantém default true nas configurações antigas; `audio_failures_to_responsible` começa false. As opções são por agente/workspace e não publicam treinamento ou encerram consultas antigas automaticamente.
- `GET /api/v1/ai/agents/:id/versions`: limite padrão 50, máximo 100; cursor `before_version`, resposta com `meta.cursor` e `meta.has_more`. A aba carrega páginas de 20. A versão publicada pelo ponteiro e o rascunho mais recente permanecem na carga inicial mesmo fora da primeira página.
- `fn_followup_reconcile_action`: somente service_role. Exige snapshot CAS e identidade da ocupação. Pending/running aguardam o job sem consumir passos; done com ledgers totalmente accepted pode concluir. Falha com entrega parcial/retida/incerta pausa para conferência. Cancelamentos esperados não viram alertas críticos. Reentrada por janela usa o próprio job; crons legados continuam reconhecidos.

## Sistema vivo

Entrada: opções de consulta e botão Reprocessar no Inbox. Saída: consulta contextual ou texto derivado seguro. Diagnóstico: aviso com origem acessível e estado atual separado da data do evento. Recuperação: nova derivação explícita, encerramento interno auditado e conferência de entrega incerta. Consumo: turno do agente, Central, ficha do negócio e histórico de versões. Mapa: `docs/architecture/operational-media-followups.architecture.json`.

## Limites da regularização

A implementação entrega os controles. Aplicar etiquetas aos atendimentos reais e classificar agendados/aguardando material/retomada/encerrado depende da revisão das conversas pelas telas após a publicação autorizada. Não há classificação automática baseada em nomes nem atualização retroativa de agendamento, pagamento ou presença. A fila de consultas precisa ser encerrada conscientemente; a correção não a libera em lote.

# Revisão após a bateria completa de 06/11

- O cliente HTTP recupera resposta perdida somente nos dois POSTs com contrato
  persistido de idempotência (`messages` e `automation-rules`), com chave explícita,
  três tentativas no máximo e um único orçamento. Timeout, cancelamento, falha de
  body/schema e demais escritas continuam sem repetição automática.
- A jornada E2E de follow-up isola temporariamente outros canais operacionais
  apenas na organização sintética do banco local e restaura os estados no fim.
  A proteção do produto contra remetente ambíguo permanece ativa.
- O teste de reordenação usa quantos cliques forem necessários para chegar ao
  topo, verificando cada movimento. O cenário de último funil isola/restaura os
  outros funis sintéticos em transação. A prova de autoria escolhe etapa de funil
  ativo e usa o DSN local explícito do runner, sem container fixo; guardas testadas
  recusam destinos ausentes ou remotos. As assertivas finais originais permanecem
  obrigatórias.
- A bateria inicial de banco encontrou um timeout no cenário com três ingressos
  de webhook, enquanto outras suítes rodavam. A reprodução e a repetição de banco
  devem ocorrer sem concorrência com build/Playwright, sem aumentar o timeout.

## Resultado da validação local de 06/11/2026

- Vitest: 8.797 casos aprovados e uma falha esperada preexistente, em 797 arquivos,
  considerando a bateria completa e as reexecuções isoladas. Dois hooks de PGlite
  expiraram durante execução concorrente com build; os dois arquivos passaram
  integralmente na repetição com menos concorrência. Os limites não foram ampliados.
- Os 32 casos focados de recuperação idempotente/interface passaram. Os quatro
  testes nativos de importação, inicialização e renderização de PDF também passaram.
- Banco: 1.553 casos aprovados e um skip preexistente, considerando a bateria de
  180 arquivos e a reprodução isolada do único caso que havia expirado. Esse caso
  passou em 10,4 segundos, com o limite original de 30 segundos. INSTALL e UPDATE
  do baseline passaram com ON_ERROR_STOP.
- E2E: matriz local de 96 specs, um worker e zero retries. Parte 1: 156 resultados
  aceitos pelo Playwright, incluindo uma falha esperada preexistente. Parte 2:
  158 aprovados e seis skips. As 18 verificações das jornadas corrigidas também
  passaram antes da repetição completa das duas partes.
- Typecheck, lint, lint:channels, lint:role-rank e build passaram. O lint mantém
  322 avisos preexistentes e nenhum erro. O bundle foi conferido contra o Supabase
  local isolado, com controle positivo do host usado na compilação.
- Plandex concluiu a revisão da recuperação idempotente e da restauração em
  transação. Graphify registrou 19.926 nós/62.130 arestas; o cliente HTTP possui
  159 consumidores mapeados, incluindo testes. As ferramentas não aplicaram código.

### Limites da cobertura

- A cerca de degradação silenciosa já usa test.fail. Nesta execução parou na
  pré-condição de interceptação, portanto não valida o aviso de entrega silenciosa.
  O controle positivo independente de mensagem por WebSocket passou. Não se deve
  contar a cerca como demonstração de que esse aviso funciona.
- Quatro casos do acervo exigem uma chave OpenAI E2E real; dois casos de agenda
  exigem OAuth Google. Permaneceram sem execução, sem uso de chaves de produção.
- Os specs de instalação fresca com WAHA/Redis e de cadastro com confirmação de
  e-mail desligada estão fora da matriz do CI e não foram executados nesta rodada.
  Exigem perfis locais próprios, diferentes do provedor usado pelas demais specs.
- O skip de banco é o rate limit que o próprio arquivo declara coberto no teste
  unitário do fallback. A falha esperada unitária é a separação de histórico da agenda.

### Registro operacional

O QA antigo de autoria apontava para um container fixo e, na primeira bateria,
alterou metadados de autoria/horário da organização sintética e2e-test-org em outro
banco local de testes. O helper passou a exigir o DSN local explícito do runner;
nenhuma escrita foi feita em produção. Os valores anteriores desses metadados
não estavam disponíveis para restauração exata. A matriz final usou apenas o projeto descartável
crm-stability-20261105, API 55421, banco 55422 e app 3106.

O início da bateria foi condicionado à disponibilidade do banco/Auth após reinício
automático do WSL. Evidências, logs e fingerprints estão fora do repositório.
Não houve CI remoto, merge, deploy, alteração no PR 20 ou mensagens a leads reais.


## Complemento: seis casos externos de 06/11/2026

Os seis skips acima foram tratados separadamente, sem alterar produto, serviços
de produção, PR 20 ou executar CI remoto. Cinco dos seis agora têm prova local.

| Caso anteriormente pendente | Resultado complementar |
| --- | --- |
| FAQ indexada com chave cadastrada pela tela | Aprovado com embeddings reais |
| Documento enviado vira trechos | Aprovado com embeddings reais |
| Seleção de fontes pertence ao assistente escolhido | Aprovado |
| Material não utilizado por nenhum assistente é sinalizado | Aprovado |
| Retorno OAuth reconhece state e vínculo sem sessão Strict | Aprovado com client de teste e código deliberadamente inválido; erro específico da troca confirmado |
| Consentimento Google real e conta conectada persistida | Implementado, ainda não executado: faltam aplicativo OAuth e conta Google dedicados de teste |

A rodada complementar rodou os seis casos do acervo e os três do retorno OAuth:
**9 aprovados, zero skips, zero retries**, em 41,6 segundos. O caso do retorno
não prova consentimento nem sincronização real com uma conta Google. Ele prova
que as guardas reconhecem a volta e deixam alcançar a troca de código.

Os 49 testes unitários relacionados às rotas/configuração/cartão Google passaram.
Typecheck, lint, lint:channels e lint:role-rank passaram; continuam os 322 avisos
preexistentes de lint, sem erros. Plandex revisou os testes/rotas sem encontrar
defeito demonstrável; o grafo Graphify existente foi consultado para dependências
dessas rotas (10 nós e 96 arestas no recorte). Não há aprovação para merge/deploy.

A chave existente autorizada pelo usuário respondeu ao preflight de embeddings
(status 200, 1 vetor de 1.536 dimensões) e foi injetada no processo de teste, sem
ser escrita nas fixtures ou logs. O teste a cadastrou pela própria UI local;
traces, vídeos e capturas automáticas ficam desativados nesse perfil. Nenhuma
compra ou recarga foi realizada.

O primeiro preparo do acervo parou antes dos cenários: o WSL havia reiniciado e
a API local ainda não tinha carregado o schema. Foi adicionada ao runner externo
uma espera limitada pela disponibilidade real de Auth/REST antes da semeadura;
não se alteraram limites ou assertivas do produto para obter aprovação.

### Como executar o único caso ainda pendente

1. Usar somente a instalação local descartável (app em http://localhost:3106),
   sem conexão Google prévia para o usuário sintético.
2. Disponibilizar aplicativo OAuth de teste com retorno exato
   http://localhost:3106/api/v1/agenda/google/callback e conta Google dedicada
   autorizada nesse aplicativo. Client ID/secret ficam somente na configuração
   local protegida do servidor; não devem ser enviados no chat nem commitados.
3. Injetar E2E_GOOGLE_LIVE=1 e E2E_GOOGLE_EXPECTED_EMAIL com o e-mail da conta
   de teste. Rodar Playwright em modo visível (--headed), selecionando o caso
   "conectar a agenda do Google pela tela e ver a faixa mudar". A pessoa faz
   login e autoriza na janela Google; não há simulação do callback.
4. O teste verifica consentimento offline, retorno sem erro, conta exibida,
   persistência após recarga e desconexão pelo botão ao terminar. A única
   captura explícita é a Agenda local após sucesso, sem tela de senha/consentimento.
5. Rodar o perfil sem Google separadamente, para continuar provando a degradação
   explicada. Usar E2E_REQUIRE_EXTERNALS=1 faz a ausência do opt-in real reprovar
   explicitamente, em vez de fingir aprovação.

Google Calendar é uma sincronização opcional. A agenda interna do CRM funciona
sem essa autorização. Deixar o consentimento externo pendente não deve ser
registrado como teste aprovado nem como impedimento de uso da agenda interna.

A credencial OpenAI temporária criada pelo teste foi removida ao final: uma
linha excluída somente do projeto descartável crm-stability-20261105, organização
e2e-test-org, provedor openai. A chave protegida preexistente do Plandex permaneceu
intacta. Evidência da limpeza fica junto aos logs locais, sem segredos.

## Revisão adicional de capacidade em 06/11/2026

A revisão reproduziu um limite incompleto na autenticação: `fetch` encerrava
a contagem de concorrência ao receber os headers, mas o SDK ainda aguardava
o corpo. Um servidor HTTP local que entrega headers e segura o JSON permitiu
129 operações `getUser` pendentes, apesar do limite de 128 headers. Isso prova
uma fraqueza de contenção; não comprova a causa inicial da indisponibilidade
anterior do Supabase.

`lib/auth/request-capacity.ts` limita a operação completa a 128 autenticações
por runtime. `proxy()` e `loadAuthUser()` consomem essa guarda; no segundo,
ela também cobre a carga de permissões. A vaga permanece ocupada até o SDK
consumir o corpo ou falhar. Saturação retorna indisponibilidade sem tratar
o usuário como deslogado ou liberar acesso sem validação. A vaga é devolvida
em `finally`, inclusive em timeout e exceção. Não há fila ou dados de sessão
nos globais; proxy e renderizador podem executar em runtimes diferentes.

O laço operacional usa `auth_capacity_exceeded`, limitado a um aviso a cada
dez segundos por runtime, e as respostas 503 chegam aos consumidores existentes
de erro/retry do Inbox e das rotas. O mapa vivo incorpora a nova guarda com
arestas para autenticação e diagnóstico. O Graphify foi reextraído: 19.940 nós
e 62.178 arestas, com ligações reais para `loadAuthUser`, `proxy` e testes.
Os dois avisos de extração parcial continuam nos mesmos arquivos preexistentes.

Plandex revisou rede/autenticação, fila/follow-up e mídia/casos. Após a correção
demonstrada manualmente, uma nova revisão do contexto completo de autenticação
não encontrou falha concreta adicional. As ferramentas só analisaram o código.

Os 20 testes direcionados passaram, incluindo HTTP real com o SDK Supabase:
128 corpos pendentes conservam suas vagas; a operação excedente não chega ao
transporte; completar os corpos recupera capacidade; timeout e exceção liberam
a vaga. Proxy saturado retorna 503 nas rotas de interface e API, enquanto login
público permanece acessível. A suíte unitária completa passou sem retries:
799 arquivos, 8.805 testes aprovados e uma falha esperada preexistente, além de
quatro testes nativos aprovados. Nenhum limite ou assertiva foi afrouxado.

Typecheck, lint, lint:channels e lint:role-rank passaram; o lint conserva os
322 avisos preexistentes e nenhum erro. A primeira tentativa do typecheck
parou no heap padrão de aproximadamente 2 GB da ferramenta local. A repetição
usou limite de 4 GB, com 6,9 GB disponíveis no ambiente local, e passou. Esse
ajuste foi apenas do runner externo ao repositório, sem mudança no produto,
nos testes ou na VPS. A sequência permaneceu bloqueada até essa aprovação.

O build passou e o controle do bundle confirmou o host local isolado. O E2E
adicional rodou cinco specs de autenticação, primeiro acesso, Inbox com escopo,
papéis/permissões e troca de organização: 19 aprovados, zero skips e zero retries,
em 47,4 segundos. Inclui login com MFA e bloqueio de envio para viewer. Os hashes
dos três arquivos de runtime e das três regressões foram conferidos byte a byte
entre a branch e os dois snapshots usados nas verificações. O projeto Supabase
descartável foi encerrado ao final, sem atingir outras instalações locais.

Antes da revisão, a limpeza operacional removeu somente 15 imagens Docker
sem tag, sem referência de qualquer container e com mais de sete dias, usando
IDs conferidos novamente antes da remoção e sem remoção forçada ou em cascata.
Foram preservadas todas as imagens com tag, versões publicadas/rollback,
containers, volumes, banco, mídias e logs. O disco passou de 94% para 83%,
liberando aproximadamente 7,2 GB e mantendo 11,8 GB disponíveis. A verificação
posterior confirmou os serviços saudáveis na versão 3.9.4 e HTTP 200 no login.
Não houve reinício ou publicação de serviços durante essa limpeza.

Esta correção não altera schema: a prova anterior de instalação/atualização e
os testes de banco continuam registrados acima. O consentimento Google real
permanece adiado por decisão do usuário. Não houve CI remoto, merge, deploy,
alteração no PR 20 ou mensagens de teste para leads.

## Nova rodada de revisão: compatibilidade e download

A revisão manual encontrou mais duas falhas. A composição incondicional por
`AbortSignal.any` lançava TypeError antes de `fetch` quando a API não existia.
O Next instalado documenta Chrome 111+ e Safari 16.4+; essa composição não está
presente em todas essas versões. Referências: documentação instalada em
`node_modules/next/dist/docs/03-architecture/supported-browsers.md` e
[MDN AbortSignal.any](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal/any_static).
O teste novo reproduziu o erro antes da correção. O fallback usa AbortController,
propaga cancelamento/timeout e remove listeners em `finally` a cada tentativa,
inclusive após sucesso e erro, mantendo as regras existentes de idempotência.

Também foi confirmado que o download de `media-derive-worker` usava o admin
client sem prazo para transferência de Storage. Agora o worker passa o sinal
de 60 segundos diretamente ao SDK, sem mudar uploads manuais. A prova com HTTP
real e SDK mantém os headers e trava o corpo; o prazo interrompe a leitura com
TimeoutError. O teste do worker confirma erro, ausência de derivação e marcação
failed na última tentativa. Na primeira versão dessa prova, a assertiva esperava
um resultado com error; foi corrigida para exigir a exceção realmente observada
no SDK, sem afrouxar o critério de cancelamento.

Plandex revisou novamente rede, acompanhamentos e mídia, e depois os dois
ajustes. O alerta de disponibilidade de AbortSignal.timeout no worker não se
aplica: esse código só executa no Node 22, fixado no Dockerfile e CI, e não no
navegador. A revisão manual não confirmou outra falha concreta nesses ajustes.

Validação desta rodada: 61 testes direcionados aprovados em nove arquivos;
typecheck, lint, lint:channels, lint:role-rank e build aprovados, sem novos avisos
de lint. O E2E repetiu os cinco specs de acesso com a nova regressão de navegador:
20 aprovados, zero skips e zero retries, em 47,9 segundos. A nova regressão remove
a API antes do código da página e exige consulta real do Inbox com HTTP 200.
O Graphify foi atualizado para as alterações do cliente e do worker. A suíte
completa de 8.805 testes da rodada anterior não foi repetida: esta rodada executou
as regressões das partes modificadas e seus consumidores diretos. O ambiente
descartável foi encerrado, sem alteração em produção, CI remoto, PR 20 ou leads.

## Preparação para merge do PR 65

O proprietário autorizou o merge deste trabalho e o encerramento do PR 20 sem
merge. O PR 20 foi fechado; a branch de código dele foi preservada. O PR 65
foi aberto com os seis commits revisados. Na primeira execução remota, ambas
as partes do E2E pararam antes de testes: `version: latest` instalou Supabase
CLI 3, que rejeita `[inbucket]` do config atual. O workflow agora fixa 2.122.0,
a mesma versão usada na homologação local. A mudança não migra o ambiente do
produto nem remove casos/assertivas. O merge continua condicionado aos checks
do novo head, e deploy não foi autorizado nesta etapa.
