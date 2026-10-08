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
  estado no produto. Ainda não há reconsulta/associação administrativa v2.
- As tabelas são privadas para service role; anon/authenticated não têm acesso
  direto nem EXECUTE da RPC. Exportação LGPD inclui o estado/histórico do titular;
  anonimização remove contato/oportunidade da âncora, retendo IDs técnicos de
  deduplicação, conforme o histórico legado.

## O que ainda impede a ativação comercial

Este receptor **não envia** os dois contatos de cuidado, parabenização ou
recuperação, nem adiciona a tag de recuperação. Remove a tag
`followup_assinatura` quando o estado deixa de justificar recuperação.
O fechamento pode emitir o evento genérico `lead.won` do próprio CRM; regras
genéricas já ativas nesse evento precisam ser revisadas antes de ativar a conexão.

A próxima implementação precisa conectar o início real a dois contatos no
máximo (+2h e +48h), a confirmação paga a uma mensagem personalizada única, e
a recuperação ao fluxo existente, respeitando respostas, recusas e atendimento
humano. Os proativos devem operar apenas segunda–sexta, 08h–20h em
America/Sao_Paulo; atendimento recebido continua 24h. A função pura da janela
está testada, mas ainda não governa o envio. Não anunciar essa restrição como
ativa antes de integrá-la ao consumidor e à guarda final do transporte.

Mensagens adiadas precisam de informação atual do produto antes do envio;
o evento de 96h, sozinho, não prova que a situação continua igual na segunda-feira.
Será necessário concluir uma reconsulta restrita do backend, ou mecanismo
equivalente de atualização atualizada, sem expor a chave de suporte do aplicativo.
A regra de parabenização v1 não serve para os eventos v2 e não deve ser reutilizada.

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
