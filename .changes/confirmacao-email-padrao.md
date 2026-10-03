---
impacto: exige_acao
secao: corrigido
titulo: Confirmação de conta e recuperação pelo e-mail padrão
---

O verificador do link enviado pelo Supabase pode voltar do webmail no mesmo
navegador sem expor a sessão principal. O login distingue conta pendente de
senha incorreta e oferece reenvio da confirmação. A instalação ainda precisa
ter o domínio público configurado em Auth > URL Configuration no Supabase,
com Redirect URLs aceitando a query de `/auth/confirm` (por exemplo,
`https://SEU_DOMINIO/auth/confirm**`). O retorno do e-mail também preserva a
nova sessão e distingue os verificadores de links pedidos em abas diferentes.
