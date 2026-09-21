---
impacto: capacidade_nova
secao: adicionado
titulo: Acompanhamento de mensagens de compras Kiwify nas automações
---

Compras aceitas usam as regras existentes com aquisição durável por ação. O histórico
em Webhooks › Kiwify distingue bloqueio, falha, aceite, entrega, leitura e resultado
incerto, com identificação do cadastro e links para conversas existentes. O editor de
automações permite escolher templates aprovados do canal e preencher seus parâmetros.
Exige as migrations 0222–0225. O plano de cada evento permanece estável após edição
ou remoção da regra. Não oferece reenvio ou replay. Resultados incertos
não autorizam nova tentativa automática. Homologação externa não está concluída.

Anonimização remove todo o conteúdo executável do plano e conserva sua identidade
com marcador irreversível. Planos antigos comprovadamente sem titular recuperável
também são neutralizados; excluir somente a regra não afeta um plano válido.
O conteúdo removido não poderá ser replanejado ou executado novamente.
Na atualização, vínculos conflitantes preservam o lote por rollback mesmo quando
o executor SQL continua após erro; a proteção é instalada antes do backfill.
