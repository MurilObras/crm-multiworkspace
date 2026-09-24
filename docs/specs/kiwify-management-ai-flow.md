# Gerenciamento Kiwify e atendimento pós-compra

## Contrato

- `PATCH /api/v1/integrations/kiwify/[id]` substitui a configuração e seus mappings
  na mesma transação. Secret vazio/ausente preserva a cifra. `path_token` é imutável.
- `DELETE` arquiva (`archived_at`, `is_active=false`), sem apagar históricos ou
  regras. Índice parcial libera Store ID para uma nova integração.
- `PUT/DELETE .../[id]/automations` vincula/desvincula uma regra existente.
  FKs compostas e guardas de organização impedem vínculos entre tenants.
- Receipt autenticado determina a integração do evento. Antes de congelar o plano,
  o motor filtra regras por `kiwify_automation_links`; produtos são condições adicionais.
  Retry de plano já congelado mantém as ações originais, mesmo após unlink/arquivamento.
- Store ID do payload somente confere consistência. Payload sintético de teste não
  altera a configuração; divergência continua produzindo `store_mismatch`.

## Migração legada

0227 vincula as regras `lead.created` preexistentes às integrações da mesma organização.
Isso inclui regras genéricas que também recebiam compras antes da mudança. As condições
originais continuam sendo avaliadas. Uma regra antiga que alcançava duas lojas mantém
ambas; não há escolha arbitrária de uma delas nem desligamento silencioso.
`kiwify_links_initialized` torna o backfill de passagem única: reaplicar o baseline
não restaura vínculos removidos pelo operador. Regras novas exigem vínculo explícito.

## Motores existentes

Sequência construída pela UI: `send_whatsapp_message` OU `send_ai_message`, seguida
opcionalmente de `bind_ai_agent` e `start_message_flow`. As duas ações posteriores
aguardam o estado durável de sucesso das anteriores. Transporte incerto não autoriza
seguir adiante nem refazer a primeira mensagem.

### Espera da mensagem inicial

`queued` com fase `prepared` permanece uma espera real: não é sucesso nem falha
terminal. O consumidor existente de `event_log` reagenda sem consumir tentativas.
O run só publica `pending` em `finishActionIntent`, depois que o executor saiu;
o próximo worker usa CAS `pending → preparing` para continuar a mesma mensagem.
O pedido já resolvido fica em metadata da mensagem (inclusive texto gerado pela IA
e parâmetros de template), portanto a retomada não regenera nem renderiza de novo.
As guardas de destinatário, consentimento, janela e transporte continuam no sink.

`precedingActionsState` lê a confirmação da mensagem e o estado durável do run;
`queued`/`sending` aguardam, e failed/rejected/blocked/uncertain não liberam efeitos
dependentes. A retomada nunca adota uma tentativa `started`/`uncertain`. O watchdog
legado continua excluindo mensagens de action intents, inclusive sem metadata.
Não há fila, scheduler ou mecanismo de automação novo.

`bind_ai_agent` não envia mensagem: grava `conversations.active_ai_agent_id`, o marcador
`active_intent=automation:bound` e a restrição de agendamento em metadata. O mesmo
`resolveTurnAgent` e o gate de capacidade do drain consomem esse vínculo, revalidando a
versão publicada. Handoff humano mantém o mecanismo existente de limpar o sticky.
`automation.ai_agent_bound` registra a mudança, sem dados de comprador ou segredo.

0228 usa `followup_enrollments.automation_run_id` para reconhecer a proveniência Kiwify.
Resposta inbound cancela o enrollment canônico em qualquer nó; resposta anterior à
inscrição também impede que ele nasça ativo. O fluxo publicado não é reescrito.

A opção de agenda valida Operador, as quatro tools publicadas e escopo de funil.
Não concede nenhuma permissão. A política por conversa restringe as tools de criação
e remarcação quando a opção está desligada; quando ligada, acrescenta instrução de
consultar disponibilidade real e aguardar escolha/confirmação do cliente. Os motores
MCP/agenda e sua proteção contra compromisso duplicado continuam canônicos.

## Sistema vivo

Entrada: webhook autenticado → receipt/outbox. Consumidor: automation engine existente.
Tela: Webhooks → Kiwify, edição/arquivo e vínculos. Auditoria: RPCs de gerenciamento,
action intents e binding. Retorno: estado de falha/incerteza no acompanhamento indica
a configuração que o operador deve corrigir; uma tentativa incerta nunca é reenviada
automaticamente. Uma nova regra/compra é uma nova operação, não uma reescrita do passado.

## Provas

- `tests/invariants/kiwify-management.test.ts`: transações, arquivo, Store ID,
  segredo/URL, vínculo concorrente e reaplicação do backfill.
- `tests/invariants/kiwify-automation.integration.ts`: motor real com PostgreSQL,
  PostgREST e transporte sintético; lojas isoladas, binding, próximo inbound,
  enrollment único e interrupção por resposta, além das regressões de transporte.
  Inclui queued com oito workers, falhas terminais e o caminho inbound persistido
  → drain → claim → inbound-turn → resposta persistida no sink real. Só o modelo
  e o transporte externo são determinísticos; resolvedor e runtime não são mocks.
- Regra genérica nova permanece visível em Gerenciar automações com explicação
  da condição de compra aprovada exigida para vínculo explícito; não é vinculada
  por produto nem por inferência. Regra legada pausada tem assert de backfill sem
  alterar `is_active`, inclusive na reaplicação.
- `tests/e2e/kiwify-operator-ui.spec.ts`: jornada de edição/vínculo/arquivo pela tela.
- `lib/automation/ai-binding-policy.test.ts`: opções usam ações canônicas e nunca
  concedem tools ausentes. Não é prova de julgamento comercial de um modelo real.
