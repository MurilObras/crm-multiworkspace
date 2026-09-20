-- 0220: entrada autenticada Kiwify; ledger + domínio + outbox na MESMA transação.
-- Configuração separada: seu token nunca resolve no webhook genérico.
create unique index if not exists catalog_products_org_id_key on public.catalog_products(organization_id, id);
create table if not exists public.kiwify_integrations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  store_id text not null check (length(store_id) between 1 and 128),
  name text not null,
  path_token text not null unique,
  secret_encrypted bytea not null,
  pipeline_id uuid not null references public.crm_pipelines(id),
  stage_id uuid not null references public.crm_stages(id),
  is_active boolean not null default true,
  unique(organization_id, store_id), unique(organization_id, id)
);
create table if not exists public.kiwify_product_mappings (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  integration_id uuid not null,
  external_product_id text not null check (length(external_product_id) between 1 and 128),
  product_id uuid not null,
  primary key(organization_id, integration_id, external_product_id),
  foreign key(organization_id, integration_id) references public.kiwify_integrations(organization_id, id),
  foreign key(organization_id, product_id) references public.catalog_products(organization_id, id)
);
create table if not exists public.kiwify_receipts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  integration_id uuid not null,
  order_id text not null check (length(order_id) between 1 and 128),
  event_type text not null check (length(event_type) between 1 and 128),
  fingerprint text not null check (fingerprint ~ '^[a-f0-9]{64}$'),
  -- Vocabulário aberto: accepted, accepted_no_phone, ignored, invalid.
  status text not null,
  reason text,
  external_id text not null,
  lead_id uuid references public.crm_leads(id) on delete set null,
  event_id uuid references public.event_log(id) on delete set null,
  conflict_count integer not null default 0,
  created_at timestamptz not null default now(),
  foreign key(organization_id, integration_id) references public.kiwify_integrations(organization_id, id),
  unique(organization_id, integration_id, order_id, event_type)
);
alter table public.kiwify_integrations enable row level security;
alter table public.kiwify_product_mappings enable row level security;
alter table public.kiwify_receipts enable row level security;
-- Só o servidor escreve/lê segredos. Ledger sem PII disponível ao tenant.
revoke all on public.kiwify_integrations, public.kiwify_product_mappings, public.kiwify_receipts from public, anon, authenticated;
grant all on public.kiwify_integrations, public.kiwify_product_mappings, public.kiwify_receipts to service_role;
grant select on public.kiwify_receipts to authenticated;
drop policy if exists tenant_isolation_kiwify_receipts_all on public.kiwify_receipts;
create policy tenant_isolation_kiwify_receipts_all on public.kiwify_receipts for select to authenticated
  using (organization_id in (select public.fn_user_org_ids()));

create or replace function public.fn_configure_kiwify(p_organization_id uuid, p_config jsonb, p_token text,
  p_secret_encrypted bytea, p_request_id uuid) returns uuid
language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_id uuid; m jsonb;
begin
  if p_secret_encrypted is null or p_token !~ '^[a-f0-9]{64}$'
    or jsonb_array_length(p_config->'products') < 1 then raise exception 'invalid_configuration'; end if;
  if not exists(select 1 from public.crm_stages s join public.crm_pipelines p on p.id=s.pipeline_id
    where s.id=(p_config->>'stage_id')::uuid and p.id=(p_config->>'pipeline_id')::uuid
      and s.organization_id=p_organization_id and p.organization_id=p_organization_id)
    then raise exception 'invalid_configuration'; end if;
  insert into public.kiwify_integrations(organization_id, store_id, name, path_token, secret_encrypted, pipeline_id, stage_id)
    values(p_organization_id, p_config->>'store_id', p_config->>'name', p_token, p_secret_encrypted,
      (p_config->>'pipeline_id')::uuid, (p_config->>'stage_id')::uuid) returning id into v_id;
  for m in select * from jsonb_array_elements(p_config->'products') loop
    insert into public.kiwify_product_mappings values(p_organization_id, v_id, m->>'external_product_id', (m->>'product_id')::uuid);
  end loop;
  insert into public.api_audit_log(organization_id, action, resource_type, resource_id, request_id)
    values(p_organization_id, 'kiwify.configured', 'kiwify_integration', v_id, p_request_id::text);
  return v_id;
end $$;
revoke execute on function public.fn_configure_kiwify(uuid,jsonb,text,bytea,uuid) from public, anon, authenticated;
grant execute on function public.fn_configure_kiwify(uuid,jsonb,text,bytea,uuid) to service_role;

create or replace function public.fn_ingest_kiwify(p_organization_id uuid, p_integration_id uuid,
  p_order jsonb, p_fingerprint text, p_request_id uuid, p_secret_encrypted bytea) returns jsonb
language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  s public.kiwify_integrations; r public.kiwify_receipts;
  v_product uuid; v_contact uuid; v_email_contact uuid; v_lead uuid; v_event uuid;
  v_external text; v_status text; v_reason text; v_phone text := p_order->>'phone';
  v_blocked boolean := false;
  v_contacts uuid[];
  v_anonymized boolean;
begin
  -- Serializa por integração, inclusive mudanças de configuração. UNIQUE é o árbitro durável.
  select * into s from public.kiwify_integrations
    where organization_id=p_organization_id and id=p_integration_id for update;
  if not found or not s.is_active or s.secret_encrypted is distinct from p_secret_encrypted then
    return jsonb_build_object('status','configuration_error'); end if;
  select * into r from public.kiwify_receipts where organization_id=p_organization_id
    and integration_id=s.id and order_id=p_order->>'order_id' and event_type=p_order->>'event_type';
  if found then
    if r.fingerprint <> p_fingerprint then
      update public.kiwify_receipts set conflict_count=conflict_count+1 where id=r.id and organization_id=p_organization_id;
      return jsonb_build_object('status','conflict','receipt_id',r.id);
    end if;
    return jsonb_build_object('status','duplicate','original_status',r.status,'receipt_id',r.id,'lead_id',r.lead_id);
  end if;
  if not exists(select 1 from public.crm_stages st join public.crm_pipelines p on p.id=st.pipeline_id
    where st.id=s.stage_id and p.id=s.pipeline_id and st.organization_id=p_organization_id and p.organization_id=p_organization_id)
    or not exists(select 1 from public.kiwify_product_mappings where organization_id=p_organization_id and integration_id=s.id)
    then return jsonb_build_object('status','configuration_error'); end if;
  select m.product_id into v_product from public.kiwify_product_mappings m
    join public.catalog_products p on p.id=m.product_id and p.organization_id=m.organization_id
    where m.organization_id=p_organization_id and m.integration_id=s.id
      and m.external_product_id=p_order->>'product_id' and p.ativo;
  v_external := 'kiwify:' || s.id || ':' || (p_order->>'order_id');
  v_status := 'accepted';
  if p_order->>'claimed_store_id' is not null and p_order->>'claimed_store_id' <> s.store_id then
    v_status := 'invalid'; v_reason := 'store_mismatch';
  elsif p_order->>'event_type' <> 'order_approved' or p_order->>'order_status' <> 'paid' then
    v_status := 'ignored'; v_reason := 'event_not_allowed';
  elsif v_product is null then v_status := 'ignored'; v_reason := 'product_not_allowed';
  elsif v_phone is null then v_status := 'accepted_no_phone'; v_reason := 'no_valid_phone';
  end if;
  if v_status in ('accepted','accepted_no_phone') then
    if v_phone is not null then
      -- Mesma organização; nunca atualizar cadastro, consentimento, opt-out ou anonimização.
      perform id from public.contacts where organization_id=p_organization_id
        and phone_number in (select jsonb_array_elements_text(p_order->'phone_variants'))
        and is_merged_into is null order by id for update;
      select array_agg(id order by id), bool_or(is_blocked), bool_or(is_anonymized) into v_contacts, v_blocked, v_anonymized
        from public.contacts where organization_id=p_organization_id
        and phone_number in (select jsonb_array_elements_text(p_order->'phone_variants')) and is_merged_into is null;
      v_contact := v_contacts[1];
      select id into v_email_contact from public.contacts where organization_id=p_organization_id
        and email_normalized=p_order->>'email' and is_merged_into is null;
      if coalesce(v_anonymized,false) or cardinality(v_contacts) > 1 then
        v_status := 'invalid'; v_reason := 'contact_identity_conflict';
      elsif v_email_contact is not null and v_email_contact is distinct from v_contact then
        v_status := 'invalid'; v_reason := 'contact_identity_conflict';
      elsif v_contact is null then
        -- Colisões com outras lojas/entradas: índice único + retry da transação inteira (503).
        insert into public.contacts(organization_id,name,phone_number,email,source)
          values(p_organization_id,coalesce(p_order->>'name','Comprador Kiwify'),v_phone,p_order->>'email','webhook')
          returning id into v_contact;
      end if;
    end if;
    if v_status <> 'invalid' then
      insert into public.crm_leads(organization_id,pipeline_id,stage_id,title,contact_id,currency,source,
        external_id,position_in_stage,source_metadata,custom_fields)
      values(p_organization_id,s.pipeline_id,s.stage_id,coalesce(p_order->>'name','Compra Kiwify'),v_contact,'BRL','webhook',
        v_external,coalesce((select max(position_in_stage)+1000 from public.crm_leads
          where organization_id=p_organization_id and stage_id=s.stage_id),1000),
        jsonb_build_object('provider','kiwify','integration_id',s.id,'external_id',v_external),
        jsonb_build_object('product_id',v_product,'kiwify_product_id',p_order->>'product_id')) returning id into v_lead;
      -- Sem telefone do payload, NÃO vincular contato por e-mail nem abrir fluxo WhatsApp.
      if v_phone is not null and not coalesce(v_blocked,false) then
        v_event := public.emit_event('lead.created','crm_lead',v_lead,
          jsonb_build_object('pipeline_id',s.pipeline_id,'stage_id',s.stage_id,'external_id',v_external,
            'product_id',v_product,'kiwify_event_type','order_approved'),
          jsonb_build_object('request_id',p_request_id,'external_id',v_external,'integration_id',s.id),p_organization_id);
      end if;
      if v_blocked then v_reason := 'contact_blocked'; end if;
    end if;
  end if;
  insert into public.kiwify_receipts(organization_id,integration_id,order_id,event_type,fingerprint,status,reason,external_id,lead_id,event_id)
    values(p_organization_id,s.id,p_order->>'order_id',p_order->>'event_type',p_fingerprint,v_status,v_reason,v_external,v_lead,v_event)
    returning * into r;
  -- Reusa o histórico visível e sua retenção; sem payload bruto/PII duplicados no ledger.
  insert into public.webhook_lead_captures(organization_id,source_name,lead_id,contact_id,outcome,reject_reason,fields,request_id)
    values(p_organization_id,s.name,v_lead,v_contact,case when v_lead is null then 'recusado' else 'criado' end,
      v_reason,jsonb_build_object('kiwify_receipt_id',r.id,'status',v_status,'external_id',v_external),p_request_id);
  insert into public.api_audit_log(organization_id,action,resource_type,resource_id,request_id,metadata)
    values(p_organization_id,'kiwify.received','kiwify_receipt',r.id,p_request_id::text,jsonb_build_object('status',v_status));
  return jsonb_build_object('status',v_status,'reason',v_reason,'receipt_id',r.id,'lead_id',v_lead);
end $$;
revoke execute on function public.fn_ingest_kiwify(uuid,uuid,jsonb,text,uuid,bytea) from public, anon, authenticated;
grant execute on function public.fn_ingest_kiwify(uuid,uuid,jsonb,text,uuid,bytea) to service_role;
