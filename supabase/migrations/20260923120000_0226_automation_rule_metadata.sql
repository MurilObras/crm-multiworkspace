-- 0226: vínculo durável da idempotência de escrita em automation_rules.
--
-- O registro de idempotência (idempotency_keys) tem expiração/limpeza; o ID
-- determinístico preserva a identidade do recurso mas NÃO o hash original do
-- payload. Guardar o hash na PRÓPRIA regra faz o vínculo chave→payload
-- sobreviver à limpeza: colisão de PK com hash diferente vira 409, e o hash
-- original nunca é substituído pelo payload de uma repetição.
alter table public.automation_rules
  add column if not exists metadata jsonb not null default '{}'::jsonb;
