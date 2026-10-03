---
impacto: exige_acao
secao: corrigido
titulo: Confirmação de conta e recuperação pelo e-mail padrão
---

O verificador do link enviado pelo Supabase pode voltar do webmail no mesmo
navegador sem expor a sessão principal. O login distingue conta pendente de
senha incorreta e oferece reenvio da confirmação. A instalação ainda precisa
ter o domínio público configurado em Auth > URL Configuration no Supabase,
com Redirect URLs aceitando os parâmetros de confirmação e de identificação
do fluxo na rota `/auth/confirm`. O retorno do e-mail também preserva a
nova sessão e distingue os verificadores de links pedidos em abas diferentes.

## Requer atenção

No Supabase, em Auth > URL Configuration, defina Site URL com o domínio
público do CRM. Em Redirect URLs, adicione o endereço completo de
`/auth/confirm` seguido de dois asteriscos, para permitir os parâmetros do
tipo de confirmação e do identificador do fluxo. Peça um novo e-mail e abra
o link no mesmo navegador em que iniciou o pedido.
