-- 0229: confirmação de acesso do produto, separada da captação de leads.
-- Segredo e dados pessoais só são acessíveis ao service_role. A integração nasce desligada.
create table if not exists public.obra_access_integrations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  pipeline_id uuid not null references public.crm_pipelines(id),
  secret_encrypted bytea not null,
  is_active boolean not null default false,
  rejected_count bigint not null default 0,
  last_received_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id),
  unique (organization_id, id)
);

create table if not exists public.obra_access_receipts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  integration_id uuid not null,
  external_event_id text not null check (length(external_event_id) between 1 and 128),
  product_user_id text not null check (length(product_user_id) between 1 and 128),
  fingerprint text not null check (fingerprint ~ '^[a-f0-9]{64}$'),
  event_version integer not null,
  occurred_at timestamptz not null,
  user_created_at timestamptz not null,
  trial_ends_at timestamptz,
  phone text,
  name text,
  email text,
  plan text not null,
  modality text not null check (modality in ('trial','paid')),
  provider text,
  user_status text not null,
  is_new_user boolean not null,
  status text not null check (status in ('rejected','pending','ready','processing','processed')),
  reason text,
  contact_id uuid references public.contacts(id) on delete set null,
  lead_id uuid references public.crm_leads(id) on delete set null,
  event_log_id uuid references public.event_log(id) on delete set null,
  duplicate_count integer not null default 0,
  claimed_at timestamptz,
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (organization_id,integration_id) references public.obra_access_integrations(organization_id,id),
  unique (organization_id,integration_id,external_event_id),
  unique (organization_id,id)
);
create index if not exists obra_receipts_history_idx
  on public.obra_access_receipts(organization_id,created_at desc);

-- Um usuário do produto e um negócio do CRM só podem produzir uma conversão.
create table if not exists public.obra_access_links (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  product_user_id text not null,
  contact_id uuid not null references public.contacts(id),
  lead_id uuid not null references public.crm_leads(id),
  receipt_id uuid not null,
  modality text not null check (modality in ('trial','paid')),
  plan text not null,
  activated_at timestamptz not null,
  created_at timestamptz not null default now(),
  primary key (organization_id,product_user_id),
  unique (organization_id,contact_id),
  unique (organization_id,lead_id),
  unique (organization_id,receipt_id),
  foreign key (organization_id,receipt_id) references public.obra_access_receipts(organization_id,id)
);

-- A troca de funil compete com o recebimento sob o mesmo lock da integração.
-- Mesmo um PATCH que leu contagem zero não pode mover recibos recém-gravados.
create or replace function public.fn_guard_obra_pipeline_update()
returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
  if new.pipeline_id is distinct from old.pipeline_id and
    (old.is_active or new.is_active or exists(select 1 from public.obra_access_receipts
      where organization_id=old.organization_id and integration_id=old.id)) then
    raise exception 'obra_pipeline_locked' using errcode='23514';
  end if;
  return new;
end $$;
drop trigger if exists tr_guard_obra_pipeline_update on public.obra_access_integrations;
create trigger tr_guard_obra_pipeline_update before update on public.obra_access_integrations
  for each row execute function public.fn_guard_obra_pipeline_update();

alter table public.obra_access_integrations enable row level security;
alter table public.obra_access_receipts enable row level security;
alter table public.obra_access_links enable row level security;
revoke all on public.obra_access_integrations,public.obra_access_receipts,public.obra_access_links from public,anon,authenticated;
grant all on public.obra_access_integrations,public.obra_access_receipts,public.obra_access_links to service_role;

-- A API exige admin, e a política impede contorno pela API direta do Supabase.
drop policy if exists automation_rules_obra_admin on public.automation_rules;
create policy automation_rules_obra_admin on public.automation_rules as restrictive
  for all to authenticated
  using (trigger_event <> 'obra_access.activated' or
    public.fn_role_at_least(organization_id,'admin') or public.fn_is_platform_admin())
  with check (trigger_event <> 'obra_access.activated' or
    public.fn_role_at_least(organization_id,'admin') or public.fn_is_platform_admin());

-- Serializa por integração para que dois eventos do mesmo usuário não conciliem
-- antes de enxergar o vínculo um do outro. O fingerprint cobre o corpo autenticado.
create or replace function public.fn_receive_obra_access(
  p_organization_id uuid,p_integration_id uuid,p_payload jsonb,p_fingerprint text,
  p_phone_variants text[],p_rejection_reason text,p_secret_encrypted bytea
) returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare
  v_integration public.obra_access_integrations;
  v_receipt public.obra_access_receipts;
  v_contact uuid;
  v_lead uuid;
  v_phone_count integer;
  v_lead_count integer;
  v_email_count integer;
  v_reason text := p_rejection_reason;
  v_status text := 'ready';
begin
  select * into v_integration from public.obra_access_integrations
    where organization_id=p_organization_id and id=p_integration_id for update;
  if not found or not v_integration.is_active or v_integration.secret_encrypted is distinct from p_secret_encrypted then
    return jsonb_build_object('status','configuration_error');
  end if;
  update public.obra_access_integrations set last_received_at=now()
    where organization_id=p_organization_id and id=p_integration_id;
  select * into v_receipt from public.obra_access_receipts
    where organization_id=p_organization_id and integration_id=p_integration_id
      and external_event_id=p_payload->>'event_id' for update;
  if found then
    if v_receipt.fingerprint <> p_fingerprint then
      update public.obra_access_integrations set rejected_count=rejected_count+1 where id=p_integration_id;
      insert into public.api_audit_log(organization_id,action,resource_type,resource_id,metadata)
        values(p_organization_id,'obra_access.rejected','obra_access_integration',p_integration_id,
          jsonb_build_object('reason','idempotency_conflict'));
      return jsonb_build_object('status','conflict','receipt_id',v_receipt.id);
    end if;
    update public.obra_access_receipts set duplicate_count=duplicate_count+1 where id=v_receipt.id;
    return jsonb_build_object('status','duplicate','original_status',v_receipt.status,
      'reason',v_receipt.reason,'receipt_id',v_receipt.id);
  end if;

  if v_reason is not null then
    v_status := 'rejected';
  elsif exists(select 1 from public.obra_access_links where organization_id=p_organization_id
      and product_user_id=p_payload->>'product_user_id') then
    v_status := 'rejected'; v_reason := 'product_user_already_linked';
  elsif coalesce(array_length(p_phone_variants,1),0)=0 then
    v_status := 'pending'; v_reason := 'invalid_phone';
  else
    select count(*),(array_agg(id order by id))[1] into v_phone_count,v_contact from public.contacts
      where organization_id=p_organization_id and phone_number=any(p_phone_variants)
        and is_merged_into is null and not is_anonymized;
    if v_phone_count<>1 then
      v_status := 'pending';
      v_reason := case when v_phone_count=0 then 'contact_not_found' else 'multiple_contacts' end;
      v_contact := null;
    else
      select count(*) into v_email_count from public.contacts
        where organization_id=p_organization_id and is_merged_into is null
          and email_normalized=lower(p_payload->>'email') and id<>v_contact;
      if v_email_count>0 or exists(select 1 from public.contacts where organization_id=p_organization_id
          and id=v_contact and email_normalized is not null
          and email_normalized<>lower(p_payload->>'email')) then
        v_status := 'pending'; v_reason := 'contact_identity_conflict';
      else
        select count(*),(array_agg(id order by id))[1] into v_lead_count,v_lead from public.crm_leads
          where organization_id=p_organization_id and pipeline_id=v_integration.pipeline_id
            and contact_id=v_contact and status='open';
        if v_lead_count<>1 then
          v_status := 'pending';
          v_reason := case when v_lead_count=0 then 'open_lead_not_found' else 'multiple_open_leads' end;
          v_lead := null;
        elsif exists(select 1 from public.obra_access_links where organization_id=p_organization_id
            and (contact_id=v_contact or lead_id=v_lead)) then
          v_status := 'pending'; v_reason := 'crm_identity_already_linked';
        end if;
      end if;
    end if;
  end if;

  insert into public.obra_access_receipts(
    organization_id,integration_id,external_event_id,product_user_id,fingerprint,event_version,
    occurred_at,user_created_at,trial_ends_at,phone,name,email,plan,modality,provider,
    user_status,is_new_user,status,reason,contact_id,lead_id)
  values(p_organization_id,p_integration_id,p_payload->>'event_id',p_payload->>'product_user_id',
    p_fingerprint,(p_payload->>'version')::integer,(p_payload->>'occurred_at')::timestamptz,
    (p_payload->>'user_created_at')::timestamptz,nullif(p_payload->>'trial_ends_at','')::timestamptz,
    p_payload->>'phone',p_payload->>'name',p_payload->>'email',p_payload->>'plan',
    p_payload->>'modality',p_payload->>'provider',p_payload->>'user_status',
    (p_payload->>'is_new_user')::boolean,v_status,v_reason,v_contact,v_lead)
  returning * into v_receipt;
  if v_status='ready' then
    insert into public.obra_access_links(organization_id,product_user_id,contact_id,lead_id,
      receipt_id,modality,plan,activated_at)
    values(p_organization_id,v_receipt.product_user_id,v_contact,v_lead,v_receipt.id,
      v_receipt.modality,v_receipt.plan,v_receipt.occurred_at);
  elsif v_status='rejected' then
    update public.obra_access_integrations set rejected_count=rejected_count+1 where id=p_integration_id;
  end if;
  insert into public.api_audit_log(organization_id,action,resource_type,resource_id,metadata)
    values(p_organization_id,'obra_access.received','obra_access_receipt',v_receipt.id,
      jsonb_build_object('status',v_status,'reason',v_reason));
  return jsonb_build_object('status',v_status,'reason',v_reason,'receipt_id',v_receipt.id);
end $$;
revoke execute on function public.fn_receive_obra_access(uuid,uuid,jsonb,text,text[],text,bytea) from public,anon,authenticated;
grant execute on function public.fn_receive_obra_access(uuid,uuid,jsonb,text,text[],text,bytea) to service_role;

-- Claim persistente: falha do processo não perde evento; lease vencido permite retry.
create or replace function public.fn_claim_obra_access(p_organization_id uuid,p_receipt_id uuid)
returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare r public.obra_access_receipts; l public.crm_leads;
begin
  select * into r from public.obra_access_receipts
    where organization_id=p_organization_id and id=p_receipt_id for update;
  if not found then return jsonb_build_object('status','not_found'); end if;
  if r.status='processed' then return jsonb_build_object('status','duplicate'); end if;
  if r.status='processing' and r.claimed_at>now()-interval '2 minutes' then
    return jsonb_build_object('status','in_progress');
  end if;
  if r.status not in ('ready','processing') then return jsonb_build_object('status',r.status); end if;
  if not exists(select 1 from public.obra_access_integrations i
      where i.organization_id=p_organization_id and i.id=r.integration_id and i.is_active) then
    return jsonb_build_object('status','integration_inactive');
  end if;
  select * into l from public.crm_leads where organization_id=p_organization_id and id=r.lead_id;
  if not found or l.pipeline_id is distinct from
      (select pipeline_id from public.obra_access_integrations where organization_id=p_organization_id and id=r.integration_id)
    or (l.status<>'open' and l.source_metadata->>'obra_access_receipt_id' is distinct from r.id::text) then
    update public.obra_access_receipts set status='pending',reason='lead_no_longer_open',claimed_at=null
      where id=r.id;
    return jsonb_build_object('status','pending');
  end if;
  if l.status='open' and not exists(select 1 from public.crm_stages st
      where st.organization_id=p_organization_id and st.pipeline_id=l.pipeline_id
        and st.is_won and not st.is_archived
      having count(*)=1 and min(st.name)='Acesso ativado') then
    update public.obra_access_receipts set status='pending',reason='won_stage_unavailable',claimed_at=null
      where id=r.id;
    return jsonb_build_object('status','pending');
  end if;
  update public.obra_access_receipts set status='processing',claimed_at=now() where id=r.id;
  return jsonb_build_object('status','claimed','lead_id',r.lead_id);
end $$;
revoke execute on function public.fn_claim_obra_access(uuid,uuid) from public,anon,authenticated;
grant execute on function public.fn_claim_obra_access(uuid,uuid) to service_role;

create or replace function public.fn_finish_obra_access(p_organization_id uuid,p_receipt_id uuid)
returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare r public.obra_access_receipts; l public.crm_leads; v_event uuid;
begin
  select * into r from public.obra_access_receipts
    where organization_id=p_organization_id and id=p_receipt_id for update;
  if not found then return jsonb_build_object('status','not_found'); end if;
  if r.status='processed' then return jsonb_build_object('status','duplicate'); end if;
  if r.status<>'processing' then return jsonb_build_object('status','not_claimed'); end if;
  select * into l from public.crm_leads where organization_id=p_organization_id and id=r.lead_id;
  if not found or l.status<>'won' or l.source_metadata->>'obra_access_receipt_id' is distinct from r.id::text then
    return jsonb_build_object('status','closure_unconfirmed');
  end if;
  v_event := public.emit_event('obra_access.activated','crm_lead',r.lead_id,
    jsonb_build_object('receipt_id',r.id,'modality',r.modality,'plan',r.plan,
      'product_user_id',r.product_user_id,'activated_at',r.occurred_at),
    jsonb_build_object('integration_id',r.integration_id),p_organization_id);
  update public.obra_access_receipts set status='processed',reason=null,event_log_id=v_event,
    processed_at=now(),claimed_at=null where id=r.id;
  insert into public.api_audit_log(organization_id,action,resource_type,resource_id,metadata)
    values(p_organization_id,'obra_access.activated','obra_access_receipt',r.id,
      jsonb_build_object('lead_id',r.lead_id,'modality',r.modality));
  return jsonb_build_object('status','processed','receipt_id',r.id,'lead_id',r.lead_id);
end $$;
revoke execute on function public.fn_finish_obra_access(uuid,uuid) from public,anon,authenticated;
grant execute on function public.fn_finish_obra_access(uuid,uuid) to service_role;

create or replace function public.fn_release_obra_access(p_organization_id uuid,p_receipt_id uuid)
returns void language plpgsql security invoker set search_path=public,pg_temp as $$
begin
  update public.obra_access_receipts set status='ready',claimed_at=null
    where organization_id=p_organization_id and id=p_receipt_id and status='processing';
end $$;
revoke execute on function public.fn_release_obra_access(uuid,uuid) from public,anon,authenticated;
grant execute on function public.fn_release_obra_access(uuid,uuid) to service_role;

-- Tentativas sem corpo autenticado não entram no ledger de pessoas; só conta e
-- motivo técnico, sem telefone/e-mail/token/corpo.
create or replace function public.fn_reject_obra_access(p_organization_id uuid,p_integration_id uuid,p_reason text)
returns void language plpgsql security invoker set search_path=public,pg_temp as $$
begin
  update public.obra_access_integrations set rejected_count=rejected_count+1,last_received_at=now()
    where organization_id=p_organization_id and id=p_integration_id;
  insert into public.api_audit_log(organization_id,action,resource_type,resource_id,metadata)
    values(p_organization_id,'obra_access.rejected','obra_access_integration',p_integration_id,
      jsonb_build_object('reason',p_reason));
end $$;
revoke execute on function public.fn_reject_obra_access(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.fn_reject_obra_access(uuid,uuid,text) to service_role;

-- Associação manual é uma decisão explícita do administrador; transação única
-- preserva o pendente quando contato/lead já foram associados em outra requisição.
create or replace function public.fn_manual_link_obra_access(
  p_organization_id uuid,p_receipt_id uuid,p_contact_id uuid,p_lead_id uuid,
  p_actor_user_id uuid,p_request_id uuid
) returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare r public.obra_access_receipts; s public.obra_access_integrations;
begin
  if not exists(select 1 from public.user_organizations where organization_id=p_organization_id
    and user_id=p_actor_user_id and role='admin' and revoked_at is null and accepted_at is not null)
    then raise exception 'invalid_configuration_actor' using errcode='42501'; end if;
  select * into r from public.obra_access_receipts where organization_id=p_organization_id
    and id=p_receipt_id;
  if not found then raise exception 'receipt_not_pending'; end if;
  select * into s from public.obra_access_integrations where organization_id=p_organization_id
    and id=r.integration_id for update;
  if not found then raise exception 'integration_not_found'; end if;
  if not s.is_active then raise exception 'integration_inactive'; end if;
  select * into r from public.obra_access_receipts where organization_id=p_organization_id
    and id=p_receipt_id for update;
  if not found or r.status<>'pending' then raise exception 'receipt_not_pending'; end if;
  if not exists(select 1 from public.contacts where organization_id=p_organization_id
    and id=p_contact_id and is_merged_into is null and not is_anonymized)
    then raise exception 'contact_not_found'; end if;
  if not exists(select 1 from public.crm_leads where organization_id=p_organization_id
    and id=p_lead_id and contact_id=p_contact_id and pipeline_id=s.pipeline_id and status='open')
    then raise exception 'open_lead_not_found'; end if;
  insert into public.obra_access_links(organization_id,product_user_id,contact_id,lead_id,
    receipt_id,modality,plan,activated_at)
    values(p_organization_id,r.product_user_id,p_contact_id,p_lead_id,r.id,
      r.modality,r.plan,r.occurred_at)
    on conflict (organization_id,receipt_id) do update set
      contact_id=excluded.contact_id,lead_id=excluded.lead_id;
  update public.obra_access_receipts set status='ready',reason=null,contact_id=p_contact_id,
    lead_id=p_lead_id where id=r.id;
  insert into public.api_audit_log(organization_id,actor_user_id,action,resource_type,
    resource_id,request_id,metadata)
    values(p_organization_id,p_actor_user_id,'obra_access.manual_link','obra_access_receipt',
      r.id,p_request_id::text,jsonb_build_object('contact_id',p_contact_id,'lead_id',p_lead_id,
        'previous_contact_id',r.contact_id,'previous_lead_id',r.lead_id));
  return jsonb_build_object('status','ready','receipt_id',r.id);
end $$;
revoke execute on function public.fn_manual_link_obra_access(uuid,uuid,uuid,uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.fn_manual_link_obra_access(uuid,uuid,uuid,uuid,uuid,uuid) to service_role;

notify pgrst,'reload schema';
