# Kiwify → CRM: entrada, etapa 1

Data: 2026-09-20. **Entrada validada nos cenários PostgreSQL/HTTP descritos no [relatório de validação](../testing/kiwify-validation-2026-09-20.md); integração não homologada.**

## Contrato oficial confirmado nesta sessão

- [Central de ajuda](https://ajuda.kiwify.com.br/pt-br/article/como-funcionam-os-webhooks-2ydtgl/): JSON, seleção de produto/eventos, teste/logs/reenvio; afiliados podem não receber dados pessoais.
- [Webhooks pt-br](https://www.notion.so/kiwify/Webhooks-pt-br-c77eb84be10c42e6bb97cd391bca9dce): consultado em navegador (Edge/Playwright). O fetch textual só mostrou a página de JavaScript; não foi usado como prova do protocolo.
- [Criar webhook na API](https://docs.kiwify.com.br/api-reference/webhooks/create.md) e [índice oficial](https://docs.kiwify.com.br/llms.txt): cadastro com token/produtos/triggers. Os triggers de cadastro em português não são os valores do payload recebido.

O exemplo JavaScript oficial calcula `createHmac('sha1', secret).update(JSON.stringify(order)).digest('hex')`, com `order = JSON.parse(req.body)`. Portanto os bytes assinados são UTF-8 da serialização JavaScript do objeto integral, **antes** de Zod, trim, seleção de campos ou normalização. Espaços/escapes/números do JSON HTTP são reserializados pelo contrato, não preservados literalmente. Não há ordenação de chaves nem tentativa alternativa com corpo bruto. A query deve conter exatamente uma `signature`, 40 caracteres hex minúsculos; comparação com `timingSafeEqual`. Segredo ausente ou indecifrável bloqueia.

POST deve receber 2xx; sem 2xx são até cinco reenvios, timeout de 40 segundos. Não há intervalo exato de retry confirmado, nem garantia de respeito ao `Retry-After`. HEAD é apenas sonda 200, sem persistir ou processar pedido.

## Diagnóstico no código original

`lib/webhooks/inbound.ts` só mapeia strings de topo e descarta `Customer`/`Product`. Sua assinatura é SHA256/header sobre raw body. A rota genérica deduplica `external_id`, não `order_id`, e não filtra evento/status Kiwify. `createLeadHandler` cria lead e chama `emit_event` separadamente, sem transação e sem propagar erro da emissão. `event_log` já tem worker, claim e recuperação; não foi criada fila nova.

## Configuração

Pré-requisitos em **ambiente isolado**: baseline atualizado com migration
`20260920120000_0220_kiwify_ingestion.sql` e a forward-fix
`20260920220000_0221_kiwify_consent_privacy_actor.sql`, chave da cifra existente
`app.nuvemshop_oauth_key`, funil/etapa e produtos no `catalog_products` da organização.
Migration também está no apêndice do baseline, antes da varredura final de privilégios,
e no MANIFEST. Nenhuma migration foi aplicada em produção.

`POST /api/v1/integrations/kiwify`, sessão autenticada com papel manager ou superior:

```json
{
  "name": "Kiwify teste",
  "store_id": "loja-configurada",
  "secret": "TOKEN-SINTETICO-SUBSTITUIR",
  "pipeline_id": "UUID-DO-FUNIL",
  "stage_id": "UUID-DA-ETAPA",
  "products": [{ "external_product_id": "ID-EXATO-KIWIFY", "product_id": "UUID-CATALOGO-INTERNO" }]
}
```

Os placeholders UUID devem ser substituídos por UUIDs válidos de teste. Resposta 201
inclui `integration_id` e `endpoint`. Usar esse endpoint com origem HTTPS no cadastro
Kiwify, produto exato e evento Compra aprovada. O segredo nunca volta na resposta.
A identidade do usuário autenticado é enviada pelo servidor como `p_actor_user_id`
à RPC e registrada em `api_audit_log.actor_user_id`. Não é campo do payload público.
A RPC exige ator ativo manager/admin da organização; sua antiga assinatura sem
ator foi removida pela 0221 e continua indisponível a anon/authenticated.
`GET /api/v1/integrations/kiwify` retorna configurações sem ciphertext, mapeamentos e
últimos 20 receipts (inclusive contador de conflitos), sempre da organização autenticada.

Configuração nesta etapa é por API, sem editor dedicado. Uma integração por
organização/loja; `store_id`/identidade são imutáveis pelo contrato operacional.
Não há endpoint de alteração/rotação nesta etapa. Não apagar ledger nem recriar a
identidade para reprocessar: isso invalida a proteção de retries.

Segredo usa `encryptWebhookSecret`/`decryptWebhookSecret`, a cifra já existente.
Configuração Kiwify tem tabela/token separados de `webhook_sources`: seu token não
resolve na rota genérica, cujo HMAC opcional não serviria como segunda porta segura.
Organização vem da configuração, loja vem dessa mesma linha. `store_id` do payload
é apenas conferência: divergência é inválida, nunca troca o tenant.

## Domínio e política de dados

- Apenas `order_approved` + `paid` + ID de produto mapeado e ativo cria lead.
- FK composta `(organization_id, product_id)` impede mapear produto de outro tenant.
- Nada é associado por nome. Nome do produto externo é validado, mas descartado.
- IDs limitados a 128 caracteres ASCII alfanuméricos/`_`/`-`; nome 200, email 254,
  telefone 40; corpo HTTP limitado em stream a 256 KiB e UTF-8 válido.
- Objetos/valores com tipos errados ou acima do limite: 400. Campo pessoal vazio,
  email sintaticamente inválido, telefone fora do formato aceito: normalizado para null.
  Telefone é validação estrutural, não prova de existência de conta WhatsApp.
- Nome ausente/inválido: título `Compra Kiwify`, contato novo `Comprador Kiwify`.
- Sem telefone válido: lead sem vínculo de contato, título impessoal `Compra Kiwify`
  e **nenhum `lead.created`** na fila. Nome/email do comprador não são copiados para
  o lead, captura ou auditoria; nem e-mail coincidente autoriza usar telefone antigo.
  Estado `accepted_no_phone`. A 0221 também repara títulos órfãos criados pela 0220.
- Contato ativo com telefone/variante brasileira reconhecida pelo helper existente é reutilizado sem atualizar nome, email,
  consentimento, bloqueio ou flags. Email que aponta para outro contato é
  `contact_identity_conflict` e não cria lead. Contato anonimizado também é recusado
  sem novo lead; bloqueado pode ter lead, mas não emite evento. Recusa explícita
  em `consent.marketing.declined_at` também suprime o evento na transação, com motivo
  `consent_declined` no receipt, captura e auditoria, inclusive após retry. A semântica
  é a da guarda existente: ausência de concessão não equivale a recusa. O consentimento
  não é atualizado pelo pedido. Outras guardas existentes continuam aplicáveis.
- Não fabrica consentimento. Não autoriza IA nem executa drain/envio no request.
- Ledger guarda identidade/fingerprint/estado e vínculos, sem payload bruto nem nome,
  email ou telefone em claro. Fingerprint e IDs externos são dados de rastreabilidade
  pseudonimizados; não se afirma anonimização absoluta desses identificadores.
  Histórico de captura existente recebe correlação, sem cópia dos dados pessoais.
  Logs do aplicativo não recebem corpo, segredo, assinatura ou URL; scrub do Sentry
  também remove corpo/query nas duas entradas Kiwify. O proxy externo precisa omitir
  query dos access logs antes de qualquer uso real; isso não foi homologado nesta etapa.

## Transação, retries e conflitos

`fn_ingest_kiwify` executa via RPC somente com service_role (EXECUTE revogado de
PUBLIC, anon e authenticated; security invoker). A linha de configuração é bloqueada
com `FOR UPDATE`, serializando pedidos da mesma integração. O banco também impõe
UNIQUE `(organization_id, integration_id, order_id, event_type)`.

`external_id = kiwify:<UUID integração>:<order_id>` chega ao lead e ao payload/metadata
de `lead.created`. UUID da integração distingue lojas e organizações; o tipo do evento
faz parte da chave do ledger. Eventos diferentes ficam separados, sem virar novas compras.

Contato, lead, `emit_event` existente, captura, ledger e audit pertencem à mesma
transação. Falha em qualquer escrita desfaz todas. A rota só responde 2xx depois
da RPC concluída; queda após commit é resolvida pelo retry que encontra o ledger.
Concorrência entre fontes diferentes sobre contato novo pode gerar unique violation:
503 sem commit parcial, retry refaz a transação. Não é convertido em sucesso falso.

Fingerprint SHA256 cobre o objeto normalizado de decisão (pedido, evento, status,
produto, nome/email/telefone válidos e loja declarada); não inclui campos descartados
como timestamps/CPF/IP. Mesma identidade com fingerprint diferente incrementa
`conflict_count`, devolve 409 e preserva original. Não há replay automático de receipts
ignorados quando o mapeamento muda posteriormente. Ledger não tem expurgo automático:
apagar sua linha remove a memória durável da deduplicação.

| HTTP | Estado/desfecho | Política |
|---|---|---|
| 200 | accepted / accepted_no_phone | Persistência concluída |
| 200 | duplicate + original_status | Sem novo lead/evento |
| 200 | ignored | Evento/status/produto não permitido, ledger durável |
| 400 | invalid | Corpo/tipos inválidos; inconsistência de loja/contato tem ledger |
| 401 | assinatura ausente/inválida/malformada | Sem mutação de domínio |
| 404 | token inválido/inativo | Sem processamento |
| 415 | tipo de conteúdo inválido | JSON obrigatório |
| 422 | configuração incompleta | Corrigir configuração; não confirma evento |
| 409 | conflito material | Inspeção, sem sobrescrever original |
| 429 | limite | Retry-After 60; sem confirmar evento |
| 503 | cifra/banco/erro transitório | Sem confirmação; retry Kiwify |

Kiwify pode repetir também 4xx, pois o contrato é por ausência de 2xx. Retry de um
`invalid` já registrado retorna `duplicate` com `original_status=invalid` e interrompe
as repetições sem criar efeitos. Inválido sem identidade validada não cria ledger.

## Revisão e limitações

- Reuso é no domínio/persistência/consumidor: contatos, leads, captura, audit e
  `emit_event`. Não foi chamado o handler HTTP genérico por dentro da nova rota:
  sua sequência de chamadas PostgREST não oferece atomicidade. Contrato genérico intacto.
- UNIQUE, concorrência, FK/RLS, permissões efetivas e rollback foram exercitados em
  PostgreSQL 15.18 portátil com pgvector 0.8.1 e prelude do script oficial: 24
  invariantes aprovados. Oito sessões simultâneas foram observadas esperando lock.
- Baseline install/reapply e schema-base + migration/reapply passaram; catálogos
  relevantes coincidiram. `lib/database.types.ts` recebeu os cinco blocos Kiwify
  emitidos pelo gerador oficial Supabase, conferidos sem diferenças com a saída.
- A suíte ampla terminou em quatro shards: 7.747 passaram, 7 falharam e 1 falha
  esperada; as sete falhas foram reproduzidas no checkout-base no mesmo ambiente.
- Handler de produção, cliente Supabase, PostgREST e banco reais passaram em cinco
  testes HTTP. Posteriormente o build Next standalone também passou e serviu o
  endpoint real em modo produção, incluindo proxy e bundle: compra válida, retry,
  assinatura inválida, reembolso e pagamento pendente. Não é prova visual de UX.
- O comando Docker `test:db` completo continua indisponível, embora o recorte Kiwify
  rode em PostgreSQL real pela configuração nativa. O bloqueio de IPC do harness de
  build foi corrigido; build final saiu 0 em ~194 s. UI/E2E e imagens Docker
  permanecem pendentes; o relatório diferencia política documentada de proteção do fork.
- Variantes brasileiras com/sem nono dígito usam `phoneLookupVariants`. Se houver
  mais de um contato ativo correspondente, recusa por conflito de identidade;
  não escolhe silenciosamente um cadastro que poderia contornar opt-out do outro.
- O worker existente pode repetir efeitos após falha; esta etapa **não garante envio
  único no provedor WhatsApp**. Não implementa replay, templates ou homologação real.

### Sistema vivo

Entrada: rota autenticada e API manager. Saída: `event_log` → automation engine já
registrado. Visibilidade: tela existente Leads recebidos via `webhook_lead_captures`,
mais GET para estados completos. Recuperação: 503/rollback/retry do emissor; depois do
commit, retry/reaper do drain existente. Laço de retorno: conflito incrementa contador
observável, sem apagar original. Não há tela nova nem item de navegação novo.
Mapa: `docs/architecture/kiwify.architecture.json`.

## Histórico da primeira tentativa (superado pelo relatório de validação)

Comandos executados via `corepack pnpm` (pnpm 9.15.9, Node 24.16.0 disponível;
repositório exige Node >=22). Testes usam preload temporário fora do repositório
para impedir leitura de `.env`/`.env.local` reais e bloquear egress externo.
Nenhum provedor/automação real foi chamado.

- `typecheck`: passou.
- `lint`: zero erros, 311 warnings no repositório; lint focal dos arquivos alterados
  passou sem avisos.
- `lint:channels`, `lint:role-rank`: passaram.
- `release:conferir`: passou em modo somente leitura; nenhuma release criada.
- Recorte focal final: **6 arquivos / 140 testes passaram**, incluindo paridade
  migration/baseline e a posição do hardening.
- Primeira execução completa `test:unit`: 681 arquivos passaram, 16 falharam;
  7.692 testes passaram, 51 falharam, 1 falha esperada. O preload inicial também
  bloqueava templates `.env.example` e receivers HTTP locais. O erro desta mudança
  no gate de posição da varredura anon foi corrigido e revalidado.
- Segunda tentativa completa com preload ajustado: interrompida pelo limite de
  600 segundos, sem resumo final. Apresentou falhas nos testes de transporte local
  sob bloqueio de rede, WSL/grep indisponíveis, sondas de paths/timeout e
  `leads-import-route`. Não se atribuem todas as falhas a defeitos preexistentes:
  não houve execução comparativa da main isolada neste ambiente.
- `test:db`: bloqueado antes de subir PostgreSQL; não executou nenhum dos novos
  invariantes de unicidade, concorrência, atomicidade ou RLS. Não substituir essa
  prova por mocks. O smoke posterior ao Vitest em `test:unit` não foi alcançado
  pelo script; executado separadamente com `node --test
  tests/unit/event-log-imports.smoke.cjs`: **4 testes passaram**.
- `git diff --check`: passou.

Na primeira tentativa, a revisão crítica corrigiu separação de tokens da rota genérica, ordem do hardening
do baseline, variantes de telefone/opt-out, recusa de contato anonimizado, limite
do stream e sanitização de corpo no Sentry. A matriz PostgreSQL, baseline e regressão
ampla foram posteriormente executados; veja resultados e pendências no relatório.
