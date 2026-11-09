# Passagem explícita ao acompanhamento de pagamento

Configuração operacional posterior à publicação; nenhuma inscrição real foi alterada nesta implementação.

1. Conferir que a família decidiu pagar e o cartão correto está em Aguardando pagamento. Intenção de pagar não é confirmação de pagamento/matrícula.
2. Consultar a inscrição viva e o motivo de pausa/cancelamento na tela. Uma consulta humana ainda pendente continua bloqueando proativos; resolvê-la não desfaz cancelamento manual.
3. Reutilizar o fluxo comercial publicado da escola, com seus seis retornos e condições. Não inventar novos intervalos nem copiar a condição de permanência em Experimental do pós-aula para Pagamento.
4. Se existir pós-aula vivo e incompatível, encerrar explicitamente essa finalidade e registrar o motivo antes de inscrever no comercial. Nunca manter dois fluxos vivos, reiniciar orçamento ou repetir retornos já enviados para contornar a exclusividade.
5. Se o comercial anterior foi cancelado por uma pessoa, nova inscrição exige decisão humana explícita; o código não deve ressuscitá-la ao fechar a consulta ou trocar o cartão de etapa.
6. Manter segunda a sexta, 08h–20h, America/Sao_Paulo, com aquecimento ligado. Prazo combinado com a família prevalece. Resposta, recusa, comprovante em conferência, atendimento humano ou matrícula reavaliam/interrompem conforme a política publicada.
7. Depois da configuração, recarregar e conferir uma única inscrição elegível, próxima avaliação ou motivo de parada e histórico preservado. Se a interface não permitir essa passagem sem reiniciar retornos/budget, registrar o bloqueio e revisar o desenho; não aplicar alteração direta em banco nem criar um segundo motor.

Esta entrega adiciona `ai.handoff_resolved` apenas quando a resposta marcada foi confirmada e o automático pôde ser devolvido. O consumidor existente de follow-up continua decidindo quais inscrições pausadas por atendimento humano são retomáveis; pausas manuais e cancelamentos permanecem protegidos.
