-- 0231: mensagens opt-in do ciclo de teste, no event_log e transporte existentes.
alter table public.obra_access_integrations add column if not exists outreach_enabled boolean not null default false;
alter table public.obra_access_integrations add column if not exists outreach_channel_id uuid references public.channel_sessions(id);
alter table public.obra_access_integrations add column if not exists recovery_pointer_id uuid references public.followup_flow_pointers(id);
alter table public.obra_access_integrations add column if not exists registration_rule_id uuid references public.automation_rules(id);
alter table public.obra_access_integrations add column if not exists usage_rule_id uuid references public.automation_rules(id);
alter table public.obra_access_integrations add column if not exists activation_rule_id uuid references public.automation_rules(id);

create table if not exists public.obra_subscription_outreach (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  state_id uuid not null,
  kind text not null check(kind in ('registration','usage','activation','recovery')),
  due_at timestamptz not null,
  event_id uuid references public.event_log(id) on delete set null,
  rule_id uuid references public.automation_rules(id),
  recovery_armed_at timestamptz,
  unique(organization_id,state_id,kind),
  foreign key(organization_id,state_id) references public.obra_subscription_states(organization_id,id) on delete cascade
);
alter table public.obra_subscription_outreach enable row level security;
revoke all on public.obra_subscription_outreach from public,anon,authenticated;
grant all on public.obra_subscription_outreach to service_role;

create or replace function public.fn_configure_obra_outreach(p_org uuid,p_integration uuid,p_enabled boolean,
  p_channel uuid,p_recovery uuid,p_registration text,p_usage text,p_activation text)
returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare cfg public.obra_access_integrations; ids uuid[]; templates text[]:=array[p_registration,p_usage,p_activation]; n integer; created_rule uuid;
begin
  select * into cfg from public.obra_access_integrations where organization_id=p_org and id=p_integration for update;
  if not found or not cfg.lifecycle_enabled then raise exception 'obra_lifecycle_required' using errcode='23514'; end if;
  if p_channel is not null and not exists(select 1 from public.channel_sessions where organization_id=p_org and id=p_channel
    and provider='waha' and to_jsonb(channel_sessions)->>'archived_at' is null) then
    raise exception 'obra_channel_invalid' using errcode='23514'; end if;
  if p_recovery is not null and not exists(select 1 from public.followup_flow_pointers where organization_id=p_org and id=p_recovery) then
    raise exception 'obra_recovery_invalid' using errcode='23514'; end if;
  if p_enabled and p_channel is null then raise exception 'obra_channel_required' using errcode='23514'; end if;
  if exists(select 1 from unnest(templates) t where t is null or length(t)>2000) then
    raise exception 'obra_message_invalid' using errcode='23514'; end if;
  ids:=array[cfg.registration_rule_id,cfg.usage_rule_id,cfg.activation_rule_id];
  for n in 1..3 loop
    if ids[n] is null then
      insert into public.automation_rules(organization_id,name,trigger_event,actions,is_active)
        values(p_org,case n when 1 then 'Obra no Bolso: cadastro no teste' when 2 then 'Obra no Bolso: uso no teste'
          else 'Obra no Bolso: assinatura confirmada' end,'obra_subscription.outreach','[]',false) returning id into created_rule;
      ids[n]:=created_rule;
    end if;
    update public.automation_rules set actions=case when p_channel is null or btrim(templates[n])='' then '[]'::jsonb else
      jsonb_build_array(jsonb_build_object('type','send_whatsapp_message','config',
        jsonb_build_object('channel_session_id',p_channel,'template',templates[n]))) end,
      is_active=p_enabled and btrim(templates[n])<>'',updated_at=now()
      where organization_id=p_org and id=ids[n];
  end loop;
  update public.obra_access_integrations set outreach_enabled=p_enabled,outreach_channel_id=p_channel,
    recovery_pointer_id=p_recovery,registration_rule_id=ids[1],usage_rule_id=ids[2],activation_rule_id=ids[3],updated_at=now()
    where organization_id=p_org and id=p_integration;
  return jsonb_build_object('outreach_enabled',p_enabled);
end $$;
revoke execute on function public.fn_configure_obra_outreach(uuid,uuid,boolean,uuid,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.fn_configure_obra_outreach(uuid,uuid,boolean,uuid,uuid,text,text,text) to service_role;

-- Apenas agendamento interno. Nenhuma chamada HTTP numa transação/trigger.
create or replace function public.fn_schedule_obra_outreach() returns trigger
language plpgsql security invoker set search_path=public,pg_temp as $$
declare cfg public.obra_access_integrations; k text; due timestamptz; rule uuid; outbound uuid; item uuid;
begin
  select * into cfg from public.obra_access_integrations where organization_id=new.organization_id and id=new.integration_id;
  if not cfg.is_active or not cfg.lifecycle_enabled or not cfg.outreach_enabled or new.contact_id is null or new.lead_id is null then return new; end if;
  foreach k in array array['registration','usage','activation','recovery'] loop
    due:=null;rule:=null;
    if k='registration' and new.decision='trial' and now()<new.trial_started_at+interval '48 hours' then
      due:=new.trial_started_at+interval '2 hours';rule:=cfg.registration_rule_id;
    elsif k='usage' and new.decision='trial' and new.em_trial and now()<least(new.trial_started_at+interval '96 hours',coalesce(new.trial_ends_at,new.trial_started_at+interval '96 hours')) then
      due:=new.trial_started_at+interval '48 hours';rule:=cfg.usage_rule_id;
    elsif k='activation' and new.decision='paid' and (tg_op='INSERT' or old.converted_at is null) then
      due:=new.converted_at;rule:=cfg.activation_rule_id;
    elsif k='recovery' and new.decision='recover' and new.converted_at is null and cfg.recovery_pointer_id is not null then
      due:=new.recovery_started_at+interval '2 hours';
    end if;
    if due is null or (k<>'recovery' and rule is null) then continue; end if;
    item:=null;
    insert into public.obra_subscription_outreach(organization_id,state_id,kind,due_at,rule_id)
      values(new.organization_id,new.id,k,due,rule) on conflict(organization_id,state_id,kind) do nothing returning id into item;
    if item is not null then
      outbound:=public.emit_event(case when k='recovery' then 'obra_subscription.recovery' else 'obra_subscription.outreach' end,
        'crm_lead',new.lead_id,jsonb_build_object('contact_id',new.contact_id,'kind',k),'{}',new.organization_id);
      update public.obra_subscription_outreach set event_id=outbound where organization_id=new.organization_id and id=item;
      update public.event_log set next_attempt_at=greatest(now(),due) where organization_id=new.organization_id and id=outbound;
    end if;
  end loop;
  return new;
end $$;
revoke execute on function public.fn_schedule_obra_outreach() from public,anon,authenticated;
grant execute on function public.fn_schedule_obra_outreach() to service_role;
drop trigger if exists tr_schedule_obra_outreach on public.obra_subscription_states;
create trigger tr_schedule_obra_outreach after insert or update on public.obra_subscription_states
  for each row execute function public.fn_schedule_obra_outreach();

-- Guarda final dentro do CAS do transporte: identidade, fase, resposta/humano,
-- recusa e estado reconsultado. Ausência/erro da prova jamais autoriza envio.
create or replace function public.fn_obra_outreach_send_live(p_org uuid,p_event uuid,p_contact uuid,p_rule uuid)
returns boolean language sql security invoker set search_path=public,pg_temp as $$
 select exists(select 1 from public.obra_subscription_outreach o
  join public.obra_subscription_states s on s.organization_id=o.organization_id and s.id=o.state_id
  join public.obra_access_integrations i on i.organization_id=s.organization_id and i.id=s.integration_id
  join public.contacts c on c.organization_id=s.organization_id and c.id=s.contact_id
  join public.crm_leads l on l.organization_id=s.organization_id and l.id=s.lead_id
  join public.event_log e on e.organization_id=o.organization_id and e.id=o.event_id
  where o.organization_id=p_org and o.event_id=p_event and c.id=p_contact and o.due_at<=now()
    and e.entity_id=s.lead_id and l.contact_id=c.id and l.pipeline_id=i.pipeline_id
    and i.is_active and i.lifecycle_enabled and i.outreach_enabled
    and s.checked_at>=now()-interval '2 minutes' and s.checked_at<=now()+interval '5 seconds'
    and extract(isodow from now() at time zone 'America/Sao_Paulo') between 1 and 5
    and extract(hour from now() at time zone 'America/Sao_Paulo')>=8
    and extract(hour from now() at time zone 'America/Sao_Paulo')<20
    and not c.is_blocked and not c.is_anonymized and not c.force_human and c.is_merged_into is null
    and coalesce(c.consent #> '{marketing,declined_at}','null'::jsonb) in ('null'::jsonb,'false'::jsonb,'0'::jsonb,'""'::jsonb)
    and not exists(select 1 from public.conversations cv where cv.organization_id=p_org and cv.contact_id=c.id
      and cv.bot_silenced_until>now())
    and not exists(select 1 from public.messages m where m.organization_id=p_org and m.contact_id=c.id and m.direction='inbound'
      and m.created_at>case when o.kind='activation' then s.converted_at when o.kind='recovery' then s.recovery_started_at else s.trial_started_at end)
    and ((o.kind in ('registration','usage') and s.decision='trial' and s.em_trial and l.status='open'
      and now()<least(s.trial_started_at+interval '96 hours',coalesce(s.trial_ends_at,s.trial_started_at+interval '96 hours'))
      and (o.kind<>'registration' or now()<s.trial_started_at+interval '48 hours'))
      or (o.kind='activation' and s.decision='paid' and s.converted_at is not null and l.status='won')
      or (o.kind='recovery' and s.decision='recover' and s.converted_at is null and l.status='open'
        and now()>=s.trial_started_at+interval '96 hours' and i.recovery_pointer_id is not null))
    and (o.kind='recovery' and p_rule is null or o.kind<>'recovery' and o.rule_id=p_rule and exists(
      select 1 from public.automation_rules r where r.organization_id=p_org and r.id=p_rule and r.is_active
        and r.trigger_event='obra_subscription.outreach' and jsonb_array_length(r.actions)=1
        and r.actions->0->>'type'='send_whatsapp_message'
        and r.actions->0->'config'->>'channel_session_id'=i.outreach_channel_id::text))
 )
$$;
revoke execute on function public.fn_obra_outreach_send_live(uuid,uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.fn_obra_outreach_send_live(uuid,uuid,uuid,uuid) to service_role;

-- Só este fluxo e contato opt-in ganham esta guarda; inbound continua 24h.
create or replace function public.fn_obra_followup_live(p_org uuid,p_job uuid,p_contact uuid)
returns boolean language sql security invoker set search_path=public,pg_temp as $$
 select case when not exists(select 1 from public.job_queue where organization_id=p_org and id=p_job and kind='followup_turn') then true
  when not exists(select 1 from public.obra_subscription_states s join public.obra_access_integrations i
    on i.organization_id=s.organization_id and i.id=s.integration_id
    where s.organization_id=p_org and s.contact_id=p_contact and i.lifecycle_enabled) then true
  else exists(select 1 from public.obra_subscription_outreach o
    join public.obra_subscription_states s on s.organization_id=o.organization_id and s.id=o.state_id
    join public.obra_access_integrations i on i.organization_id=s.organization_id and i.id=s.integration_id
    join public.followup_enrollments f on f.organization_id=s.organization_id and f.contact_id=s.contact_id
    join public.job_queue j on j.organization_id=s.organization_id and j.contact_id=s.contact_id
      and j.payload->>'followup_enrollment_id'=f.id::text
    where o.organization_id=p_org and o.kind='recovery' and s.contact_id=p_contact and j.id=p_job
      and f.pointer_id=i.recovery_pointer_id and f.status='active' and o.recovery_armed_at is not null
      and public.fn_obra_outreach_send_live(p_org,o.event_id,p_contact,null)) end
$$;
revoke execute on function public.fn_obra_followup_live(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.fn_obra_followup_live(uuid,uuid,uuid) to service_role;

create or replace function public.fn_arm_obra_recovery(p_org uuid,p_event uuid,p_contact uuid)
returns boolean language plpgsql security invoker set search_path=public,pg_temp as $$
declare item public.obra_subscription_outreach;
begin
  -- Contato trava junto com a guarda final do transporte e a identidade.
  perform 1 from public.contacts where organization_id=p_org and id=p_contact for update;
  select * into item from public.obra_subscription_outreach where organization_id=p_org and event_id=p_event and kind='recovery' for update;
  if not found or item.recovery_armed_at is not null or not public.fn_obra_outreach_send_live(p_org,p_event,p_contact,null) then return false; end if;
  update public.contacts set tags=case when 'followup_assinatura'=any(tags) then tags else array_append(tags,'followup_assinatura') end,
    updated_at=now() where organization_id=p_org and id=p_contact;
  update public.obra_subscription_outreach set recovery_armed_at=now() where organization_id=p_org and id=item.id;
  return true;
end $$;
revoke execute on function public.fn_arm_obra_recovery(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.fn_arm_obra_recovery(uuid,uuid,uuid) to service_role;

create or replace function public.fn_guard_obra_managed_rule() returns trigger
language plpgsql security invoker set search_path=public,pg_temp as $$
begin
  if current_user in ('anon','authenticated') and
    ((tg_op<>'INSERT' and old.trigger_event='obra_subscription.outreach')
      or (tg_op<>'DELETE' and new.trigger_event='obra_subscription.outreach')) then
    raise exception 'obra_managed_rule_private' using errcode='42501';
  end if;
  if tg_op='DELETE' then return old; end if; return new;
end $$;
revoke execute on function public.fn_guard_obra_managed_rule() from public,anon,authenticated;
grant execute on function public.fn_guard_obra_managed_rule() to service_role;
drop trigger if exists tr_guard_obra_managed_rule on public.automation_rules;
create trigger tr_guard_obra_managed_rule before insert or update or delete on public.automation_rules
  for each row execute function public.fn_guard_obra_managed_rule();

-- Resposta remove o segmento antes do sweep seguinte: não reinscrever quem respondeu.
create or replace function public.fn_stop_obra_recovery_on_reply() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if new.direction='inbound' and exists(select 1 from public.obra_subscription_states s
    join public.obra_access_integrations i on i.organization_id=s.organization_id and i.id=s.integration_id
    where s.organization_id=new.organization_id and s.contact_id=new.contact_id and i.lifecycle_enabled) then
    update public.contacts set tags=array_remove(tags,'followup_assinatura'),updated_at=now()
      where organization_id=new.organization_id and id=new.contact_id and 'followup_assinatura'=any(tags);
  end if;
  return new;
end $$;
revoke execute on function public.fn_stop_obra_recovery_on_reply() from public,anon,authenticated;
grant execute on function public.fn_stop_obra_recovery_on_reply() to service_role;
drop trigger if exists tr_stop_obra_recovery_on_reply on public.messages;
create trigger tr_stop_obra_recovery_on_reply after insert on public.messages for each row execute function public.fn_stop_obra_recovery_on_reply();

create or replace function public.fn_stop_obra_recovery_on_contact_guard() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if (new.force_human or new.is_blocked or coalesce(new.consent #> '{marketing,declined_at}','null'::jsonb)
      not in ('null'::jsonb,'false'::jsonb,'0'::jsonb,'""'::jsonb))
    and exists(select 1 from public.obra_subscription_states s join public.obra_access_integrations i
      on i.organization_id=s.organization_id and i.id=s.integration_id
      where s.organization_id=new.organization_id and s.contact_id=new.id and i.lifecycle_enabled) then
    new.tags:=array_remove(new.tags,'followup_assinatura');
  end if;
  return new;
end $$;
revoke execute on function public.fn_stop_obra_recovery_on_contact_guard() from public,anon,authenticated;
grant execute on function public.fn_stop_obra_recovery_on_contact_guard() to service_role;
drop trigger if exists tr_stop_obra_recovery_on_contact_guard on public.contacts;
create trigger tr_stop_obra_recovery_on_contact_guard before update of force_human,is_blocked,consent on public.contacts
  for each row execute function public.fn_stop_obra_recovery_on_contact_guard();

notify pgrst,'reload schema';
