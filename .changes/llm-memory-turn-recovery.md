---
impacto: nada_mudou
secao: corrigido
titulo: Atendimento continua com a chave configurada e sem refazer respostas por falha de memória
---

As chamadas internas de memória respeitam o provedor e a chave escolhidos no
agente. Uma escolha no painel de provedores não exige uma chave de outro provedor
para o padrão da organização. Chaves específicas continuam restritas à organização
e ao provedor configurados.

Quando o atendimento termina e o registro de memória falha, a nova tentativa
fecha somente a memória, sem repetir ferramentas ou mensagens ao cliente. A fila
mantém a referência do fechamento, sem copiar a conversa ou segredos para o job.
