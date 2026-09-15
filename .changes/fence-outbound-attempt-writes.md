---
impacto: nada_mudou
secao: corrigido
titulo: Executor expirado não reclassifica tentativas de envio
---

As escritas de resultado, erro e requeue das tentativas gerenciadas verificam o
owner e a fase persistida no mesmo comando. Uma falha tardia de um executor cujo
lease expirou não apaga a indicação de transporte iniciado por outro executor e
não libera reenvio de uma mensagem possivelmente aceita.
