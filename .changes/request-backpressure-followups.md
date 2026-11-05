---
impacto: nada_mudou
secao: corrigido
titulo: Consultas lentas deixam de multiplicar tentativas e acumular acompanhamentos
---

O Inbox limita consultas simultâneas e encerra leituras quando a tela desiste.
Falhas temporárias de autenticação deixam de aparecer como logout. Escritas
não são repetidas automaticamente após timeout ou erro de rede.

Os acompanhamentos selecionam contatos e inscrevem episódios em lotes limitados,
preservando pausas humanas, opt-out, aquecimento e o orçamento de mensagens.
Um reagendamento confirmado deixa de gerar um erro falso de perda de lease.
