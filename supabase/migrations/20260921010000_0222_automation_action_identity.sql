-- Intenção por posição da ação: duas ações iguais no mesmo array são legítimas.
-- Runs antigos continuam agregados (action_index NULL), sem backfill especulativo.
alter table public.automation_rule_runs
  add column if not exists action_index integer,
  add column if not exists execution_state text,
  add column if not exists message_id uuid references public.messages(id) on delete set null,
  add column if not exists execution_updated_at timestamptz;
create unique index if not exists automation_action_identity
  on public.automation_rule_runs(organization_id, event_id, rule_id, action_index)
  where action_index is not null;
-- Não permitir apagar a memória de aquisição pela REST.
revoke insert, update, delete, truncate on public.automation_rule_runs from anon, authenticated;
alter table public.followup_enrollments add column if not exists automation_run_id uuid
  references public.automation_rule_runs(id) on delete set null;
create unique index if not exists followup_automation_run_identity
  on public.followup_enrollments(automation_run_id) where automation_run_id is not null;
create unique index if not exists automation_runs_org_identity on public.automation_rule_runs(organization_id,id);
do $$ begin
  alter table public.followup_enrollments add constraint followup_automation_run_tenant_fk
    foreign key(organization_id,automation_run_id) references public.automation_rule_runs(organization_id,id);
exception when duplicate_object then null; end $$;

-- O telefone da tentativa é dado de transporte, não uma cópia para a UI.
-- Ambos os caminhos de anonimização passam pela mudança de estado do contato.
create or replace function public.fn_redact_automation_destination() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if new.is_anonymized then
    update public.messages set metadata=metadata-'automation_destination_phone'
      where organization_id=new.organization_id and contact_id=new.id
        and metadata ? 'automation_destination_phone';
  end if;
  return new;
end $$;
revoke execute on function public.fn_redact_automation_destination() from public,anon,authenticated;
grant execute on function public.fn_redact_automation_destination() to service_role;
drop trigger if exists trg_redact_automation_destination on public.contacts;
create trigger trg_redact_automation_destination after update of is_anonymized on public.contacts
  for each row execute function public.fn_redact_automation_destination();
notify pgrst, 'reload schema';
