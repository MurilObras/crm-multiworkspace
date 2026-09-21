-- Plano privado por evento: não é um catálogo geral de versões de regras.
create unique index if not exists event_log_org_identity on public.event_log(organization_id,id);
create table if not exists public.automation_event_plans (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  event_id uuid not null,
  rules jsonb not null check(jsonb_typeof(rules)='array'),
  created_at timestamptz not null default now(),
  primary key(organization_id,event_id),
  foreign key(organization_id,event_id) references public.event_log(organization_id,id) on delete cascade
);
alter table public.automation_event_plans enable row level security;
revoke all on public.automation_event_plans from public,anon,authenticated;
grant select,insert on public.automation_event_plans to service_role;
revoke update,delete,truncate on public.automation_event_plans from service_role;
-- A FK navegável pode desaparecer, mas a identidade histórica não desaparece.
alter table public.automation_rule_runs add column if not exists rule_identity uuid;
update public.automation_rule_runs set rule_identity=rule_id where rule_identity is null;
alter table public.automation_rule_runs alter column rule_id drop not null;
alter table public.automation_rule_runs drop constraint if exists automation_rule_runs_rule_id_fkey;
alter table public.automation_rule_runs add constraint automation_rule_runs_rule_id_fkey
  foreign key(rule_id) references public.automation_rules(id) on delete set null;
drop index if exists public.automation_action_identity;
create unique index automation_action_identity on public.automation_rule_runs
  (organization_id,event_id,rule_identity,action_index) where action_index is not null;
create or replace function public.fn_automation_rule_identity() returns trigger
language plpgsql security invoker set search_path=public,pg_temp as $$
begin
  if tg_op='UPDATE' and old.rule_identity is not null and new.rule_identity is distinct from old.rule_identity then
    raise exception 'immutable_action_identity';
  end if;
  new.rule_identity := coalesce(new.rule_identity,new.rule_id);
  return new;
end $$;
revoke execute on function public.fn_automation_rule_identity() from public,anon,authenticated;
grant execute on function public.fn_automation_rule_identity() to service_role;
drop trigger if exists trg_automation_rule_identity on public.automation_rule_runs;
create trigger trg_automation_rule_identity before insert or update on public.automation_rule_runs
  for each row execute function public.fn_automation_rule_identity();
notify pgrst, 'reload schema';
