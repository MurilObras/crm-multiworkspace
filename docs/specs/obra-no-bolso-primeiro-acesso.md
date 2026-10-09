# Obra no Bolso → CRM: primeiro acesso liberado

Estado: implementação em branch para revisão. O Obra no Bolso ainda precisa emitir o evento;
esta especificação é o contrato para `guisantossa/obranobolso`. Stripe e Asaas são
processados no produto, nunca no CRM.

## Configuração

Um administrador escolhe o funil de assinaturas na aba Webhooks › Obra no Bolso.
Esse funil precisa ter **uma única** etapa ganha, chamada `Acesso ativado`. A criação
gera um segredo aleatório mostrado uma única vez. A conexão nasce inativa; a equipe
deve guardar o segredo no emissor antes de ativá-la. O endpoint tem a forma:

`POST https://<domínio-do-crm>/api/v1/webhooks/obra-no-bolso/<id-da-integração>`

O funil pode ser alterado pelo administrador somente com a conexão inativa e
antes do primeiro evento recebido. Depois disso, os vínculos dependem do funil
original e a troca é bloqueada no banco.

Envie `Content-Type: application/json` e os headers:

- `X-Obra-Timestamp`: Unix em segundos (10 dígitos) ou milissegundos (13 dígitos).
- `X-Obra-Signature`: `v1=` seguido do HMAC-SHA256 hexadecimal de
  `timestamp + "." + bytes_exatos_do_corpo`, usando o segredo da integração.

O timestamp deve estar a até cinco minutos do relógio do CRM. Não há fallback de
autenticação. O corpo tem limite de 16 KiB e o endpoint limita a 60 requisições
por minuto por integração. Um mesmo `event_id` deve ser reenviado com os mesmos
bytes até receber confirmação ou pendência; conteúdo divergente recebe 409.
Se o contador Redis estiver indisponível, o endpoint responde 503; não há
limite apenas em memória que possa ser contornado entre instâncias.
Na instalação do CRM, a conexão Redis REST existente precisa estar operacional
para que esse endpoint aceite eventos.

## JSON v1

```json
{
  "version": 1,
  "event_type": "first_access_granted",
  "event_id": "evt_123",
  "product_user_id": "user_123",
  "occurred_at": "2026-10-05T17:59:00Z",
  "user_created_at": "2026-10-05T17:30:00Z",
  "name": "Pessoa de teste",
  "email": "pessoa@example.invalid",
  "phone": "+5511998765432",
  "plan": "Pro",
  "modality": "paid",
  "user_status": "active",
  "is_new_user": true,
  "trial_active": false,
  "trial_ends_at": null,
  "provider": "asaas"
}
```

O produto deve calcular `is_new_user`; **não** há regra de intervalo entre as duas
datas no CRM. Para `trial`, `trial_active` deve ser `true` e `trial_ends_at`
deve estar no futuro no momento da recepção. Para `paid`, `user_status` deve
ser `active`, `is_new_user` deve ser `true`, `trial_active` deve ser `false` e
`trial_ends_at` deve ser `null`. O provedor é contexto, não autorização. Campos
extras são rejeitados, inclusive qualquer detalhe de cartão ou pagamento.
Para o provedor Asaas, o contrato aceita somente `paid`; `trial` é rejeitado.

## Efeitos e respostas

O CRM normaliza o telefone pelas regras canônicas, exige exatamente um contato
ativo e uma oportunidade aberta no funil selecionado, e registra o vínculo único
entre usuário, contato e oportunidade. Ambiguidade ou ausência de associação
deixam o evento `pending`, visível ao administrador para vínculo manual; nada é
fechado nem enviado nessa situação. A decisão manual fica no audit log.

Uma associação segura fecha a oportunidade pela regra compartilhada
`encerraDemanda`, preservando a timeline. O evento de automação
`obra_access.activated` só entra no barramento após comprovação do fechamento.
As regras são criadas pausadas, podem filtrar `event.modality` (`trial`/`paid`)
e aceitam somente ação de mensagem WhatsApp. O motor existente verifica recusa,
bloqueio, passagem para humano, janela, limite e intenção durável antes do envio.
O destinatário permanece vinculado ao contato conciliado. Uma mudança de contato,
funil ou anonimização impede a confirmação/envio. Pausar a integração ou a regra
também bloqueia mensagens preparadas que ainda não iniciaram o transporte.
Uma edição simultânea dos metadados da oportunidade impede a gravação daquela
tentativa; a retomada relê os dados e preserva a edição. Falhas temporárias de
consulta ao recibo, integração ou contato não são tratadas como descarte: o
evento continua sujeito à política de retry do barramento, sem autorizar envio
até que a identidade e a conversão sejam conferidas novamente.

Respostas possíveis: `processed`, `pending`, `duplicate`, `in_progress`;
422 para evento inelegível, 401 para assinatura inválida, 409 para ID repetido
com conteúdo diferente e 503 para falha transitória. Em 503, reenvie o mesmo
evento. Nenhum webhook Stripe ou Asaas pertence ao CRM.
`in_progress` ainda não é confirmação final: reenvie o evento após dois minutos
com o mesmo corpo e uma nova assinatura/timestamp, até `processed`, `pending` ou
`duplicate` com estado original final. O administrador também pode retomar um
recebimento interrompido no histórico; o lease impede disputa com processamento ativo.
