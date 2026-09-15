---
impacto: nada_mudou
secao: corrigido
titulo: Recibos antecipados do canal oficial aguardam correlação
---

Quando um recibo chega antes de o envio gravar seu identificador externo, o
webhook pede reentrega em vez de confirmar um evento que não foi aplicado.
Após a gravação do identificador, a nova tentativa atualiza a mensagem correta,
preservando entrega/leitura, isolamento da conexão e idempotência.
