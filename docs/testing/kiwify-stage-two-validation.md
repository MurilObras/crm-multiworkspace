# Validação local — Kiwify etapa 2

> A correção posterior de retenção de PII no plano está em
> [anonimização do plano — 0224](kiwify-plan-privacy.md). Os checks antigos não
> comprovam essa correção.

> Registro da implementação inicial. A revisão posterior corrigiu a identidade por
> posição e comprovou as falhas de ambiente por comparação: ver
> [revisão focal](kiwify-stage-two-review.md). Seus resultados posteriores prevalecem.

Base `4d6d957d01766891a6eb9f4a88b4576a40b24440`; branch
`feat/kiwify-automation-stage-two`. Trabalho não commitado/pushado. Auditoria
preexistente preservada. Não houve merge, release, deploy, VPS ou mensagem real.

## Ambiente

Reutilizados PostgreSQL **15.18**, pgvector e PostgREST **16.3** portáteis da etapa 1,
em `127.0.0.1:55439`. Node **24.16.0**, pnpm **9.15.9**. Sem leitura de `.env` real
nos testes executados. A suíte ampla usa o preload isolador da etapa 1 (bloqueia
egress externo e leitura dos arquivos reais de ambiente). A suíte nativa usa
configuração sintética explícita e reseta somente o banco marcado do harness.

`docker version` confirmou nesta rodada que o comando não está instalado. Isso
impede executar o harness completo de VPS fresca com Supabase Auth. Não foi usado
serviço de produção para contornar essa ausência.

## Schema e tipos

`scripts/kiwify-stage-two-db.mjs` passou: baseline INSTALL + REAPPLY; baseline do
merge da main + migration 0222 + REAPPLY; colunas/constraints/função equivalentes.
O script exige o marcador `kiwify-disposable-validation` antes de recriar o molde.

`automation_rule_runs` e `followup_enrollments` em `lib/database.types.ts` foram
regenerados pelo **@supabase/postgrest-typegen oficial**, contra o schema local.
Não foram escritos à mão. Migration, apêndice antes da varredura anon e MANIFEST
andam juntos. A função de trigger é revogada de PUBLIC/anon/authenticated.

## PostgreSQL real: 100 cenários validados

Uma rodada completa passou com **9 arquivos / 96 testes**. Depois foram
acrescentados dois casos de ACK WAHA e dois de configuração/conexão do canal. O recorte
ampliado de integração passou com **25/25**, totalizando **100 cenários distintos**
validados nesta rodada de desenvolvimento (sem somar repetições dos mesmos testes).

Comando final:

```powershell
$env:KIWIFY_TEST_PG_BIN = "$env:LOCALAPPDATA\Temp\opencode\pgsql\bin"
$env:TEST_DB_PORT = '55439'
$env:KIWIFY_TEST_POSTGREST = "$env:LOCALAPPDATA\Temp\opencode\postgrest.exe"
$env:PATH = "$env:KIWIFY_TEST_PG_BIN;$env:PATH"
corepack pnpm exec vitest run --config vitest.kiwify.config.ts --reporter=dot
```

| Recorte | Casos |
|---|---:|
| Entrada Kiwify, HTTP assinado e upgrade 0221 | 47 |
| Automações existentes: motor, CRUD de ações, texto, inscrição de follow-up | 25 |
| Kiwify → regras → mensagem → histórico (recorte final ampliado) | 25 |
| Identidade durável com barreira PostgreSQL (também no test:db do CI) | 3 |

Provas da etapa 2:

- Oito aquisições simultâneas, observadas aguardando Lock no PostgreSQL: um
  vencedor; retry não readquire; ação seguinte tem identidade independente.
- Oito execuções do motor para uma compra com duas ações: duas mensagens, dois
  requests no receiver, sem transação idle-in-transaction durante a chamada.
- Receiver HTTP recebe a intenção; destruição da conexão após receber o corpo
  produz incerteza durável. Retry não gera segundo request. Rejeição simulada é
  distinguida de preflight sem nenhum request ao receiver.
- Falha injetada na escrita de aceite após o receiver responder: resultado incerto,
  sem novo transporte. Intenção `sending` interrompida expira como incerta; a
  preparação interrompida expira como falha anterior ao envio.
- Watchdog legado não readota mensagem da intenção mesmo com metadata apagado;
  outra mensagem realmente legada serve de controle positivo e chega ao receiver.
- Condição não atendida não envia. Recusa posterior ao evento, durante o
  espaçamento ou enquanto aguarda janela impede o envio e prevalece sobre adiamento.
- Texto e template aprovado, ausente, inválido, não aprovado e texto fora da janela
  oficial; corpo renderizado, nome/idioma do template e ACK persistidos corretamente.
- Callbacks Meta e WAHA duplicados/fora de ordem conservam leitura; falha após
  aceite aparece como falha do provedor, não como entrega. ACK desconhecido não
  inventa leitura, sessão alheia não atualiza a mensagem e ACK -1 registra falha.
- Histórico consulta sob RLS, oculta outra organização e não permite apagar a
  intenção pela role authenticated. Nome atual e telefone alterado são distintos
  do destino persistido. Anonimização limpa destino e suprime PII no resultado.
- Falha anterior ao envio conserva lead/contato e atalho para conversa existente
  unívoca; filtro por estado/data, busca e paginação exercitados.

As falhas intermediárias do harness foram corrigidas: fixture de canal sem coluna
obrigatória, fixture de anonimização sem timestamp, trigger temporário de injeção
de falha e snapshot de pg_stat_activity lido dentro da própria transação de barreira.
O controle do watchdog foi corrigido para criar uma mensagem realmente sem ledger;
apagar metadata não é mais tratado como remoção da propriedade durável.

## Unitários, API, frontend e checks

- Rodada ampla em quatro shards (a monolítica excedeu 600s): **700 arquivos**,
  **7.758 testes passaram, 9 falharam e 1 falha esperada**.
- Duas falhas dessa rodada eram desta implementação: fixture antiga do sink sem
  consulta de contato e tradução de Texto livre. Foram corrigidas e os dois
  arquivos passaram em reteste (**10 casos**).
- As outras sete coincidem com as falhas já documentadas e reproduzidas na base
  durante a etapa 1: seis em `leads-import-route.test.ts` e uma na sonda de paths
  `rascunho-superado-nao-e-regravado.test.ts`. **A suíte ampla não é declarada verde.**
- Após a revisão dos caminhos de transporte, o recorte de 11 arquivos teve 144
  aprovações e uma expectativa antiga do watchdog reprovada. Corrigido o controle
  positivo, os **25 testes do ledger** passaram; os demais arquivos daquele recorte
  já estavam aprovados. O último conjunto de ledger/mapa/templates teve **109 casos**
  aprovados. A suíte ampla não foi repetida depois desses ajustes focais.
- API de histórico: manager antes de DB, GET-only, filtros inválidos, leitura sob
  identidade autenticada e erro de conexão sanitizado.
- API de templates: leitura manager limitada à sessão/organização/aprovação;
  gestão sem filtro conserva admin; papel insuficiente/ID inválido não consultam.
- UI: cinco testes de identificação, links, consulta GET, busca/filtros/paginação,
  carregamento, vazio, erro e ausência de controles de reenvio.
- `typecheck`: passou. `lint`: **zero erros**, 311 warnings no repositório.
  `lint:channels` e `lint:role-rank`: passaram após remover literal de provider
  de uma fixture de UI. `git diff --check`: passou.
- Smoke de importação (`node --test tests/unit/event-log-imports.smoke.cjs`):
  **4 testes passaram**. `release:conferir`: passou em modo somente leitura.
- Build Next de produção final: **exit 0**, 2026-09-21 01:51:42–01:53:14 UTC,
  com os últimos ajustes de guardas/consulta. TypeScript também passou no build.
  Validação de registro da spec E2E, jornadas, fragmentos e UI: **25 testes passaram**.
  ESLint focal final dos arquivos novos/alterados passou sem avisos.

## Evidência visual

`node scripts/kiwify-visual-local.mjs` usa os **componentes reais**, CSS do produto,
React Query, Edge/Playwright e API HTTP com fixtures sintéticas. Não lê ambiente de
integração nem permite navegação externa. Exercita filtros, paginação, seleção de
template aprovado e edição do parâmetro. Mede `scrollWidth <= innerWidth` em 390px
e exige ausência de pageerror. Foram capturados:

- `.superpowers/evidence/kiwify-stage-two/accepted.png`
- `.superpowers/evidence/kiwify-stage-two/failed_before_send.png`
- `.superpowers/evidence/kiwify-stage-two/blocked.png`
- `.superpowers/evidence/kiwify-stage-two/uncertain.png`
- `.superpowers/evidence/kiwify-stage-two/no_phone.png`
- `.superpowers/evidence/kiwify-stage-two/mobile.png`
- `.superpowers/evidence/kiwify-stage-two/template-editor.png`
- `.superpowers/evidence/kiwify-stage-two/preview-report.json`

**Limite dessa prova:** usa shim de Link e tradução pt-BR e dados HTTP sintéticos;
não exerce Supabase Auth, layout autenticado ou bootstrap-owner. Não equivale a
E2E de VPS fresca. A spec `tests/e2e/kiwify-history.spec.ts` foi acrescentada ao
workflow existente para testar login manager/viewer, API real, dados PostgreSQL,
filtros e navegação do CRM. Está **pendente de execução no rig completo**.

## Revisão crítica e próximo passo

Revisão corrigiu: guardas atrás de adiamento, retomada indevida após apagar metadata,
configuração local classificada como rejeição remota, perda de nome/idioma/ACK do
template, falta de corpo renderizado no registro e ausência de atalho para uma
conversa já existente em falha pré-envio. Cache do histórico é separado por org e
não reapresenta linhas antigas durante uma nova consulta.

Não há promessa de exactly-once externo, ferramenta de replay ou reconciliação ativa.
Não há versionamento imutável da regra inteira por evento: a identidade da ação é
sua posição, e edição/reordenação com evento em voo não foi homologada. As guardas
do sink também alcançam outros envios automáticos reutilizados; a regressão desses
caminhos precisa permanecer na revisão.

Próximo passo: revisar diff/migration e executar a nova spec autenticada no ambiente
isolado completo, além de resolver/confirmar as sete falhas de ambiente da suíte
ampla. Homologação externa continua pendente. Não há autorização de merge/deploy
nesta entrega.
