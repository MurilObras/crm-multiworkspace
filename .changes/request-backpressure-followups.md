---
impacto: nada_mudou
secao: corrigido
titulo: Consultas lentas deixam de multiplicar tentativas e acumular acompanhamentos
---

O Inbox limita consultas simultâneas e encerra leituras quando a tela desiste.
Falhas temporárias de autenticação deixam de aparecer como logout.
O limite de autenticações simultâneas cobre também a leitura completa da resposta
e a carga de permissões, com até 128 operações por runtime. Saturação retorna
indisponibilidade temporária, preservando a validação de acesso.
Escritas sem deduplicação não são repetidas automaticamente após timeout ou erro de rede.
Envios e criação de regras com chave explícita e deduplicação persistida podem
recuperar uma resposta perdida em até três tentativas, dentro do mesmo prazo,
preservando o conteúdo e sem duplicar o envio. Timeout não reinicia a operação.

Os acompanhamentos selecionam contatos e inscrevem episódios em lotes limitados,
preservando pausas humanas, opt-out, aquecimento e o orçamento de mensagens.
Um reagendamento confirmado deixa de gerar um erro falso de perda de lease.
