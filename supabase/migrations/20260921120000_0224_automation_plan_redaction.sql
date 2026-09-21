-- 0224: remover conteúdo executável, não a identidade do evento/run.
alter table public.automation_event_plans add column if not exists subject_contact_id uuid;
alter table public.automation_event_plans add column if not exists redacted_at timestamptz;
alter table public.automation_rule_runs add column if not exists plan_redacted_at timestamptz;

-- Só vínculos persistidos; nenhuma comparação de nome/telefone ou dependência da regra.
create or replace function public.fn_automation_plan_subject(p_org uuid,p_event uuid) returns uuid
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare v_subjects uuid[];
begin
  with candidates as (
    select l.contact_id from public.event_log e join public.crm_leads l
      on l.id=e.entity_id and l.organization_id=e.organization_id
      where e.organization_id=p_org and e.id=p_event and e.entity_kind='crm_lead'
    union select e.entity_id from public.event_log e
      where e.organization_id=p_org and e.id=p_event and e.entity_kind='contact'
    union select l.contact_id from public.kiwify_receipts k join public.crm_leads l
      on l.organization_id=k.organization_id and l.id=k.lead_id
      where k.organization_id=p_org and k.event_id=p_event
    union select x.target_id from public.event_log e join public.crm_lead_links x
      on x.organization_id=e.organization_id and x.lead_id=e.entity_id and x.target_kind='contact'
      where e.organization_id=p_org and e.id=p_event and e.entity_kind='crm_lead'
    union select m.contact_id from public.event_log e join public.messages m
      on m.organization_id=e.organization_id and m.id=e.entity_id
      where e.organization_id=p_org and e.id=p_event and e.entity_kind='message'
    union select c.contact_id from public.kiwify_receipts k join public.webhook_lead_captures c
      on c.organization_id=k.organization_id
      and (c.lead_id=k.lead_id or c.fields->>'kiwify_receipt_id'=k.id::text)
      where k.organization_id=p_org and k.event_id=p_event
    union select m.contact_id from public.automation_rule_runs r join public.messages m
      on m.organization_id=r.organization_id and m.id=coalesce(r.message_id,r.id)
      where r.organization_id=p_org and r.event_id=p_event
    union select f.contact_id from public.automation_rule_runs r join public.followup_enrollments f
      on f.organization_id=r.organization_id and f.automation_run_id=r.id
      where r.organization_id=p_org and r.event_id=p_event
  ) select array_agg(distinct c.id) into v_subjects
    from candidates x join public.contacts c on c.id=x.contact_id and c.organization_id=p_org;
  -- Conflito não prova ausência: interromper, nunca apagar um plano recuperável.
  if cardinality(v_subjects)>1 then raise exception 'automation_plan_subject_ambiguous'; end if;
  return v_subjects[1];
end
$$;
revoke execute on function public.fn_automation_plan_subject(uuid,uuid) from public,anon,authenticated;
grant execute on function public.fn_automation_plan_subject(uuid,uuid) to service_role;

-- Backfill antes das constraints/guardas. Só órfão comprovado é neutralizado.
update public.automation_event_plans p set subject_contact_id=public.fn_automation_plan_subject(p.organization_id,p.event_id)
  where p.subject_contact_id is null and p.redacted_at is null;
update public.automation_event_plans p set rules='[]',redacted_at=coalesce(p.redacted_at,now())
  where p.redacted_at is not null or p.subject_contact_id is null or not exists(
    select 1 from public.contacts c where c.organization_id=p.organization_id and c.id=p.subject_contact_id and not c.is_anonymized);
update public.automation_event_plans p set subject_contact_id=null where p.subject_contact_id is not null
  and not exists(select 1 from public.contacts c where c.id=p.subject_contact_id and c.organization_id=p.organization_id);
do $$ begin
  alter table public.automation_event_plans add constraint automation_plan_subject_tenant_fk
    foreign key(organization_id,subject_contact_id) references public.contacts(organization_id,id)
    on delete set null (subject_contact_id);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.automation_event_plans add constraint automation_plan_redacted_payload
    check ((redacted_at is null and subject_contact_id is not null) or (redacted_at is not null and rules='[]'::jsonb));
exception when duplicate_object then null; end $$;
create index if not exists automation_plan_subject_lookup on public.automation_event_plans(organization_id,subject_contact_id);

create or replace function public.fn_guard_automation_plan_payload() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_subject uuid; v_anonymous boolean; v_at timestamptz;
begin
  if tg_op='UPDATE' then
    if (new.organization_id,new.event_id) is distinct from (old.organization_id,old.event_id) then
      raise exception 'immutable_automation_plan_identity';
    end if;
    if old.redacted_at is not null or new.redacted_at is not null or new.subject_contact_id is distinct from old.subject_contact_id then
      new.rules := '[]'; new.redacted_at := coalesce(old.redacted_at,new.redacted_at,now());
    elsif new.rules is distinct from old.rules then raise exception 'immutable_automation_plan'; end if;
    return new;
  end if;
  select p.subject_contact_id,p.redacted_at into v_subject,v_at from public.automation_event_plans p
    where p.organization_id=new.organization_id and p.event_id=new.event_id;
  if v_at is not null then
    new.subject_contact_id:=v_subject; new.rules:='[]'; new.redacted_at:=v_at; return new;
  end if;
  v_subject:=coalesce(v_subject,public.fn_automation_plan_subject(new.organization_id,new.event_id));
  -- Ordem comum: contato -> plano -> run -> mensagem. O lock acaba antes de rede.
  select c.is_anonymized into v_anonymous from public.contacts c
    where c.organization_id=new.organization_id and c.id=v_subject for update;
  if not found then v_subject:=null; end if;
  new.subject_contact_id:=v_subject;
  if v_subject is null or coalesce(v_anonymous,true) or new.redacted_at is not null then
    new.rules:='[]'; new.redacted_at:=coalesce(new.redacted_at,now());
  end if;
  return new;
end $$;
revoke execute on function public.fn_guard_automation_plan_payload() from public,anon,authenticated;
grant execute on function public.fn_guard_automation_plan_payload() to service_role;
drop trigger if exists trg_guard_automation_plan_payload on public.automation_event_plans;
create trigger trg_guard_automation_plan_payload before insert or update on public.automation_event_plans
  for each row execute function public.fn_guard_automation_plan_payload();

create or replace function public.fn_automation_plan_live(p_org uuid,p_event uuid,p_contact uuid default null) returns boolean
language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare v_subject uuid; v_redacted timestamptz; v_anonymous boolean;
begin
  select subject_contact_id,redacted_at into v_subject,v_redacted from public.automation_event_plans
    where organization_id=p_org and event_id=p_event;
  if not found or v_redacted is not null or v_subject is null or (p_contact is not null and p_contact<>v_subject) then return false; end if;
  select is_anonymized into v_anonymous from public.contacts where organization_id=p_org and id=v_subject for update;
  if not found or v_anonymous then return false; end if;
  -- Leitura DEPOIS de obter o contato: não confia no snapshot anterior à espera.
  select redacted_at into v_redacted from public.automation_event_plans
    where organization_id=p_org and event_id=p_event for share;
  return found and v_redacted is null;
end $$;
revoke execute on function public.fn_automation_plan_live(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.fn_automation_plan_live(uuid,uuid,uuid) to service_role;

create or replace function public.fn_automation_message_run(p_org uuid,p_message uuid) returns uuid
language sql stable security definer set search_path=public,pg_temp as $$
  select coalesce(
    (select r.id from public.automation_rule_runs r where r.organization_id=p_org and r.id=p_message and r.action_index is not null),
    (select r.id from public.send_ledger s join public.job_queue j on j.id=s.job_id and j.organization_id=s.organization_id
      join public.followup_enrollments f on f.id::text=j.payload->>'followup_enrollment_id' and f.organization_id=j.organization_id
      join public.automation_rule_runs r on r.id=f.automation_run_id and r.organization_id=f.organization_id
      where s.organization_id=p_org and s.id=p_message));
$$;
revoke execute on function public.fn_automation_message_run(uuid,uuid) from public,anon,authenticated;
grant execute on function public.fn_automation_message_run(uuid,uuid) to service_role;

create or replace function public.fn_automation_run_live(p_org uuid,p_run uuid,p_contact uuid) returns boolean
language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare v_event uuid; v_redacted timestamptz; v_anonymous boolean;
begin
  select event_id,plan_redacted_at into v_event,v_redacted from public.automation_rule_runs where organization_id=p_org and id=p_run;
  if not found or v_redacted is not null then return false; end if;
  if exists(select 1 from public.automation_event_plans where organization_id=p_org and event_id=v_event) then
    return public.fn_automation_plan_live(p_org,v_event,p_contact);
  end if;
  -- Runs históricos/fluxos cujo evento já foi retido continuam sujeitos ao contato.
  select is_anonymized into v_anonymous from public.contacts where organization_id=p_org and id=p_contact for update;
  return found and not v_anonymous;
end $$;
revoke execute on function public.fn_automation_run_live(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.fn_automation_run_live(uuid,uuid,uuid) to service_role;

create or replace function public.fn_automation_message_live(p_org uuid,p_message uuid,p_contact uuid) returns boolean
language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare v_run uuid;
begin
  v_run:=public.fn_automation_message_run(p_org,p_message);
  return v_run is null or public.fn_automation_run_live(p_org,v_run,p_contact);
end $$;
revoke execute on function public.fn_automation_message_live(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.fn_automation_message_live(uuid,uuid,uuid) to service_role;

create or replace function public.fn_guard_automation_plan_run() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if tg_op='INSERT' then
    if new.action_index is not null and exists(select 1 from public.automation_event_plans p where p.organization_id=new.organization_id and p.event_id=new.event_id)
      and not public.fn_automation_plan_live(new.organization_id,new.event_id) then return null; end if;
  else
    new.plan_redacted_at:=coalesce(old.plan_redacted_at,new.plan_redacted_at);
    if new.plan_redacted_at is not null then
      new.error:=null;
      if new.execution_state in ('preparing','pending') then new.execution_state:='blocked'; new.status:='failed'; end if;
      new.actions_result:=(select coalesce(jsonb_agg(jsonb_build_object('type',case when a->>'type' in
        ('send_whatsapp_message','send_ai_message','start_message_flow','call_webhook','add_tag','assign_owner','create_or_move_lead') then a->>'type' else 'unknown_action' end,
        'status',case when new.execution_state='blocked' then 'skipped' else coalesce(a->>'status','failed') end,
        'detail',jsonb_build_object('reason','contact_anonymized'))),'[]'::jsonb) from jsonb_array_elements(new.actions_result) a);
    end if;
  end if;
  return new;
end $$;
revoke execute on function public.fn_guard_automation_plan_run() from public,anon,authenticated;
grant execute on function public.fn_guard_automation_plan_run() to service_role;
drop trigger if exists trg_automation_plan_run_privacy on public.automation_rule_runs;
create trigger trg_automation_plan_run_privacy before insert or update on public.automation_rule_runs
  for each row execute function public.fn_guard_automation_plan_run();

create or replace function public.fn_guard_automation_plan_message() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_run uuid; v_redacted timestamptz; v_phase text; v_key text;
begin
  v_run:=public.fn_automation_message_run(new.organization_id,new.id);
  if v_run is null then return new; end if;
  if tg_op='INSERT' or (new.status='sending' and old.status is distinct from 'sending') then
    if not public.fn_automation_run_live(new.organization_id,v_run,new.contact_id) then
      raise exception 'automation_plan_redacted' using errcode='42501';
    end if;
  end if;
  select plan_redacted_at into v_redacted from public.automation_rule_runs where id=v_run and organization_id=new.organization_id;
  if v_redacted is not null then
    v_phase:=coalesce(new.metadata#>>'{outbound_attempt,phase}',old.metadata#>>'{outbound_attempt,phase}','uncertain');
    v_key:=coalesce(old.metadata->>'idempotency_key',new.id::text);
    if v_phase='prepared' then v_phase:='rejected'; new.status:='failed'; new.error_code:='contact_anonymized'; end if;
    new.body:='[redacted]'; new.error_message:=null;
    new.metadata:=jsonb_build_object('idempotency_key',v_key,'outbound_attempt',jsonb_build_object('phase',v_phase,'retryable',false));
  end if;
  return new;
end $$;
revoke execute on function public.fn_guard_automation_plan_message() from public,anon,authenticated;
grant execute on function public.fn_guard_automation_plan_message() to service_role;
drop trigger if exists trg_automation_plan_message_privacy on public.messages;
create trigger trg_automation_plan_message_privacy before insert or update on public.messages
  for each row when (new.direction='outbound') execute function public.fn_guard_automation_plan_message();

create or replace function public.fn_guard_automation_plan_enrollment() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if new.automation_run_id is not null and not public.fn_automation_run_live(new.organization_id,new.automation_run_id,new.contact_id) then
    raise exception 'automation_plan_redacted' using errcode='42501';
  end if;
  return new;
end $$;
revoke execute on function public.fn_guard_automation_plan_enrollment() from public,anon,authenticated;
grant execute on function public.fn_guard_automation_plan_enrollment() to service_role;
drop trigger if exists trg_automation_plan_enrollment_privacy on public.followup_enrollments;
create trigger trg_automation_plan_enrollment_privacy before insert on public.followup_enrollments
  for each row execute function public.fn_guard_automation_plan_enrollment();

create or replace function public.fn_redact_automation_plan_effects() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if new.redacted_at is null then return new; end if;
  update public.automation_rule_runs set plan_redacted_at=new.redacted_at
    where organization_id=new.organization_id and event_id=new.event_id and plan_redacted_at is null;
  update public.messages m set body='[redacted]',metadata='{}',error_message=null
    where m.organization_id=new.organization_id and exists(select 1 from public.automation_rule_runs r
      where r.organization_id=new.organization_id and r.event_id=new.event_id
        and r.id=public.fn_automation_message_run(m.organization_id,m.id));
  update public.conversations v set last_message_preview=null
    where v.organization_id=new.organization_id and exists(select 1 from public.messages m join public.automation_rule_runs r
      on r.id=public.fn_automation_message_run(m.organization_id,m.id) and r.organization_id=m.organization_id
      where m.organization_id=new.organization_id and m.conversation_id=v.id and r.event_id=new.event_id);
  return new;
end $$;
revoke execute on function public.fn_redact_automation_plan_effects() from public,anon,authenticated;
grant execute on function public.fn_redact_automation_plan_effects() to service_role;
drop trigger if exists trg_redact_automation_plan_effects on public.automation_event_plans;
create trigger trg_redact_automation_plan_effects after update on public.automation_event_plans
  for each row execute function public.fn_redact_automation_plan_effects();

create or replace function public.fn_redact_contact_automation_plans() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if new.is_anonymized then
    update public.automation_event_plans set redacted_at=coalesce(redacted_at,new.anonymized_at,now()),rules='[]'
      where organization_id=new.organization_id and subject_contact_id=new.id;
  end if;
  return new;
end $$;
revoke execute on function public.fn_redact_contact_automation_plans() from public,anon,authenticated;
grant execute on function public.fn_redact_contact_automation_plans() to service_role;
drop trigger if exists trg_automation_plans_contact_redaction on public.contacts;
create trigger trg_automation_plans_contact_redaction after update of is_anonymized on public.contacts
  for each row execute function public.fn_redact_contact_automation_plans();

-- Pós-envio: não recopia input antigo para o preview depois da anonimização.
create or replace function public.fn_automation_message_preview(p_org uuid,p_message uuid) returns boolean
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_run uuid; m public.messages;
begin
  v_run:=public.fn_automation_message_run(p_org,p_message);
  if v_run is null then return false; end if;
  select * into m from public.messages where organization_id=p_org and id=p_message;
  if not found then return true; end if;
  if not public.fn_automation_run_live(p_org,v_run,m.contact_id) then return true; end if;
  select * into m from public.messages where organization_id=p_org and id=p_message;
  update public.conversations set last_outbound_at=coalesce(m.sent_at,m.created_at),last_message_at=coalesce(m.sent_at,m.created_at),
    last_message_preview=left(coalesce(m.body,''),280),unread_count_for_assignee=0
    where organization_id=p_org and id=m.conversation_id and contact_id=m.contact_id;
  return true;
end $$;
revoke execute on function public.fn_automation_message_preview(uuid,uuid) from public,anon,authenticated;
grant execute on function public.fn_automation_message_preview(uuid,uuid) to service_role;

-- Completa também a limpeza dos efeitos nos planos identificados pelo backfill.
update public.automation_event_plans set redacted_at=redacted_at where redacted_at is not null;
notify pgrst, 'reload schema';
