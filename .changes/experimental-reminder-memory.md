---
impacto: nada_mudou
secao: corrigido
titulo: Lembretes recalculam a espera após nova resposta e o cancelamento mantém a próxima ação coerente
---

Ao retomar uma espera adaptativa depois de uma resposta, o fluxo recalcula o plano antes de avançar. Não reutiliza o relógio de um compromisso anterior, não repete etapas já enviadas e mantém pausas e proteções de concorrência. Se o replanejamento não concluir, o fluxo para com aviso para revisão.

O fechamento do atendimento sincroniza a próxima ação com o checkpoint confirmado, preservando estágio, qualificação e alterações posteriores feitas por pessoas ou ferramentas. Não exige configuração nova.
