---
impacto: exige_acao
secao: corrigido
titulo: Recuperação de envios usa lease e distingue resultado incerto
---

Inline e agent-engine usam o mesmo protocolo de envio e recuperação. Tentativas
sem confirmação não são marcadas como enviadas nem reenviadas automaticamente.

## Requer atenção

O inline passa a usar a conexão PostgreSQL do worker para claim e conclusão
transacionais; instalações que usavam somente Supabase REST nesse caminho devem
configurar `SUPABASE_DB_URL`, já existente no projeto, antes da atualização.
