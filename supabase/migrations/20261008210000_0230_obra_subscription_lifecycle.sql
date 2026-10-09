-- 0230: ciclo de teste opt-in. O contrato legado permanece separado.
alter table public.obra_access_integrations add column if not exists lifecycle_enabled boolean not null default false;

create table if not exists public.obra_subscription_states (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  integration_id uuid not null,
  product_user_id uuid not null,
  contact_id uuid references public.contacts(id) on delete set null,
  lead_id uuid references public.crm_leads(id) on delete set null,
  trial_started_at timestamptz not null,
  checked_at timestamptz not null,
  status_pagamento text not null,
  em_trial boolean not null,
  access_enabled boolean not null,
  trial_ends_at timestamptz,
  access_expires_at timestamptz,
  decision text not null check (decision in ('trial','paid','recover','manual','post_conversion')),
  reason text,
  converted_at timestamptz,
  recovery_started_at timestamptz,
  updated_at timestamptz not null default now(),
  foreign key (organization_id,integration_id) references public.obra_access_integrations(organization_id,id),
  unique (organization_id,product_user_id),
  unique (organization_id,id),
  unique (organization_id,contact_id),
  unique (organization_id,lead_id)
);
create table if not exists public.obra_subscription_receipts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  integration_id uuid not null,
  external_event_id uuid not null,
  product_user_id uuid not null,
  fingerprint text not null check (fingerprint ~ '^[a-f0-9]{64}$'),
  event_type text not null check (event_type in ('trial_started','subscription_status_checked')),
  checked_at timestamptz not null,
  decision text not null,
  reason text,
  duplicate_count integer not null default 0,
  created_at timestamptz not null default now(),
  foreign key (organization_id,integration_id) references public.obra_access_integrations(organization_id,id),
  unique (organization_id,integration_id,external_event_id)
);
-- Nenhum nome, e-mail, telefone ou corpo bruto é armazenado neste histórico.
alter table public.obra_subscription_states enable row level security;
alter table public.obra_subscription_receipts enable row level security;
revoke all on public.obra_subscription_states,public.obra_subscription_receipts from public,anon,authenticated;
grant all on public.obra_subscription_states,public.obra_subscription_receipts to service_role;

-- A mudança de modo/funil compete com os dois tipos de recebimento sob o mesmo lock.
create or replace function public.fn_guard_obra_pipeline_update()
returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
  if (new.pipeline_id is distinct from old.pipeline_id or new.lifecycle_enabled is distinct from old.lifecycle_enabled)
    and (old.is_active or new.is_active or exists(select 1 from public.obra_access_receipts
      where organization_id=old.organization_id and integration_id=old.id)
      or exists(select 1 from public.obra_subscription_states where organization_id=old.organization_id and integration_id=old.id)) then
    raise exception 'obra_configuration_locked' using errcode='23514';
  end if;
  return new;
end $$;
revoke execute on function public.fn_guard_obra_pipeline_update() from public,anon,authenticated;
grant execute on function public.fn_guard_obra_pipeline_update() to service_role;

create or replace function public.fn_guard_obra_legacy_mode()
returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
  if exists(select 1 from public.obra_access_integrations where organization_id=new.organization_id
    and id=new.integration_id and lifecycle_enabled) then raise exception 'obra_requires_lifecycle_v2' using errcode='23514'; end if;
  return new;
end $$;
revoke execute on function public.fn_guard_obra_legacy_mode() from public,anon,authenticated;
grant execute on function public.fn_guard_obra_legacy_mode() to service_role;
drop trigger if exists tr_guard_obra_legacy_mode on public.obra_access_receipts;
create trigger tr_guard_obra_legacy_mode before insert on public.obra_access_receipts
  for each row execute function public.fn_guard_obra_legacy_mode();

create or replace function public.fn_receive_obra_subscription(
  p_org uuid,p_integration uuid,p_payload jsonb,p_fingerprint text,p_phone_variants text[],
  p_secret_encrypted bytea
) returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare
  cfg public.obra_access_integrations; s public.obra_subscription_states; receipt public.obra_subscription_receipts;
  c uuid; l uuid; n integer; stage uuid; phase text; reason text; event_type text:=p_payload->>'event_type';
  started timestamptz:=(p_payload->>'trial_started_at')::timestamptz;
  checked timestamptz:=(p_payload->>'checked_at')::timestamptz;
  product_user uuid:=(p_payload->>'product_user_id')::uuid;
  event_id uuid:=(p_payload->>'event_id')::uuid;
  final_check boolean:=event_type='subscription_status_checked'; was_converted boolean;
begin
  select * into cfg from public.obra_access_integrations where organization_id=p_org and id=p_integration for update;
  if not found or not cfg.is_active or not cfg.lifecycle_enabled or cfg.secret_encrypted is distinct from p_secret_encrypted then
    return jsonb_build_object('status','configuration_error');
  end if;
  if (p_payload->>'version')::integer<>2 or event_type not in ('trial_started','subscription_status_checked')
    or started>checked or checked>now()+interval '5 minutes'
    or (final_check and checked<started+interval '96 hours') then
    return jsonb_build_object('status','invalid_event');
  end if;
  select * into receipt from public.obra_subscription_receipts
    where organization_id=p_org and integration_id=p_integration and external_event_id=event_id for update;
  if found then
    if receipt.fingerprint<>p_fingerprint then return jsonb_build_object('status','conflict'); end if;
    update public.obra_subscription_receipts set duplicate_count=duplicate_count+1 where organization_id=p_org and id=receipt.id;
    return jsonb_build_object('status','duplicate','event_id',event_id,'decision',receipt.decision);
  end if;
  select * into s from public.obra_subscription_states where organization_id=p_org and product_user_id=product_user for update;
  if found and (started<>s.trial_started_at or checked<s.checked_at
    or (not final_check and exists(select 1 from public.obra_subscription_receipts r
      where r.organization_id=p_org and r.product_user_id=product_user and r.event_type='subscription_status_checked'))) then
    reason:=case when started<>s.trial_started_at then 'trial_start_changed'
      when checked<s.checked_at then 'stale_event' else 'initial_event_after_snapshot' end;
    insert into public.obra_subscription_receipts(organization_id,integration_id,external_event_id,product_user_id,
      fingerprint,event_type,checked_at,decision,reason)
      values(p_org,p_integration,event_id,product_user,p_fingerprint,event_type,checked,'ignored',reason);
    return jsonb_build_object('status','accepted','event_id',event_id,'decision','ignored','reason',reason);
  end if;
  c:=s.contact_id; l:=s.lead_id; was_converted:=s.converted_at is not null;
  if c is null then
    select count(*),(array_agg(id order by id))[1] into n,c from public.contacts
      where organization_id=p_org and phone_number=any(p_phone_variants) and not is_anonymized and is_merged_into is null;
    if n<>1 then c:=null; reason:='contact_not_unique'; end if;
  end if;
  -- Serializa mudanças de identidade feitas pela UI com a classificação/fechamento.
  if c is not null then
    perform 1 from public.contacts where organization_id=p_org and id=c for update;
    if exists(select 1 from public.obra_subscription_states where organization_id=p_org
      and product_user_id<>product_user and contact_id=c) then
      c:=null;l:=null;reason:='identity_already_linked';
    end if;
  end if;
  if c is not null and (not exists(select 1 from public.contacts where organization_id=p_org and id=c
      and phone_number=any(p_phone_variants) and not is_anonymized and is_merged_into is null
      and (email_normalized is null or email_normalized=lower(p_payload->>'email')))
    or exists(select 1 from public.contacts where organization_id=p_org and id<>c
      and email_normalized=lower(p_payload->>'email') and not is_anonymized and is_merged_into is null)) then
    reason:='contact_identity_conflict';
  end if;
  if c is not null and l is null and reason is null then
    select count(*),(array_agg(id order by id))[1] into n,l from public.crm_leads
      where organization_id=p_org and pipeline_id=cfg.pipeline_id and contact_id=c and status='open';
    if n<>1 then l:=null; reason:='open_lead_not_unique'; end if;
  end if;
  if l is not null then
    perform 1 from public.crm_leads where organization_id=p_org and id=l for update;
    if exists(select 1 from public.obra_subscription_states where organization_id=p_org
      and product_user_id<>product_user and lead_id=l) then
      c:=null;l:=null;reason:='identity_already_linked';
    end if;
  end if;
  if l is not null and not exists(select 1 from public.crm_leads where organization_id=p_org and id=l
      and pipeline_id=cfg.pipeline_id and contact_id=c) then reason:='lead_identity_changed'; end if;
  phase:='manual';
  if reason is null then
    if not final_check then phase:='trial';
    elsif p_payload->>'status_pagamento' in ('suspenso','cancelado') and not (p_payload->>'access_enabled')::boolean then phase:='recover';
    elsif (p_payload->>'em_trial')::boolean or p_payload->>'status_pagamento'='trial' then reason:='status_still_trial';
    elsif p_payload->>'status_pagamento'='ativo' and (p_payload->>'access_enabled')::boolean
      and (nullif(p_payload->>'trial_ends_at','')::timestamptz is null or (p_payload->>'trial_ends_at')::timestamptz<=checked)
      and (nullif(p_payload->>'access_expires_at','')::timestamptz is null or (p_payload->>'access_expires_at')::timestamptz>checked) then phase:='paid';
    else reason:='status_requires_review'; end if;
  end if;
  if was_converted and phase<>'paid' then phase:='post_conversion'; end if;
  if phase='paid' and not was_converted then
    select (array_agg(id))[1],count(*) into stage,n from public.crm_stages
      where organization_id=p_org and pipeline_id=cfg.pipeline_id and is_won and not is_archived and name='Acesso ativado';
    if n<>1 or not exists(select 1 from public.crm_leads where organization_id=p_org and id=l and status='open') then
      phase:='manual';reason:='lead_not_open_or_won_stage_unavailable';
    else
      -- O trigger de etapa mantém status/closed_at e emite lead.won; a confirmação é atômica com seu histórico.
      update public.crm_leads set stage_id=stage,updated_at=now(),source_metadata=coalesce(source_metadata,'{}'::jsonb)
        ||jsonb_build_object('obra_subscription_product_user_id',product_user),
        position_in_stage=(select coalesce(max(position_in_stage),0)+1000 from public.crm_leads where organization_id=p_org and stage_id=stage)
        where organization_id=p_org and id=l and contact_id=c and pipeline_id=cfg.pipeline_id and status='open';
      if not found then phase:='manual';reason:='lead_identity_changed';
      else
        insert into public.crm_lead_activities(organization_id,lead_id,contact_id,source_module,source_id,type,payload,metadata)
          values(p_org,l,c,'crm',p_integration,'demand_closed',jsonb_build_object('desfecho','won','reason','Assinatura ativa fora de teste, confirmada após 96 horas'),
            jsonb_build_object('actor_type','webhook_source','actor_id',p_integration));
      end if;
    end if;
  end if;
  insert into public.obra_subscription_states(organization_id,integration_id,product_user_id,contact_id,lead_id,
    trial_started_at,checked_at,status_pagamento,em_trial,access_enabled,trial_ends_at,access_expires_at,decision,reason,converted_at,recovery_started_at)
    values(p_org,p_integration,product_user,c,l,started,checked,p_payload->>'status_pagamento',(p_payload->>'em_trial')::boolean,
      (p_payload->>'access_enabled')::boolean,nullif(p_payload->>'trial_ends_at','')::timestamptz,
      nullif(p_payload->>'access_expires_at','')::timestamptz,phase,reason,
      case when phase='paid' then coalesce(s.converted_at,checked) else s.converted_at end,
      case when phase='recover' then coalesce(s.recovery_started_at,checked) else s.recovery_started_at end)
    on conflict(organization_id,product_user_id) do update set contact_id=excluded.contact_id,lead_id=excluded.lead_id,
      checked_at=excluded.checked_at,status_pagamento=excluded.status_pagamento,em_trial=excluded.em_trial,
      access_enabled=excluded.access_enabled,trial_ends_at=excluded.trial_ends_at,access_expires_at=excluded.access_expires_at,
      decision=excluded.decision,reason=excluded.reason,converted_at=excluded.converted_at,recovery_started_at=excluded.recovery_started_at,updated_at=now()
    returning * into s;
  insert into public.obra_subscription_receipts(organization_id,integration_id,external_event_id,product_user_id,fingerprint,event_type,checked_at,decision,reason)
    values(p_org,p_integration,event_id,product_user,p_fingerprint,event_type,checked,phase,reason);
  if c is not null and (phase in ('paid','post_conversion','manual','trial')) then
    update public.contacts set tags=array_remove(tags,'followup_assinatura'),updated_at=now() where organization_id=p_org and id=c;
  end if;
  update public.obra_access_integrations set last_received_at=now() where organization_id=p_org and id=p_integration;
  insert into public.api_audit_log(organization_id,action,resource_type,resource_id,metadata)
    values(p_org,'obra_access.received','obra_subscription_state',s.id,jsonb_build_object('decision',phase,'reason',reason));
  return jsonb_build_object('status','accepted','event_id',event_id,'decision',phase,'reason',reason,'state_id',s.id);
end $$;
revoke execute on function public.fn_receive_obra_subscription(uuid,uuid,jsonb,text,text[],bytea) from public,anon,authenticated;
grant execute on function public.fn_receive_obra_subscription(uuid,uuid,jsonb,text,text[],bytea) to service_role;

-- Mantém apenas o identificador técnico necessário à deduplicação após anonimização.
create or replace function public.fn_redact_contact_obra_subscription()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if new.is_anonymized and not old.is_anonymized then
    update public.obra_subscription_states set contact_id=null,lead_id=null,
      decision=case when converted_at is null then 'manual' else 'post_conversion' end,
      reason='contact_anonymized',updated_at=now()
      where organization_id=new.organization_id and contact_id=new.id;
  end if;
  return new;
end $$;
revoke execute on function public.fn_redact_contact_obra_subscription() from public,anon,authenticated;
grant execute on function public.fn_redact_contact_obra_subscription() to service_role;
drop trigger if exists tr_redact_contact_obra_subscription on public.contacts;
create trigger tr_redact_contact_obra_subscription after update of is_anonymized on public.contacts
  for each row execute function public.fn_redact_contact_obra_subscription();

notify pgrst,'reload schema';
