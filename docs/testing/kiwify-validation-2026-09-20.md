# Validação da entrada Kiwify — 2026-09-20

Branch mantida: `feat/kiwify-ingestion-stage-one`, base
`24a9a3b07d59048dfa254f6df340317334a88b95`. Sem commit, merge, push, release,
deploy, produção, credenciais reais ou consumidores de envio. Auditoria anterior
preservada. Esta evidência valida a **entrada**, não a integração WhatsApp.

## Ambiente real e isolamento

Docker ausente, WSL instalado sem distribuição. A investigação encontrou Git Bash
e Visual Studio 18 BuildTools com C++ já instalados. Alternativa utilizada:

- PostgreSQL **15.18** portátil, binários oficiais EDB:
  `https://get.enterprisedb.com/postgresql/postgresql-15.18-1-windows-x64-binaries.zip`.
- pgvector **0.8.1**, compilado com `nmake /F Makefile.win` e instalado apenas no
  prefixo portátil. Fonte oficial `pgvector/pgvector`, tag v0.8.1,
  commit `778dacf20c07caf904557a88705142631818d8cb`.
- Extensões efetivamente instaladas: `uuid-ossp 1.1`, `pgcrypto 1.3`, `citext 1.6`,
  `pg_trgm 1.6`, `vector 0.8.1`, `plpgsql 1.0`.
- PostgREST **16.3**, distribuição Windows oficial, sem logs de requests.
- Node **24.16.0**, pnpm **9.15.9** via Corepack; testes da base e branch no mesmo runtime.

Prefixo local: `%LOCALAPPDATA%\Temp\opencode`. Cluster `kiwify-pgdata`, somente
`127.0.0.1:55439`, autenticação local de teste. Não foi instalado serviço Windows
nem alterado PATH global. Banco temporário e worktree foram preservados, conforme
pedido. Os processos PostgREST criados pelos testes foram encerrados por seu próprio
handle no teardown; o PostgreSQL permanece disponível.

O script `scripts/kiwify-validate-local.mjs` extrai o prelude **do script oficial
`scripts/test-db.sh`**: roles anon/authenticated/service_role, default ACLs de
Supabase, extensões, schemas/tabelas mínimas auth/storage e função `auth.uid()`.
Não substitui PostgreSQL por mock, PGlite ou emulação de concorrência.
`kiwify_fresh` é o molde; `kiwify_upgrade` mede atualização; `kiwify_test` é recriado
por arquivo, com verificação do marcador do molde antes do reset.

### Comandos de reprodução (PowerShell, após preparar os binários)

```powershell
$temp = "$env:LOCALAPPDATA\Temp\opencode"
$env:KIWIFY_TEST_PG_BIN = "$temp\pgsql\bin"
$env:KIWIFY_TEST_PG_PORT = '55439'
# Este script recria APENAS os bancos nomeados kiwify_fresh/upgrade/test.
node scripts/kiwify-validate-local.mjs
$env:PATH = "$env:KIWIFY_TEST_PG_BIN;$env:PATH"
$env:TEST_DB_PORT = '55439'
$env:KIWIFY_TEST_POSTGREST = "$temp\postgrest.exe"
corepack pnpm exec vitest run --config vitest.kiwify.config.ts --reporter=verbose
```

O PATH local inclui `libpq.dll`; sem ele o PostgREST Windows saiu com
`-1073741515` antes de escutar. Essa foi a causa concreta da primeira tentativa
HTTP frustrada e foi corrigida sem instalar componente adicional.

## Instalação e atualização

Todas as aplicações SQL usaram `psql -X -v ON_ERROR_STOP=1`:

| Prova | Resultado |
|---|---|
| Banco vazio + prelude + baseline atual | Passou |
| Reaplicação do baseline atual | Passou, catálogo Kiwify invariável |
| Prelude + baseline do commit-base + migration 0220 | Passou |
| Reaplicação da migration 0220 | Passou |
| Comparação fresh × upgrade | Igual |

Comparação automatizada: colunas/defaults/nullability, constraints/FKs, índices,
definições das funções, SECURITY INVOKER/DEFINER, `search_path`, ACLs e políticas
RLS das peças Kiwify; inclui índice composto adicionado a `catalog_products`.
Nenhuma divergência SQL a corrigir foi encontrada entre os dois caminhos.

## Invariantes — 24 aprovados

As chamadas de configuração/ingestão usam pool com **`role=service_role`**, e não
privilégios efetivos de postgres. Administração de fixtures/falhas usa conexão
separada. Recusas são executadas com `SET LOCAL ROLE anon/authenticated` e claim
de usuário sintético; não se limitam a inspecionar GRANTs.

- Concorrência provada com barreira: lock da integração é retido por outra
  transação até `pg_stat_activity` mostrar **oito sessões aguardando Lock**.
- Após liberar: **1 accepted + 7 duplicate**. Retry sequencial: duplicate.
- Estado final: **1 contato, 1 lead, 1 receipt, 1 captura, 1 auditoria
  `kiwify.received`, 1 evento `lead.created`**. INSERT duplicado direto falha 23505.
- Mesma identidade de pedido em lojas/organizações distintas fica separada.
- RLS permite leitura própria e não retorna receipts alheios; roles públicas não
  leem segredos/mapeamentos, não inserem/excluem configuração/mapeamento, não
  alteram/inserem/excluem/truncam ledger e não executam as RPCs Kiwify (42501).
- RPCs Kiwify são invoker com `search_path=public, pg_temp`. Helpers de cifra e
  `emit_event` são definer com search_path fixo e sem EXECUTE para anon. Cifra não
  é executável por authenticated. `emit_event` mantém seu grant authenticated
  preexistente; não foi alterado por esta etapa.
- FK de produto cross-tenant falha 23503 usando service_role.
- Conflito incrementa contador e preserva fingerprint/lead original.
- Bloqueio/opt-out, anonimização, telefone ambíguo, variante brasileira legada e
  ausência de telefone foram exercitados. Sem telefone: nenhum evento de automação.
- Injeção de falha em **cada uma das seis escritas** (`contacts`, `crm_leads`,
  `event_log`, `kiwify_receipts`, `webhook_lead_captures`, `api_audit_log`): contagens
  de todas as seis tabelas idênticas ao snapshot anterior; remover a falha permite
  retry accepted e retry seguinte duplicate. Telefones sintéticos novos por caso.

## Jornada HTTP — 5 aprovados

`tests/invariants/kiwify-http.integration.ts` hospeda o **POST de produção** num
listener HTTP local e encaminha REST ao **PostgREST real**, que valida JWT sintético
e executa como service_role. O cliente Supabase, a cifra pgcrypto, a validação HMAC,
normalização e RPC não são substituídos por doubles.

Compra assinada/produto permitido e oito chamadas concorrentes: uma captura e um
lead/evento. Retry não duplica. Assinatura inválida: 401, sem receipt. Pix pendente,
reembolso e aprovado ainda pendente: 200 ignored, sem lead/evento.

**Limite desta prova inicial:** estes cinco testes não exercitam o roteador/proxy/
bundle Next nem a tela do CRM. A prova posterior pelo Next real está registrada
abaixo. Nenhuma das execuções inicia worker/drain ou provedor de mensagens.

Execução final conjunta: **2 arquivos, 29 testes, zero falhas/skips**, 11,09 s.

## Tipos de banco

Gerado o schema public real de `kiwify_fresh` com o componente oficial
`@supabase/postgrest-typegen@0.2.0`, utilizado pelo caminho `gen:types:typescript` do
`supabase/postgres-meta` (checkout `f380cc5be21edef4e77d9838c732d1f20af0b3c0`).
Usados `introspect`, `sortGeneratorMetadata`, `generateTypescript`, com
`includedSchemas: ['public']` e detecção de relações 1:1.

A CLI Supabase usa Docker para a geração local; executou-se diretamente o gerador
oficial, sem conexão `--linked`. Foram incorporados em `lib/database.types.ts`
somente os **três blocos de tabelas e dois de RPCs Kiwify**. A comparação automática
com a saída gerada confirmou os cinco blocos idênticos. Tipos não foram inferidos
à mão. Demais divergências históricas do schema não foram incorporadas nesta etapa.
Saída integral preservada: `%LOCALAPPDATA%\Temp\opencode\kiwify-generated.types.ts`.

## Reconciliação das 51 falhas anteriores

| Causa na execução anterior | Casos | Resultado desta sessão |
|---|---:|---|
| Preload bloqueava exemplos/fixtures `.env` | 9 | Corrigida a restrição do harness; passaram |
| Preload bloqueava receivers HTTP sintéticos locais | 22 | Corrigida normalização de argumentos de socket; passaram, rede externa continua bloqueada |
| Bash/grep indisponíveis no PATH | 10 | Git Bash já instalado colocado no PATH apenas dos processos; passaram na suíte fragmentada |
| Gate de posição do apêndice SQL Kiwify | 1 | Correção da sessão anterior confirmada; passou |
| Importação de leads (422 em vez do resultado esperado) | 6 | Mesmos seis casos falham no commit-base; não é regressão Kiwify |
| Sonda de paths Windows (`relative` produz `\\`) | 1 | Mesma falha no commit-base; não é regressão Kiwify |
| Timeouts de icons/telas | 2 | Passaram na suíte fragmentada, sem aumentar timeout |
| **Total** | **51** | |

Checkout-base separado e limpo em `%LOCALAPPDATA%\Temp\opencode\kiwify-base`,
detached em `24a9a3b0`; mesmas dependências por junction node_modules, mesmo Node,
mesmo preload e dois workers. O recorte dos 16 arquivos rodou nos dois checkouts:
**148 passaram/9 falharam em ambos**, com mesmos nomes de casos. Incluiu timeouts
transitórios de icons/namespace; esses dois passaram nos grupos amplos posteriores.
Não foi feita afirmação de que as outras centenas de arquivos da base passaram:
a comparação de base cobriu especificamente os 16 arquivos anteriormente vermelhos.

A causa imediata das seis falhas de importação é 422 antes das chamadas esperadas
ao handler. A origem exata desse 422 não foi corrigida/inferida como defeito Kiwify.
Investigação da importação e normalização da sonda Windows são pendências herdadas.

### Suíte completa em quatro shards

Comandos equivalentes: `vitest run --maxWorkers=2 --shard=N/4`, N=1..4, sem filtro de
caminho. Mesmo include/exclude do `vitest.config.ts`; relatórios conferidos sem
sobreposição: **698 arquivos distintos**. Não foram removidas assertions, criados
skips nem aumentados timeouts. O preload não lê `.env`/`.env.local` reais e só libera
conexões aos listeners locais criados pelo próprio processo de teste.

| Grupo | Arquivos | Passaram | Falharam | Falha esperada |
|---|---:|---:|---:|---:|
| 1/4 | 175 | 2103 | 6 | 0 |
| 2/4 | 175 | 1768 | 1 | 0 |
| 3/4 | 174 | 2161 | 0 | 1 |
| 4/4 | 174 | 1715 | 0 | 0 |
| Total | 698 | **7747** | **7** | **1** |

O reporter JSON contabiliza o caso de falha esperada como passed; a tabela acima
preserva a distinção do resumo textual. Smoke adicional do script `test:unit`:
`node --test tests/unit/event-log-imports.smoke.cjs`, **4/4 aprovados**.

Relatórios completos preservados no prefixo temporário. SHA256:

| Relatório | SHA256 |
|---|---|
| regressions-branch-all.json | `90292faa59cdc609edd2af6e5d55baaccba4e0fa5fe119e04d562cca7dbe793d` |
| regressions-base-all.json | `09b48769b1754f5ebe92a44a2a7530c36ddba94c78081c6a7c50582f079a2228` |
| full-branch-1-4.json | `a5fcd8fc2cfbf9629ad3dcaf776dc33df9fa82a5cbc07672112aefd505658843` |
| full-branch-2-4.json | `6fe01e5acff0b1b38c8bb9597ab347d5c408109eaaa23d63d8fddf6eb56c5ea5` |
| full-branch-3-4.json | `578f3aab48c3a61f5b9e947aa3006c36942837fff548d4b968f106cf3239cd72` |
| full-branch-4-4.json | `b7151aeaeb844036864253883997291280e9617994199d8c9f961fa585803aa5` |

## Checks da primeira rodada de validação

- Typecheck, lint:channels, lint:role-rank e diff --check passaram.
- Lint completo: zero erros; 312 warnings na execução, um no novo teste HTTP
  corrigido depois para import type. Lint focal posterior passou sem avisos.
- Build iniciado offline, mas interrompido pelo limite da ferramenta após 180 s
  em “Creating an optimized production build”, sem diagnóstico final. Não se
  afirma build verde nem se atribui a causa à rede sem evidência.
- `pnpm test:db` oficial ainda termina em `docker: command not found`.
  O caminho nativo valida o recorte Kiwify e baseline; não equivale a declarar
  verdes todos os invariantes de banco do repositório.
- UI/E2E de navegador, imagens Docker e homologação externa não executados.

A revisão dessa rodada não encontrou regressão funcional Kiwify nos cenários executados. As
correções desta continuação foram no harness de validação e lacunas de cobertura,
mais os tipos gerados. Nenhuma alteração de funcionalidades de WhatsApp.
Permanecem sete falhas amplas herdadas e os checks acima pendentes; não declarar
a integração completa ou homologada.

## Fechamento: build e servidor Next real

### Diagnóstico e resultado final do build

A tentativa interrompida não estava mais ativa: nenhum processo Next build
continuava executando; `.next/diagnostics/build-diagnostics.json` permanecia em
`compile`. A nova execução foi acompanhada por processo monitor, com stdout/stderr
e exit code persistidos, para separar o tempo de compilação do tempo da chamada.

Resultado diagnóstico: exit 1 após ~205 s. O erro era **do harness**, não da
integração: `OFFLINE_TEST: TCP disabled` na função `createIpc` dos workers
Turbopack que processam `instrumentation.ts` e `instrumentation-client.ts`.
O listener IPC é criado no processo pai/Rust; o preload anterior só reconhecia
listeners criados no próprio processo e bloqueava a conexão legítima do filho.

Correção: liberar somente a porta que o worker Turbopack recebe em `argv[2]`,
somente no modo de build do harness e para loopback. A saída `.next` anterior foi
afastada para o diretório temporário, preservada, depois que uma tentativa ainda
reapresentou a falha anterior. Nenhuma mudança em `next.config.ts`, código Kiwify,
timeouts de testes ou dependências do projeto.

**Build final: exit 0**, de `2026-09-20T18:07:24.425Z` até
`2026-09-20T18:10:38.880Z` (~194 s). Log confirma:

- Compilação concluída em 83 s.
- TypeScript concluído em 60 s.
- 49/49 páginas estáticas geradas.
- Otimização e relatório de rotas concluídos; artefato standalone emitido.

Não houve evidência de OOM ou falha de dependência externa nessa execução final.
Telemetria e credenciais reais permaneceram desabilitadas. Consultas opcionais ao
banco fictício do build caíram no fallback existente, como esperado.
Artefatos de diagnóstico preservados em `%LOCALAPPDATA%\Temp\opencode`:
`kiwify-next-build.log`, `kiwify-next-build-state.json`,
`kiwify-next-build-ipc.log`, `kiwify-next-build-clean.log` e
`kiwify-next-build-clean-state.json` (este registra `code: 0`).

### Servidor Next real, em produção

Adicionados `scripts/kiwify-next-smoke.mjs` e
`tests/setup/kiwify-next-isolated.mjs`. O script:

1. Confere o marcador do cluster descartável existente; clona o molde já validado
   para um banco novo `kiwify_next_<timestamp>` sem reaplicar baseline/migrations.
2. Semeia somente organização, produto, funil, etapa e fonte sintéticos.
3. Sobe PostgREST local real com JWT sintético e gateway apenas para `/rest/v1`.
4. Executa **`.next/standalone/server.js`**, com `NODE_ENV=production`, ligado
   somente a 127.0.0.1. O endpoint Kiwify e o proxy são atendidos pelo Next,
   sem import direto/substituição do handler.
5. Não lê arquivos `.env`; o ambiente é montado a partir de allowlist e valores
   sintéticos. O preload permite somente portas locais do smoke. Logs são
   sanitizados antes da persistência; nenhuma assinatura/token vai para a evidência.
6. Encerra somente os processos Next/PostgREST que criou, preservando banco e cluster.

Resultado final, com o preload ESM e lint aprovados:

| Requisição/estado | Observado |
|---|---|
| HEAD no endpoint Next | 200, pronto |
| Compra aprovada/paga, produto permitido, HMAC correto | 200 accepted |
| Retry idêntico | 200 duplicate |
| Assinatura inválida | 401, zero receipts para o pedido |
| Reembolso | 200 ignored, lead_id/event_id null |
| order_approved ainda waiting_payment | 200 ignored, lead_id/event_id null |
| Contagem final do tenant sintético | **1 lead, 1 lead.created, 0 messages, 0 automation_rule_runs** |

Todas as respostas POST carregaram `X-Request-Id`. Banco final preservado:
`kiwify_next_1789928751241`. Log sanitizado:
`%LOCALAPPDATA%\Temp\opencode\kiwify-next-real-final.log`.

Na preparação do smoke, a cifra recusou corretamente uma chave sintética com menos
de 32 caracteres; foi corrigida somente a fixture. Também foi corrigido o quoting
do preload Windows; a versão final usa `--import` com file URL e passou sem avisos
no lint. Essas tentativas não foram contabilizadas como sucesso.

Reprodução, com o build pronto e o mesmo cluster já preparado:

```powershell
$temp = "$env:LOCALAPPDATA\Temp\opencode"
$env:KIWIFY_TEST_PG_BIN = "$temp\pgsql\bin"
$env:KIWIFY_TEST_PG_PORT = '55439'
$env:KIWIFY_TEST_POSTGREST = "$temp\postgrest.exe"
$env:KIWIFY_NEXT_LOG = "$temp\kiwify-next-real-final.log"
node scripts/kiwify-next-smoke.mjs
```

### As sete falhas herdadas atingem a Kiwify?

A comparação base/branch e os hashes dos relatórios anteriores continuam válidos;
não foi repetida a suíte ampla nem alterados os testes herdados nesta rodada.

Os seis casos de `tests/unit/leads-import-route.test.ts` são:
criação por linha/org da sessão; linha ruim não derruba lote; etapa alheia;
telefone repetido; contato existente; auditoria do gesto de importação.
Esse arquivo mocka `createLeadHandler` e exercita
`app/api/v1/leads/import/route.ts`, que lê multipart e CSV. A entrada Kiwify não
chama essa rota, o parser CSV nem `createLeadHandler`: autentica JSON e persiste
pela RPC `fn_ingest_kiwify`. Os wrappers de resposta e tabelas de domínio são
compartilhados; foram exercitados com banco e servidor reais com sucesso.
Logo, **não foi demonstrado impacto direto dessas seis falhas na entrada Kiwify**.
Isso não transforma a importação de leads em funcionalidade validada.

A sétima falha, em `rascunho-superado-nao-e-regravado.test.ts`, ocorre no controle
positivo da sonda: `path.relative()` gera barras Windows e o teste procura paths
com `/`. Essa sonda pertence ao editor/versionamento de agentes, não ao recebimento
Kiwify. Seu conserto e o da importação ficam fora desta branch. Como a etapa atual
não executa consumidores, também não se extrapola a prova para o runtime de agentes.

### Checks de merge, publicação e homologação

**Política documentada** em AGENTS/CLAUDE: `verify`, `build-and-size`, `invariants`,
`e2e` e `imagens-ok` são critérios de merge, não somente de release.

**Proteção efetiva do fork consultada nesta sessão:**

```text
gh api repos/MurilObras/crm-multiworkspace/branches/main/protection
→ HTTP 404: Branch not protected
gh api repos/MurilObras/crm-multiworkspace/rulesets → []
gh api repos/MurilObras/crm-multiworkspace/rules/branches/main → []
```

Portanto não afirmar que o GitHub deste fork força esses checks. A medição antiga
citada na doutrina é do upstream. Não foram alteradas configurações do GitHub.

| Check/documento | O workflow existente executa em PR? | Situação |
|---|---|---|
| `verify` (`ci.yml`) | Typecheck, lint, lint:channels, test:unit e test:shell em Ubuntu/Node 22 | Checks estáticos passaram localmente; sete falhas unitárias herdadas e falha shell descrita abaixo impedem declarar verify verde |
| `build-and-size` (`perf.yml`) | pnpm build + relatório de tamanho | Build local aprovado; ainda deve passar no runner do PR |
| `invariants` (`ci.yml`) | pnpm test:db; pgvector/pgvector:pg15; baseline install/reapply + tests/invariants/**/*.test.ts | **Cobre automaticamente os 24 invariantes Kiwify novos**, além dos globais. Recorte local passou; resultado global em Docker pendente |
| `e2e` (`e2e.yml`) | Supabase local/Auth/PostgREST/Storage, baseline, build e Playwright; agregador das duas partes | Pendente. As listas atuais não incluem smoke Kiwify dedicado. Exclui explicitamente vps-fresh-onboarding, inbox-tempo-real e cadastro-sem-confirmacao-de-email |
| `imagens-ok` (`publish-image.yml`) | Build das três imagens e boot da imagem app; em PR não publica | Pendente por Docker indisponível localmente; workflow cobre construção e boot no CI |

Lacunas nomeadas: os workflows atuais **não chamam**
`scripts/kiwify-next-smoke.mjs`, `kiwify-http.integration.ts` nem a comparação
schema-base + migration de `kiwify-validate-local.mjs`. Essas provas existem nesta
evidência local, não como checks automáticos do PR. O `invariants` cobre a
instalação/reaplicação do baseline e a matriz SQL Kiwify.

`lint:role-rank` está no `gov:verify`, mas não como passo explícito de `ci.yml`.
Publicação no registry, criação de tag/release e promoção `stable` pertencem ao
fluxo de publicação (`release.yml`/gatilhos de tag de `publish-image.yml`), não são
ações para validar esta branch. Homologação com Kiwify real, proxy HTTPS/logs do
operador e transporte/recibos WhatsApp é posterior e não é coberta por cinco checks verdes.

### Shell e checks finais desta rodada

`pnpm test:shell` foi executado. Backup passou; `update-guard.test.sh` terminou
com uma falha: “.env continua 600 (só o dono lê)”. O mesmo teste executado no
checkout-base produziu a mesma falha no Windows/Git Bash. Não foi alterado o kit
nem relaxada a asserção de permissão. Deve ser validada em Linux no `verify`.

Os testes de dono do projeto, scheduler e owner-id passaram separadamente.
`test-validators.sh` progrediu, mas não produziu resumo final dentro de 240 s;
permanece **inconclusivo**, e ele próprio informou que o consumidor Docker Compose
não foi medido. Não contar esses validadores como aprovados integralmente.

Typecheck passou novamente. Lint dos dois arquivos novos passou após converter o
preload para ESM; `git diff --check` passou. A suíte PostgreSQL, a suíte ampla e a
geração de tipos anteriores foram preservadas, sem repetição desnecessária.

### Conclusão para PR

**A entrada pode seguir para PR de revisão, com esta evidência e pendências
explícitas; não está liberada para merge.** Não foi detectada regressão Kiwify nos
cenários executados, e a lacuna build/Next real foi fechada.

Antes de merge, obter os cinco resultados de CI exigidos pela política; resolver
ou encaminhar formalmente as falhas herdadas se também ocorrerem no runner, sem
silenciá-las nesta branch. Docker/invariantes globais/E2E/imagens não passaram
localmente e não foram declarados aprovados.

Integração completa continua não homologada: faltam prova externa controlada,
configuração/observabilidade do proxy real e toda a validação de efeitos de
WhatsApp, incluindo idempotência do envio e recuperação. Nenhuma funcionalidade
de WhatsApp, commit, push, merge, release ou deploy foi realizada nesta rodada.

## Publicação para revisão — PR #9

Com autorização posterior, a implementação foi publicada em rascunho no
[PR #9](https://github.com/MurilObras/crm-multiworkspace/pull/9), contra a main do
fork, inicialmente no commit `9d76f49f7f3c2b18730640e06605ab227b215612`.
A auditoria preexistente permaneceu fora dos commits.

O primeiro CI encontrou uma regressão de integração com o gate global:
`rls-completude-varredura.test.ts` não reconhecia as três tabelas novas porque
faltava declarar seus testes em `PROVA_PROPRIA`. No mesmo run, os **24 testes
Kiwify passaram**, assim como baseline install/update; a suíte global teve
1 falha/1267 aprovações, além de 1 falha esperada e 1 skip preexistentes.

Correção: registrar as três provas existentes no catálogo do gate, distinguindo
deny-all server-side de configuração/mapeamentos da leitura tenant-aware de
receipts. Nenhuma assertion, policy, grant ou lista de dívida foi afrouxada.
Evidência do achado: run `35529639657`, job `106127845816`.
Resultados finais do SHA mais recente devem ser consultados no PR; sucesso de
um SHA anterior não aprova o posterior. Sem merge, release ou deploy.
