# Kiwify — correção de anonimização do plano (0224)

## Distribuição e ambiente

Em 2026-09-21, antes do push desta correção, o PR #10 estava OPEN/draft,
HEAD `2e75dc99f4d282c76b1cb13cafec36de70724ed5`, dois commits à frente da main,
nenhum atrás e sem merge. Os runs de imagem da branch eram `pull_request`
(`35587820280`, `35555148271`), portanto sem publicação. A release mais recente
era `v2.0.0`, anterior à etapa 2; a API de deployments retornou `[]`.
Isso comprova ausência de distribuição pelo fluxo do repositório, não ausência
de instalação manual externa. Não houve acesso ao banco de produção, deploy,
mensagem real ou compra real nesta correção. Todas as aplicações foram no
PostgreSQL 15.18 descartável marcado do harness, com PostgREST 16.3/receiver local.

## Contrato e alcance

- `subject_contact_id` tem FK composta com organização. A recuperação consulta
  entidade do evento → lead/contato/mensagem, receipt → lead, vínculos explícitos
  de lead, receipt → captura (lead ou receipt UUID), run → mensagem e run → inscrição.
  Não depende da existência da regra, de telefone atual, de regex ou de texto livre.
- Plano válido continua executável após excluir a regra. O vínculo já congelado
  prevalece nas leituras seguintes, mesmo que outras relações sejam apagadas.
- Anonimização elimina **todo** `rules` (nomes, condições, ações e configurações),
  não apenas padrões de PII. Preserva org/evento, identidade dos runs e timestamps
  `redacted_at`/`plan_redacted_at`. Repetição não reverte o marcador.
- Backfill alcança contatos já anonimizados. Somente **zero titulares recuperáveis**
  neutraliza um órfão. Mais de um candidato distinto gera
  `automation_plan_subject_ambiguous`: não apaga nem escolhe um titular ao acaso.
- Decisão autorizada: **o conteúdo removido não poderá ser executado novamente**.
  Restaurar um vínculo, editar/recriar regra ou repetir o evento não restaura o plano.
  `[]` é um plano existente, diferente de `null`; não existe replay neste PR.
- Há limites históricos: registros e vínculos já expurgados não podem ser
  reconstruídos. O tombstone não identifica retrospectivamente seu titular perdido.
  Não se afirma recolher dados já enviados ao provedor nem conteúdo em backups.
- O export LGPD existente alcança os planos vinculados ao titular e os estados de
  seus runs, com filtro de organização. Projeta textos/parâmetros de mensagem;
  não entrega URLs, headers, segredos ou a regra executável. Mantém o limite de
  500 registros usado pelo coletor. Órfãos não são atribuídos a uma pessoa no export.

## Concorrência e runtime

Criação do plano e aquisição usam o contato como fence transacional. A checagem
relê o plano depois de obter esse lock. A anonimização modifica o contato e limpa
planos/runs/mensagens na mesma transação. O motor verifica o plano antes de iniciar
uma ação; o sink verifica antes do transporte, inclusive mensagens correlacionadas
por inscrição/job/ledger. O envio direto repete a guarda no CAS. Cada tentativa
HTTP de `call_webhook` revalida o plano, inclusive depois da espera de retry.

A autorização de início é um statement curto. **Não há transação aberta durante
rede.** Uma operação já autorizada/em voo pode completar; não há promessa de
cancelamento atômico entre banco e provedor. Resposta tardia pode confirmar a mesma
tentativa, mas triggers retiram texto/metadata pessoal e a atualização de preview
usa a mensagem persistida sob o fence, não o input antigo em memória.

## Provas

- Teste vermelho anterior: RPC LGPD real após envio/exclusão de regra deixava nome
  e telefone sintéticos em `rules`. Esse mesmo caso passou com 0224.
- `tests/invariants/kiwify-plan-privacy.test.ts`: exclusão da regra, marcador
  irreversível, órfão mesmo após recuperar vínculo, tenant alheio, backfill 0223,
  reaplicação e corridas com freeze/acquire/start em conexões PostgreSQL distintas.
- `tests/invariants/kiwify-automation.integration.ts`: RPC real, parâmetros literais,
  retry sem transporte, snapshot durante pacing, envio ativo/aceite tardio sem
  restaurar preview e sem aguardar rede, receiver de webhook e recuperação histórica.
- `scripts/kiwify-stage-two-db.mjs`: baseline install/reapply e main + 0222–0224/reapply;
  compara colunas, constraints, funções e ACL. Tipos regenerados oficialmente por
  `@supabase/postgrest-typegen`, não editados à mão.
- Rodada nativa ampla: **125/125, 11 arquivos**; recorte final com duas novas
  regressões: **45/45, 2 arquivos**; controle adicional de vínculo conflitante:
  **1/1**, total de 128 cenários distintos verificados.
- Unitários completos em quatro shards: **701 arquivos**, 7.765 passed,
  1 expected fail e 8 failed. Sete são as falhas Windows já comprovadas na base;
  a oitava apontou a ausência dos planos/runs no export, corrigida nesta rodada.
  Reexecução focal de LGPD/projeção/PDF após a correção: **11/11, 3 arquivos**.
  A execução monolítica anterior excedeu 600s e não conta como suíte concluída.
- Lint: zero erros (311 avisos existentes); typecheck passou. Resultados posteriores
  e checks do SHA publicado devem ser registrados no PR; checks do HEAD anterior
  não aprovam esta correção.
- CI de `abc5b00f`: verify/build/imagens passaram; invariants apontou que o
  instrumento de cobertura LGPD ignorava triggers. A sonda passou a consultar os
  triggers de redação ativos de UPDATE em `contacts`, além da RPC. Removidas três
  dispensas legadas já cobertas por triggers; nenhuma dispensa nova foi criada.
  Reexecução local do gate corrigido: **6/6** contra PostgreSQL real.

## Integração no sistema existente

Entrada: RPC/endpoint de anonimização atualizam `contacts.is_anonymized` → trigger
0224. Saída: plano vazio e marcadores duráveis → fences do motor/sink. Rastro:
identidades e estados em `automation_rule_runs`, consultados no histórico Kiwify;
auditoria LGPD continua na cascata existente. Laço de retorno: retries reencontram
o tombstone e não readquirem nem replanejam. A tela existente continua somente
consulta. O E2E autenticado do histórico é executado no CI; receiver local não é
prova de interface autenticada.
