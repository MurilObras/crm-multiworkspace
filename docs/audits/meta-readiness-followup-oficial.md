# Follow-up oficial — Bloco 4

## Contrato de configuração

O grafo já possuía `action.config.fallback_template_id` no modo `ai_message`, mas
o engine não o transportava ao job. Agora esse campo também pode ser configurado
nos modos `text` e `template` (texto pronto local), junto de
`fallback_template_values: Record<string, string>`.

- `fallback_template_id` referencia a definição existente em `meta_templates`,
  da mesma organização e conexão selecionada. Os valores usam os `slotKey`
  canônicos de `build-components`, incluindo header/body/botões.
- `template_id` continua sendo o modelo local de `message_templates`; não mudou
  de significado. O fallback oficial não é um segundo catálogo de templates.
- Os campos são persistidos no JSON do grafo e repassados ao job da versão pinada.
  Não há tabela ou migration nova.

## Publicação

A rota usa o resolver central do Bloco 3, que ignora sessões arquivadas ou
inutilizáveis e exige uma conexão inequívoca. Sem conexão ou com ambiguidade,
recusa com `followup_channel_unresolved`.

Canal livre não exige fallback. Canal restrito exige fallback em **todo passo de
envio**, inclusive espera menor que 24h: o contato pode entrar no fluxo sem janela
aberta. A publicação valida existência, escopo, aprovação e slots obrigatórios.
A análise estrutural legada de espera ≥24h continua disponível para chamadores
sem contexto de canal; o endpoint de publicação sempre fornece esse contexto.

## Runtime e falhas

`followupNeedsTemplate` consulta `capabilitiesOf` e `isWindowOpen`. O agent-engine
lê `last_inbound_at` da conversa vinculada e escolhe o fallback antes de pagar o
turno de IA. O helper `loadOfficialFollowupTemplate` usa os helpers existentes
de aprovação, derivação de contrato, slots e renderização, com escopo org/sessão.

Template oficial percorre `runBeforeSend` com `isTemplate=true` e segue pelo canal
e ledger existentes. Opt-out, LGPD e pacing continuam na cadeia. Sem fallback ou
com configuração inválida, lança erro explícito; a fila tem orçamento finito.

O envio inline fixo consulta a mesma regra e usa o mesmo helper, enviando
`type=template` pelo sink comum. Só conta `sent` e só então completa o nó. Falha
definitiva de janela/configuração marca o job `dead` com `last_error`; erro de
leitura permanece retentável. O enrollment continua sujeito ao recheck/dead do
engine, sem conclusão falsa.

Enviar template não escreve `last_inbound_at`. O inbound já ingerido pelo canal
atualiza essa coluna; o próximo turno observa a janela aberta e volta ao texto
livre. O sink universal continua sendo a última proteção se a janela expirar
entre a leitura e o transporte.

## Cobertura

- `lib/channels/followup-delivery.test.ts`: capabilities, janela e contrato oficial.
- `lib/followup/official-fallback-payload.test.ts`: grafo pinado → payload do job.
- `tests/api/followup-flows.test.ts`: publicação, inativos/arquivados e ambiguidade.
- `tests/unit/followup-official-runtime.test.ts`: IA/texto vs fallback no agent-engine.
- `lib/followup/enviar-texto-fixo.test.ts`: inline, fallback e resultado real do sink.
