---
impacto: capacidade_nova
secao: corrigido
titulo: Confirmação de conta e recuperação pelo e-mail padrão
---

O verificador do link enviado pelo Supabase pode voltar do webmail no mesmo
navegador sem expor a sessão principal. O login distingue conta pendente de
senha incorreta e oferece reenvio da confirmação. A instalação ainda precisa
ter o domínio público configurado em Auth > URL Configuration no Supabase.
