# Workspace = Organization (nomenclatura de produto)

> **Workspace é o nome de PRODUTO da entidade técnica `organizations`.**
> Não existe — e não deve existir — uma tabela `workspaces`. O conceito que o
> usuário chama de "workspace" é a linha em `public.organizations`.

## Por que existe este documento

O produto começou como CRM multi-tenant para e-commerce, onde cada tenant era uma
"organização" (com razão social, CNPJ, DPO e LGPD). O uso evoluiu para times e
departamentos internos que querem espaços isolados de operação — sem o peso
jurídico de uma empresa. Em vez de criar um segundo nível de tenancy (o que
exigiria re-escopar ~107 tabelas com `organization_id` e reescrever todas as
policies RLS), decidimos **renomear na interface** e manter o modelo de dados
intacto.

## O mapeamento

| Produto (o que o usuário vê) | Técnico (o que existe no banco) |
|---|---|
| Workspace | `organizations` (uma linha) |
| Membro de um workspace | linha em `user_organizations` (`role` + `accepted_at`/`revoked_at`) |
| Workspace ativo | cookie `active_org` + `resolveActiveOrg()` |
| Trocar de workspace | `TenantSwitcher` / `app/actions/shell/setActiveOrg.ts` |
| Criar workspace | `app/actions/workspace/createWorkspace.ts` |
| Isolamento entre workspaces | RLS via `fn_user_org_ids()` (inalterada) |
| Números de WhatsApp do workspace | `channel_sessions.organization_id` |
| RAG / memória / funis / agentes | tabelas `*_organization_id` (inalteradas) |

## O que NÃO mudou (de propósito)

- **Nenhuma tabela nova.** Não existe `workspaces`, `workspace_members`, etc.
- **Nenhuma policy RLS reescrita.** O isolamento continua sendo por
  `organization_id` através de `fn_user_org_ids()` e `fn_role_at_least()`.
- **Nenhuma coluna removida.** `legal_name`, `cnpj` e `dpo_email` continuam no
  banco (com `legal_name` ainda `NOT NULL`). O que mudou foi a **tela**: a razão
  social virou opcional, com fallback para o nome de exibição em
  `lib/schemas/settings.ts` — a coluna segue sempre preenchida, sem migration.
- **Nomes internos intactos.** `organizations`, `organization_id`,
  `user_organizations`, `resolveActiveOrg`, `requireRole` etc. continuam com os
  mesmos nomes. Comentários de código em PT-BR também não foram traduzidos.

## Onde a nomenclatura "Workspace" aparece

A troca foi feita apenas na camada de interface (rótulos que o usuário lê):

- grupo da barra lateral e item de menu em `lib/navigation/registry.ts`;
- cabeçalho de Configurações (`app/app/settings/tenant/`);
- seletor de workspace (`components/shell/TenantSwitcher.tsx`);
- toasts e estados vazios (inbox, onboarding, `ApiErrorToast`, `RecoverOrganizationForm`).

As chaves de tradução seguem a convenção de `lib/i18n/dicionario.ts`
(chave = texto em português), com as equivalentes em espanhol incluídas.

## Campo opcional por design

Para uso interno, os campos jurídicos são **opcionais e preenchíveis**:

- **`legal_name` (Razão social)** — opcional na tela; se vazio, o schema grava
  `display_name`. A coluna no banco permanece `NOT NULL`, satisfeita pelo fallback.
- **`cnpj`** — já era nullable; agora com rótulo "(opcional)".
- **`dpo_email`** — já era nullable; agora com rótulo "(opcional)".

Nada foi removido do banco; quem usar o produto com CNPJ/LGPD formal continua
preenchendo os mesmos campos.
