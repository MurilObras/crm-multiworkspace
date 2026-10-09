# Obra no Bolso: estado após 96 horas

## Escopo confirmado no código

Modo separado, opt-in e desligado por padrão em Webhooks > Obra no Bolso.
`lifecycle_enabled=true` exige contrato v2; o contrato v1 de primeiro acesso é
recusado nesse modo. O modo legado permanece disponível. Somente o administrador
configura ou lê o histórico pela API. A organização vem da integração resolvida
pelo ID da URL, nunca do corpo. A alteração não liga outros workspaces.

O produto emite `trial_started` a partir do início real do teste e
`subscription_status_checked` somente depois de 96 horas completas. Contam-se
horas corridas, incluindo sábados e domingos. O CRM não consulta Stripe/Asaas.

Contrato assinado: `X-Obra-Timestamp` em segundos UTC e
`X-Obra-Signature=v1=<HMAC-SHA256(timestamp + '.' + bytes JSON)>`, com segredo
compartilhado da integração. O corpo deve ter somente estes campos:

```json
{
  "version": 2,
  "event_type": "subscription_status_checked",
  "event_id": "4d8f203c-9528-4e6f-a781-746b991da951",
  "product_user_id": "820d31a5-1b20-48f4-babc-9f7039034765",
  "occurred_at": "2026-10-12T12:00:00Z",
  "checked_at": "2026-10-12T12:00:00Z",
  "trial_started_at": "2026-10-08T12:00:00Z",
  "name": "Contato sintético",
  "email": "test@example.invalid",
  "phone": "+5511999990000",
  "status_pagamento": "ativo",
  "em_trial": false,
  "access_enabled": true,
  "trial_ends_at": null,
  "access_expires_at": "2026-11-12T12:00:00Z"
}
```

O emissor persiste o ID e o corpo antes de enviar. A resposta que comprova
recebimento é `data.status=accepted|duplicate` com `data.event_id` igual ao
enviado. Pendência de conferência também é recebimento aceito, não confirmação
de venda. Um ID com outro corpo dá 409. A assinatura precisa ser renovada a
cada tentativa, mantendo o corpo/ID originais. Falha transitória retorna 503;
nunca se confirma recebimento parcialmente persistido.

## Decisões

| Informação confirmada | Resultado |
| --- | --- |
| Evento inicial, mesmo com `ativo` | Teste; oportunidade aberta |
| Consulta anterior a início + 96 horas | Rejeição; sem fechamento |
| Ativo, fora de teste, acesso habilitado e vigência coerente | Venda ganha, uma única atividade `demand_closed` |
| Suspenso/cancelado, acesso desabilitado, sem conversão anterior | Elegível para recuperação, oportunidade aberta |
| Ainda em teste depois de 96h, status desconhecido, vigência incoerente ou vínculo ambíguo | Conferência; sem fechamento |
| Suspensão depois de conversão paga | Suporte após assinatura; preserva venda ganha |
| Evento anterior à última consulta ou início do teste alterado | Histórico ignorado; estado atual preservado |

O vínculo exige um contato não anonimizado/não mesclado pelo telefone e e-mail
coerentes, e uma única oportunidade aberta no funil configurado. Usuário,
contato e oportunidade não podem ser reutilizados para outra identidade.
O fechamento exige uma única etapa ganha chamada `Acesso ativado`. Mudanças
de identidade são revalidadas sob locks. A integração serializa recebimentos
com alterações de configuração; desativação/segredo diferente impedem o aceite.

## Artefatos e retorno operacional

- Endpoint existente, ramificação v2: `app/api/v1/webhooks/obra-no-bolso/[id]/route.ts`.
- Classificação/validação: `lib/obra-no-bolso/subscription-event.ts`.
- Consumidor transacional: `fn_receive_obra_subscription` na migration 0230.
- Estado e recibos: `obra_subscription_states` e `obra_subscription_receipts`.
- Tela: Webhooks > Obra no Bolso > Estado das assinaturas, com paginação.
- Auditoria: `obra_access.received` com decisão/motivo; timeline da venda com `demand_closed`.
- Pendência fica visível no estado; o operador confere telefone, e-mail, funil e
  estado no produto. O botão `Consultar aplicativo novamente` reconsulta um
  snapshot assinado e tenta novamente o vínculo conservador. Não permite forçar
  associação nem fabricar conversão; a ligação ambígua continua em conferência.
- As tabelas são privadas para service role; anon/authenticated não têm acesso
  direto nem EXECUTE da RPC. Exportação LGPD inclui o estado/histórico do titular;
  anonimização remove contato/oportunidade da âncora, retendo IDs técnicos de
  deduplicação, conforme o histórico legado.

## Mensagens do ciclo (opt-in separado)

A migration 0231 armazena a habilitação por integração/workspace, número WAHA,
fluxo de recuperação e três regras internas de uma única mensagem. O editor da
aba Obra no Bolso configura cadastro (+2h), uso (+48h) e confirmação única.
O texto aprovado de confirmação inclui orientação para responder no mesmo
contato para suporte. Campo vazio desativa aquela mensagem. As regras internas
não têm um segundo editor na aba Automações; escritas diretas por JWT são negadas.
Os três textos são persistidos na integração independentemente do canal. Salvar
com envios desligados e sem número, ou retirar o número, preserva a personalização;
as ações permanecem vazias e inativas até escolher um canal. A migration 0232
preserva textos antigos e campos vazios sem reativar mensagens na atualização.

O início real agenda no `event_log` no máximo dois cuidados. Um registro único
por estado/fase impede novo envio por reconsulta/replay. Cadastro vencido em
+48h é descartado; uso vencido no término do trial/96h também. Não há backfill
de congratulação anterior à configuração. A primeira conversão agenda um único
evento de confirmação. O transporte existente usa uma intenção durável e nunca
repete uma tentativa que possa ter chegado ao provedor sem confirmação.

Todos estes proativos esperam segunda–sexta 08h–20h America/Sao_Paulo.
Recebimento continua 24h. Antes de processar e imediatamente antes do transporte,
o CRM consulta `https://api.obranobolsoai.com/api/v1/crm/subscription-status`,
origem fixa usada pelo frontend do produto, sem redirecionamento ou URL livre.
HMAC de consulta `lookup.timestamp.corpo`; resposta `snapshot.timestamp.corpo`,
chave exclusiva já cifrada da integração, sem tokens de suporte/N8N.
O snapshot precisa corresponder ao UUID do produto e estar dentro de 2 minutos.
Falha não autoriza uso do estado antigo. A guarda SQL no CAS revalida
workspace, contato, oportunidade/funil, etapa, fase, calendário, recusa,
resposta posterior ao início da fase e silêncio por humano.

Se a consulta imediatamente anterior ao transporte falhar por rede/timeout,
HTTP 408/425/429 ou 5xx, a mensagem permanece `queued/prepared`; sua intenção
fica `pending/adiado` e o consumidor reagenda pelo mecanismo existente. A
retomada consulta novamente e usa o mesmo ID, texto e intenção, sem gerar
outra mensagem. A Atividade informa que a consulta de assinatura está
temporariamente indisponível. Falha de autenticação, integração desligada,
chave inválida ou snapshot não confiável não vira essa espera. Nenhuma falha
depois de `started` permite reenvio automático; a incerteza continua terminal.
Cobertura: `tests/unit/obra-outreach-retry.test.ts` prova duas falhas antes da
recuperação, bloqueio/humano posterior e ausência de repetição; as guardas
comerciais e de calendário usam as provas SQL reais da suíte de invariantes.

Recuperação libera a tag `followup_assinatura` uma única vez após
`recovery_started_at + 2h`, somente em não convertido, consultado após 96h.
O fluxo existente deve estar publicado, habilitado no agente e condicionado
à tag. Seu worker e a guarda final só permitem recuperação no pointer escolhido.
Pagamento posterior, resposta ou humano impedem o envio mesmo já preparado.
Outros contatos/workspaces e turnos recebidos não consultam o Obra no Bolso.
O contrato v2 remove a tag quando o estado deixa de justificar recuperação.

## Gates de ativação comercial

O fechamento pode emitir o evento genérico `lead.won` do próprio CRM; regras
genéricas já ativas nesse evento precisam ser revisadas antes de ativar a conexão.
Validar em banco real concorrência, replays e permissões, e evidência visual
do editor. Publicar ambos os PRs/migrations e provar a comunicação assinada real
na VPS, incluindo Redis do aplicativo e worker/Beat. Exercitar o ciclo com
contatos de teste antes de habilitar envios comerciais. Não há alteração de
configuração, chave ou mensagem de cliente em produção neste PR.
A regra de parabenização v1 não serve como fallback do contrato v2.

Sem teste end-to-end, texto personalizado aprovado, publicação nas duas VPS e
validação com contatos controlados, manter emissores, conexão e agentes desligados.

## Validação e ambiente

O computador não tem Docker. O usuário escolheu validar o banco descartável e
a UX pelo CI já existente no GitHub em vez de instalar Docker localmente.
Isso substitui o local exigido pela doutrina do repositório; nenhum banco de
produção é usado como ambiente de teste. PGlite local prova a migration em
fixture reduzida, não concorrência nem todos os triggers do baseline.
O harness `test:db` no CI valida o baseline em instalação/atualização,
concorrência real, isolamento e privilégios. A spec `webhooks` existente traz
uma prova visual com respostas sintéticas de UI; não comprova transporte.
Checks novos devem estar verdes antes de merge/publicação. PR antigo verde não
é prova desta alteração. Os workflows/proteções não foram modificados.

Os contratos de `lib/database.types.ts` deste domínio foram gerados por
`@supabase/postgrest-typegen@0.4.0`, motor oficial de geração do Supabase.
A introspecção executou as migrations 0229/0230/0231/0232 sobre a fixture PGlite de
`tests/unit/obra-subscription-migration.test.ts`. Foram incorporados por AST
somente os seis contratos `obra_*` e as treze RPCs `*_obra_*`, incluindo
nullabilidade, defaults e relacionamentos. Os demais contratos preexistentes
foram preservados; nenhum campo ou assinatura foi escrito à mão. Isso não
substitui a aplicação/reaplicação do baseline nem a prova RLS no CI.
