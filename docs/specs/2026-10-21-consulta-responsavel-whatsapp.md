# Consulta ao responsável pelo WhatsApp

Capacidade opt-in por agente, disponível em qualquer workspace. Responsáveis são
cadastrados no workspace; nome, telefone E.164, habilitação, destinatários e
situações de consulta são editáveis na configuração do agente.

Um chamado aberto por um agente habilitado cria um pedido durável e pausa somente
o atendimento automático e os follow-ups daquele contato. O aviso ao cliente e as
notificações usam a conexão do atendimento. Responder ao aviso pelo WhatsApp
identifica o caso: texto é repassado sem reescrita; áudio é entregue preservando a
gravação, sem síntese de voz. Primeira resposta autorizada vence; as outras recebem
confirmação de que o pedido já foi atendido. Nunca inferir o caso pelo texto livre.

Transferência para humano gera aviso, mas a entrega da resposta não desfaz
`force_human`, atribuição ou pausa manual. Consulta temporária só libera sua
própria pausa após entrega confirmada. Sem resposta, o pedido permanece visível.
Falha de transporte incerta não autoriza reenviar. Toda entrega usa a fila e o
ledger canônicos; autorização e estado do pedido são revalidados antes da rede.

As respostas pelas telas existentes continuam disponíveis. Fechar/cancelar um
chamado pelas telas invalida uma resposta externa ainda não aceita. Pedidos de
workspaces diferentes nunca compartilham destinatários, avisos ou respostas.

Fora desta versão: avisos de outros eventos do CRM, instrução interna interpretada
por IA, geração de áudio, lembretes automáticos e encerramento por timeout.

Implementação em branch própria, revisão/correção antes de testes, revisão após
testes e PR com evidências. Sem merge, publicação ou alterações no PR 20.
