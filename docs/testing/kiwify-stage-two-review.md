# Revisão focal da etapa 2 — 2026-09-21

Base: `4d6d957d01766891a6eb9f4a88b4576a40b24440`. Evidências anteriores preservadas
em `kiwify-stage-two-validation.md` e `.superpowers/evidence/kiwify-stage-two/`.

## Reprodução e correção da identidade

Com PostgreSQL 15/PostgREST e receiver HTTP sintético, a regra original tinha ações
`Original A` e `Original B`. Interrompido o worker após A e antes de adquirir B:

| Mutação da regra antes do retry | Antes da correção | Com plano estável |
|---|---|---|
| Editar B | A, **Alterada B** | A, B |
| Remover A | A; B omitida | A, B |
| Reordenar B/A | **A, A** | A, B |
| Excluir regra inteira | identidade/histórico sujeitos ao CASCADE | A, B; FK NULL, identidade preservada |

0223 é forward-fix da 0222, que já foi aplicada ao ambiente isolado. Um plano privado
por evento registra as regras/ações aplicáveis antes da primeira aquisição, inclusive
quando o envio aguarda janela. INSERT/UNIQUE resolve planejadores concorrentes;
o perdedor lê o plano vencedor. Não se armazenam versões gerais da configuração.
`rule_identity` é estável mesmo após exclusão da regra; `rule_id` é apenas vínculo
navegável. A chave UNIQUE usa a identidade estável e a posição no plano.

O plano não é exposto por GET nem legível por anon/authenticated. O serviço pode
inserir e ler, mas não editar/excluir/truncar. FK composta impede evento de outra
organização. Há prova executável no test:db e registro em PROVA_PROPRIA do gate RLS.
As guardas usam dados atuais; não foi congelada autorização de consentimento.

## Cinco minutos e chamadas ainda ativas

Cinco minutos são o limiar de observação do cron existente (W-12), alinhado ao
`CRM_EVENT_REAP_TIMEOUT_MS=300000`; não são prova de morte do processo, nem concessão
de uma nova propriedade. WAHA limita requests de texto a 15s e mídia a 30s;
call_webhook limita cada tentativa a 10s. A revisão encontrou POSTs Meta sem limite
explícito e acrescentou `AbortSignal.timeout(15000)` a texto/template, pelo teto já
usado nos probes Meta e no transporte de texto. DB/LLM e pausas do processo podem
alongar a preparação; portanto não se afirma um teto universal de execução.

O teste mantém uma chamada ativa depois de o receiver aceitar, envelhece o marcador,
executa o cron e repete o evento. Continua havendo UM request. A resposta tardia
confirma a mesma tentativa e o callback de leitura posterior continua monotônico.
Preparação expirada não readquire a ação; antes da rede o CAS verifica a fase.
Anonimização pode limpar metadata, mas watchdog também consulta identidades duráveis.

## Comparação das sete falhas Windows

Nesta revisão foram executados novamente, sob o mesmo Node/preload isolado, somente
os dois arquivos implicados, no checkout-base `24a9a3b0` e na branch atual. Ambos:
18 casos, 11 passaram e **as mesmas sete falharam**, com as mesmas asserções:
seis HTTP 422/efeitos ausentes de `leads-import-route.test.ts` e o controle positivo
de paths Windows em `rascunho-superado-nao-e-regravado.test.ts`. O diff entre essa
base e a main do PR #9 nesses testes/handler de importação é vazio. Relatórios
locais: `comparison-base-all.json` e `comparison-branch-all.json`, no prefixo temporário
aprovado. Isso substitui a inferência anterior por semelhança; CI Linux permanece
a verificação da branch completa em ambiente compatível.

## E2E e limites

Checks locais posteriores à correção: baseline INSTALL/REAPPLY e atualização
0222/0223 passaram; **9 arquivos / 108 testes PostgreSQL** passaram, incluindo as
reproduções de mutação e a chamada ativa além do limiar. **6 arquivos / 99 testes
unitários focais** passaram (templates, ledger/follow-up, callbacks, API e tela).
Typecheck e ESLint focal passaram. Tipos foram regenerados pelo gerador oficial.

`kiwify-history.spec.ts` está em SPECS_PARTE_2 e não em FORA_DO_CI. Não usa test.skip
nem condição para pular: falha se o rig local obrigatório faltar. Screenshots são
anexados ao relatório Playwright, coletado pelo workflow. O resultado autenticado
e os cinco checks devem ser confirmados no SHA mais recente do PR; preview local
não os substitui. Nenhuma homologação externa ou garantia de exactly-once é afirmada.
