-- Guarda instalada pela própria 0224 ANTES do backfill; a 0225 a reafirma
-- idempotentemente na ordem cronológica normal, inclusive em bancos de teste
-- que já receberam revisões anteriores deste PR ainda não distribuído.
-- Pré-requisito: tabela da 0223. O resolvedor é chamado apenas no DML;
-- função ausente/erro/conflito aborta o statement, nunca autoriza descarte.
alter table public.automation_event_plans add column if not exists subject_contact_id uuid;
alter table public.automation_event_plans add column if not exists redacted_at timestamptz;

create or replace function public.fn_guard_automation_plan_recovery() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_subject uuid;
  v_state text := 'unresolved';
  v_anonymous boolean;
begin
  -- Não reabrir tombstones nem reinterpretar vínculos já congelados.
  if old.redacted_at is not null or old.subject_contact_id is not null then return new; end if;
  if (new.organization_id,new.event_id) is distinct from (old.organization_id,old.event_id) then
    raise exception 'immutable_automation_plan_identity';
  end if;

  -- A resolução E a decisão pertencem ao mesmo UPDATE. O NULL da coluna não
  -- é evidência: somente o retorno bem-sucedido do resolvedor prova ausência.
  -- Não capturar exceções: conflito/erro desfaz TODO o statement/lote.
  v_subject := public.fn_automation_plan_subject(old.organization_id,old.event_id);
  v_state := case when v_subject is null then 'confirmed_absent' else 'recovered' end;
  if v_state='recovered' then
    select is_anonymized into v_anonymous from public.contacts
      where organization_id=old.organization_id and id=v_subject for update;
    if not found then raise exception 'automation_plan_subject_changed_during_recovery'; end if;
    new.subject_contact_id := v_subject;
    if v_anonymous then
      new.rules := '[]'; new.redacted_at := coalesce(new.redacted_at,now());
    else
      -- Também corrige a tentativa de redigir NULL -> UUID pela guarda imutável
      -- da 0224 em uma reaplicação após upgrade parcialmente interrompido.
      new.rules := old.rules; new.redacted_at := null;
    end if;
  elsif v_state='confirmed_absent' then
    new.subject_contact_id := null;
    new.rules := '[]'; new.redacted_at := coalesce(new.redacted_at,now());
  else
    raise exception 'automation_plan_recovery_unresolved';
  end if;
  return new;
end $$;
revoke execute on function public.fn_guard_automation_plan_recovery() from public,anon,authenticated;
grant execute on function public.fn_guard_automation_plan_recovery() to service_role;
-- PostgreSQL ordena triggers do mesmo tipo pelo nome: decidir APÓS a guarda
-- da 0224, que é recriada ao reaplicar aquele bloco. Nenhuma guarda é desligada.
drop trigger if exists zz_automation_plan_recovery on public.automation_event_plans;
create trigger zz_automation_plan_recovery before update on public.automation_event_plans
  for each row execute function public.fn_guard_automation_plan_recovery();
