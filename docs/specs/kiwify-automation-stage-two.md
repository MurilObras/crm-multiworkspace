# Kiwify → automações → mensagens: etapa 2

Base: PR #9, `4d6d957d01766891a6eb9f4a88b4576a40b24440`.
Implementação em PR rascunho, sem release ou implantação pelo fluxo do repositório. Evidências e limites em
[validação da etapa 2](../testing/kiwify-stage-two-validation.md).

## Componentes e contrato

**CONFIRMADO pelo código:** a entrada não envia. `fn_ingest_kiwify` continua criando
`lead.created` na transação da compra. `automationRulesHandler` e o drain existentes
consomem esse evento; somente regras ativas cujo gatilho e condições correspondem
são executadas. O motor confirma o vínculo com `kiwify_receipts` antes de executar
um evento identificado como Kiwify. Não foi criada outra fila ou motor.

`automation_rule_runs` passa a guardar uma linha por ação Kiwify, adquirida antes
do efeito. O índice único contém organização, evento, regra e **posição da ação no
array**. Configurações com duas ações iguais em posições diferentes continuam tendo
duas ações. Runs antigos e adiamentos permanecem no formato agregado (posição NULL).
Não há backfill que tente inferir envios antigos a partir de texto ou telefone.

A aquisição usa INSERT/ON CONFLICT no PostgreSQL; o vencedor pode executar, os
outros não. O UUID do run é também o UUID da mensagem direta e sua chave de intenção.
A transição `preparing → sending` ocorre por CAS, com guardas atuais do contato;
a chamada ao adapter acontece **depois de encerrar o statement**, sem transação
de banco aberta durante a rede. As escritas de resultado verificam a fase atual.
As fases `prepared/started/rejected/uncertain` do sink existente são reutilizadas.

`send_ai_message` usa o mesmo wrapper de envio. `start_message_flow` usa
`enrollFollowupFlow`, vinculando a inscrição ao run com FK tenant-aware e UNIQUE.
As mensagens do fluxo continuam sob `job_queue`/`send_ledger` e o protocolo de lease
existente; o histórico as alcança por inscrição → job → ledger → mensagem.

## Configurar a regra

Pré-requisitos: migrations 0220–0225 (também no baseline), conexão PostgreSQL
do servidor em `SUPABASE_DB_URL`, drain e scheduler existentes, canal configurado
e modelos oficiais já sincronizados quando necessários. Nada configura ou ativa
uma integração/canal automaticamente.

Em **Webhooks › Automações**, use `lead.created` e condições explícitas:

```json
[
  { "field": "event.kiwify_event_type", "op": "eq", "value": "order_approved" },
  { "field": "event.product_id", "op": "eq", "value": "UUID-DO-PRODUTO-INTERNO" }
]
```

Use o modo avançado das condições para informar esses paths existentes do motor.
Não selecionar uma condição
significa conservar o comportamento existente de casar outros eventos do gatilho.
Para enviar texto em canal que o permite:

```json
{
  "type": "send_whatsapp_message",
  "config": {
    "channel_session_id": "UUID-DO-CANAL",
    "template": "Olá {{nome}}, recebemos sua compra."
  }
}
```

No editor da ação, escolha **Template aprovado** para usar a definição oficial:
o seletor lê somente modelos aprovados do canal escolhido e deriva os campos do
contrato existente. O GET de templates filtrado por sessão aceita manager; gestão
sem filtro e sincronização continuam exigindo admin. Exemplo do contrato salvo:

```json
{
  "type": "send_whatsapp_message",
  "config": {
    "channel_session_id": "UUID-DO-CANAL",
    "template_name": "confirmacao_compra",
    "template_language": "pt_BR",
    "template_values": { "1": "{{nome}}" }
  }
}
```

Os placeholders UUID são substituídos por IDs válidos da organização. Parâmetros
de cabeçalho/botão/carrossel usam `slotKey`, o mesmo endereçamento do montador
existente. O backend revalida aprovação, presença, parâmetros e canal; falta de
espelho ou erro de leitura bloqueiam **envio automático**. O comportamento do
envio manual não foi relaxado. Template obrigatório nunca é substituído por texto.

## Guardas e desfechos

O plano tem vínculo durável ao titular e tombstone irreversível. Anonimização apaga
todo o conteúdo executável; só planos comprovadamente sem titular recuperável são
neutralizados pelo backfill. Excluir uma regra não neutraliza plano válido.
Conteúdo removido nunca é replanejado/executado por retry, mesmo se vínculos forem
restaurados. Contrato de concorrência, limites e provas da migration 0224:
[anonimização do plano](../testing/kiwify-plan-privacy.md).

Nos dois caminhos de atualização (baseline e arquivos em ordem cronológica), a
própria 0224 instala a guarda **antes** do seu backfill atômico. A 0225 a reafirma
na posição normal, sem antecipação manual. Recuperação malsucedida não autoriza
descarte por NULL: conflito desfaz o bloco e preserva o lote mesmo quando o psql
continua após o erro.

- Contexto Kiwify é relido por ação. Recusa explícita, bloqueio, anonimização e
  destinatário inexistente impedem o efeito. A ausência de concessão não foi
  reinterpretada como recusa: vale a política já estabelecida na etapa 1.
- O sink revalida contato/organização, identidade, conversa, canal e janela antes
  do transporte automático, incluindo follow-up. Identidades LID dos outros fluxos
  continuam disponíveis: não se passou a exigir telefone para todo inbound da IA.
- O envio direto repete janela configurada e limite diário antes do CAS. A política
  de pacing/throttle existente permanece a autoridade.
- Configuração que deixa o sink em queued é registrada como bloqueio na ação direta;
  não se apresenta uma mensagem como aguardando um retry que não acontecerá.
- Erro anterior à rede é separado da rejeição comprovada pelo adapter. Timeout/erro
  após o início possível do transporte é incerto. Sem ID retornado também não há
  aceite confirmado.
- O cron existente `recover-stuck-messages` encerra intenções `preparing/sending`
  sem atualização há cinco minutos: respectivamente falha anterior ao transporte
  e incerteza. Não consulta o provedor nem reenvia. Uma resposta tardia com ID pode
  confirmar a mesma tentativa; não cria uma nova.
- Callbacks continuam atualizando `messages`. A leitura usa esse estado atual,
  incluindo falha posterior ao aceite. O ACK do WAHA agora é condicionado por
  organização, sessão, direção e avanço de ACK; duplicatas não rebaixam leitura.
- O watchdog legado exclui mensagens com `outbound_attempt/idempotency_key`; retries
  do evento não readquirem a ação. O protocolo de follow-up existente continua
  recusando retentativa incerta. **Não há garantia de envio único no provedor.**

Documentação oficial consultada em 2026-09-20/21:
[WAHA Events / message.ack](https://waha.devlike.pro/docs/how-to/events/#messageack).
ACK 1 é servidor; 2 é dispositivo; 3 é leitura; -1 indica erro. Retorno HTTP com ID
não foi convertido em confirmação de entrega. As regras oficiais de template e
janela reutilizam o contrato implementado em `lib/channels/`.

## Consulta e privacidade

**Webhooks › Kiwify** (`/app/webhooks`) e
`GET /api/v1/integrations/kiwify/history`, manager/admin da organização ativa.
GET validado por Zod, parâmetros SQL vinculados e transação de leitura sob papel
`authenticated` e identidade da sessão: os joins respeitam RLS e organização.

Campos: compra, fase de entrada, lead, nome atual, telefone informado na tentativa
e telefone atual separados, produto interno, regra/ação, canal, tentativa, última
atualização, situação e motivo legível. Links apenas para lead, contato e conversa
que existem e são visíveis. Não associa por nome, email ou aproximação de telefone.
Nome é lido do cadastro atual. O telefone da tentativa fica no registro de transporte
existente (`messages.metadata`), não num cadastro paralelo para alimentar a tela.
A anonimização remove esse telefone por trigger; a consulta também suprime nome,
telefone, título pessoal e ID de provedor do contato anonimizado.

Busca por compra/nome/telefone; período da compra em UTC; situação; paginação de
20 linhas (API até 100). Ausência de dados, carregamento, vazio e erro são explícitos.
Não há reenvio, cancelamento, edição de execução ou alteração de consentimento.

Incerteza: **“Confira a conversa antes de enviar manualmente: o cliente pode já ter recebido.”**
Recusa: **“O contato recusou o consentimento. Envio bloqueado.”**
O segundo caso não recomenda reenvio. Compra recusada/ignorada na entrada fica
separada da ação de mensagem; sem evento/ação não se inventa tentativa.

## Sistema vivo e limites

Entrada: receipt/event_log. Saída: executores existentes → sink → adapter.
Log: automation_rule_runs/messages e auditoria de falhas. Porta: aba na tela Webhooks.
Anti-morte: classificação passiva no cron existente. Retorno: callbacks alteram a
situação consultável e a intenção durável impede repetição; o humano tem cadastro
e conversa disponíveis para avaliar o atendimento. Nenhuma nova rotina de recuperação.
Mapa: `docs/architecture/kiwify.architecture.json`.

Identidade da ação é sua posição no **plano imutável do evento**, não na regra atual.
A migration 0223 guarda o conjunto de regras/ações aplicáveis antes da aquisição,
em `automation_event_plans`, privado ao servidor. O primeiro planejador vence;
retries leem o mesmo conteúdo, inclusive após editar, remover ou reordenar ações.
Edições de regras valem para eventos ainda não planejados. Excluir a regra não apaga
o run: `rule_identity` conserva a identidade e a FK navegável vira NULL. O plano
não contém uma fotografia dos dados do contato; guardas e destinatário são relidos.
Não existe catálogo geral de versões, endpoint de replay ou edição de planos.
Tentativas adquiridas não são reabertas por correção posterior de configuração.
As normalizações de endereço continuam pertencendo ao adapter.
Validação externa, instalação completa com Auth e prova contra provedores reais
permanecem fora das evidências locais desta entrega.
