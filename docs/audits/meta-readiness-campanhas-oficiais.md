# Campanhas oficiais — Bloco 5

## Auditoria de schema e persistência

`whatsapp_campaigns.steps` é JSONB. As RPCs `launch_whatsapp_campaign` (0218)
e `prepare_whatsapp_campaign` (0219) persistem o JSON completo e validam
`message` e `delay_minutes`. Claim, finalização e agendamento usam o índice e
o delay do passo; não interpretam o corpo do transporte.

Não é necessária migration: o backend acrescenta o discriminador e a referência
oficial e mantém `message` como snapshot **real renderizado** da definição. Esse
campo preserva a validação das RPCs existentes e a leitura do histórico. Não é
texto sentinela nem texto enviado no lugar do template. 0218/0219, baseline e
MANIFEST não são alterados.

## Contrato do step

Texto legado, sem alteração:

```json
{ "message": "Olá!", "delay_minutes": 0 }
```

Template oficial:

```json
{
  "type": "template",
  "template_id": "11111111-1111-4111-8111-111111111111",
  "language": "pt_BR",
  "values": { "1": "Ana" },
  "delay_minutes": 0
}
```

`template_id` identifica `meta_templates`; idioma, organização e conexão precisam
coincidir. `values` usa os slotKeys já existentes (corpo, header, botões etc.).
Sem variáveis, `values` pode ser omitido. `message`, se recebido no step oficial,
é substituído pela renderização do servidor antes da RPC. Este suporte mínimo
exige corpo renderizado não vazio de até 4096 caracteres, conforme 0219.

## Pré-voo e transporte

`prepareCampaignTemplate` usa o resolver de capability e o loader oficial comum
`lib/channels/official-template.ts`. Este último é o código de pré-voo já usado
no follow-up, extraído para que ambos compartilhem aprovação, contrato e slots.
O wrapper de follow-up mantém sua assinatura e seus códigos de erro.

O worker valida o step persistido e repete o pré-voo: agendamento não congela a
aprovação remota. Step oficial chega ao `sendMessageHandler` como `type=template`,
com nome, idioma e valores; o sink usa o transporte oficial existente. Step
legado continua `type=text`, sujeito à janela universal do Bloco 1.

## Idempotência e desfechos

- Claim irreversível antes do transporte continua no RPC 0218, com lock e cotas
  por conexão. Um replay não reclama o mesmo destinatário/passo.
- A mensagem continua vinculada à etapa em `beforeSend`, antes da rede, com nova
  checagem de opt-out. Falha de vínculo impede o transporte.
- `stopped_reply`, opt-out, dedupe do público e agendamento continuam nos mesmos
  pontos e funções. Cota/agenda retornam retry antes de qualquer envio.
- Apenas `status=sent` com ID externo finaliza como enviado e avança a sequência.
  Falha do sink preserva seu código em `failure_reason`.
- Timeout após possível aceite ou falha de finalização não dispara novo envio.
- Retry de criação oficial já persistida retorna o mesmo ID dentro do tenant,
  mesmo que a aprovação tenha mudado; não recria público/evento.

## Evidência

`tests/campaigns/outbound.test.ts` atravessa worker, criação/reuso de conversa e
sink reais, dublando banco e transporte: texto em canal livre, texto oficial
dentro/fora da janela e template fora, com vínculo anterior à rede e replay.
Os testes de API e worker também cobrem escopo, aprovação, idioma, parâmetros,
opt-out, resposta, cotas, timeout e falha de finalização. Não há migration a
aplicar nem alteração de esquema que exija bateria PostgreSQL neste bloco.
