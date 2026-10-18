---
impacto: nada_mudou
secao: corrigido
titulo: Fechamento do atendimento não abandona mensagens pendentes na fila
---

A retomada da memória confere os envios persistidos de todas as tentativas do
atendimento antes de concluí-lo. Uma resposta preparada que ficou obsoleta por
uma mensagem mais recente é encerrada sem envio; confirmações do canal são
reconciliadas. Envios incertos são preservados e impedem conclusão silenciosa,
seguindo o backoff e o aviso existente na Central, sem repetir ações do agente.
