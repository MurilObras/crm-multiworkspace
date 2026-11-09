# Contracts — interface e continuidade

Contrato aprovado e implementado em branch local, em validação. Nenhuma publicação realizada.

## Inbox

- Consultas acessíveis da conversa, com assunto e estado.
- Opção: **Esta resposta resolve a consulta e libera o Júnior**. Outros agentes usam nome configurado, sem alteração comercial fora da escola.
- Desmarcada por padrão. Não aciona em nota interna, contato bloqueado ou envio sem conteúdo válido.
- Mais de uma consulta exige escolher uma. Limpar seleção ao trocar conversa; associar ao envio específico, incluindo áudio, sem vazar para o seguinte.
- Estados: aguardando envio; consulta concluída e automático liberado; ou resultado parcial com bloqueio explicado. Não mostrar resolução por HTTP 200 isolado.
- Enter, botão e áudio usam a mesma intenção. Retry não duplica mensagem nem resolução.

## `POST /api/v1/messages` — extensão candidata

Adicionar intenção estruturada de resolver consulta selecionada e devolver à IA. Nome final dos campos será fechado junto do schema. Não tratar metadado arbitrário como permissão.

Campo implementado: `resolve_case_id` (UUID, opcional), somente com texto não vazio ou áudio no Storage da conversa. A intenção é persistida na tabela privada `case_resolution_intents`, antes do transporte. Metadados do navegador não autorizam resolução.

O resultado escrito por serviço confirma a intenção e emite `ai.case_resolution_confirmed` atomicamente. `caseResolutionHandler` consome pelo dispatcher existente; a resolução e auditoria são transacionais. Revisões de comando da conversa/contato preservam novas decisões da equipe. Uma tentativa iniciada/incerta nunca é cancelada a partir de metadado editável.

`GET /api/v1/messages/[id]/case-resolution` lê o progresso com escopo de mensagem/org e papel agent+. `GET /api/v1/ai/cases?conversation_id=...` limita consultas e os cinco progressos mais recentes à conversa. O Inbox retoma a conferência após recarga, com polling limitado e sem anúncio de sucesso por HTTP 200.

Validar ator, acesso, organização, conversa/contato/caso relacionados e estado resolúvel. Rejeitar associação cruzada antes do transporte. Vincular intenção ao hash de idempotência do envio.

Preservar retorno atual de mensagem; progresso da resolução é visível no caso/mensagem. Falha mantém pendência. Falha após transporte confirmado mantém intenção recuperável e gera aviso, sem reenviar.

## `POST /api/v1/ai/cases/[id]/reply`

Preservar ações existentes, especialmente `resolved_internal` sem enqueue de resposta. Explicar efeitos na tela.

Encerramento interno grava `metadata.internal_no_send` no evento de resolução. A rota toma a mesma trava de conversa usada por `fn_case_internal_outbound_live`, no CAS anterior ao transporte do engine. Prepared anterior ao encerramento é vetado; iniciado/incerto exige conferência. Entrada posterior e resposta autorizada de outra consulta continuam elegíveis. Follow-up independente não é cancelado por inferência.

Opção futura de responder e continuar deve ser explícita e usar a coordenação compartilhada do Inbox. Job enfileirado ou bloqueado por humano não deve ser apresentado como resposta já entregue.

## Devolução ao automático

Distinguir atribuição à IA de aptidão para responder. Mostrar “Automático liberado” somente quando apto; com consulta impeditiva, mostrar “Aguardando resolução da consulta” e ação de abrir o caso. Não resolver por conta própria. Não repetir automaticamente pergunta antiga já respondida por humano. O painel de Casos deve apresentar a mesma distinção.

## Ponte da IA

Edição operacional não troca `contact_id`. Vínculo confiável vem do servidor. Administração humana/MCP externo preservam relink legítimo com validação e autorização próprias.

## Áudio e acompanhamento

Reprocessar histórico não significa responder ao lead. Aviso tem recibos e consulta associada. Reutilizar `ResponsibleDeliveryStatus.tsx`, enriquecendo dados do endpoint existente se necessário para exibir “Enviado”, “Entregue”, “Lido” e estado separado da consulta. Sem recibo, informar desconhecido; não inferir leitura por status `sent` da entrega interna.

Mudança de etapa não promete retomada quando há cancelamento humano ou inscrição incompatível; mostrar como regularizar.
