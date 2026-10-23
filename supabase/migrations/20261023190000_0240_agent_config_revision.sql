-- CAS curto: config inteiro na query do PostgREST excedia os limites HTTP.
-- A revisão pertence ao banco e cobre também escritores antigos da configuração.
alter table public.ai_agents
  add column if not exists config_revision bigint not null default 0;

create or replace function public.fn_ai_agent_config_revision()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if TG_OP = 'INSERT' then
    NEW.config_revision := 0;
  elsif NEW.config is distinct from OLD.config then
    NEW.config_revision := OLD.config_revision + 1;
  else
    NEW.config_revision := OLD.config_revision;
  end if;
  return NEW;
end;
$$;

revoke execute on function public.fn_ai_agent_config_revision() from public, anon, authenticated;

drop trigger if exists trg_ai_agent_config_revision on public.ai_agents;
create trigger trg_ai_agent_config_revision
before insert or update on public.ai_agents
for each row execute function public.fn_ai_agent_config_revision();

comment on column public.ai_agents.config_revision is
  'Revisão de config controlada pelo banco para CAS sem JSON na URL do PostgREST.';
