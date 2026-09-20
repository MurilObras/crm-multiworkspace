-- 0221: forward-fix da entrada Kiwify. Não reescrever a migration 0220.
-- Ator obrigatório, vindo da sessão validada pela API, nunca do p_config.
create or replace function public.fn_configure_kiwify(p_organization_id uuid, p_config jsonb, p_token text,
  p_secret_encrypted bytea, p_request_id uuid, p_actor_user_id uuid) returns uuid
language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_id uuid; m jsonb;
begin
  if p_actor_user_id is null or not exists (
    select 1 from public.user_organizations u where u.user_id=p_actor_user_id
      and u.organization_id=p_organization_id and u.revoked_at is null
      and u.accepted_at is not null and u.role in ('manager','admin')
  ) then raise exception 'invalid_configuration_actor' using errcode='42501'; end if;
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
  insert into public.api_audit_log(organization_id, actor_user_id, action, resource_type, resource_id, request_id)
    values(p_organization_id, p_actor_user_id, 'kiwify.configured', 'kiwify_integration', v_id, p_request_id::text);
  return v_id;
end $$;
revoke execute on function public.fn_configure_kiwify(uuid,jsonb,text,bytea,uuid,uuid) from public, anon, authenticated;
grant execute on function public.fn_configure_kiwify(uuid,jsonb,text,bytea,uuid,uuid) to service_role;
-- Não deixar sobrecarga alcançável que permita configuração sem autoria.
drop function if exists public.fn_configure_kiwify(uuid,jsonb,text,bytea,uuid);

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
  v_declined boolean := false;
begin
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
      perform id from public.contacts where organization_id=p_organization_id
        and phone_number in (select jsonb_array_elements_text(p_order->'phone_variants'))
        and is_merged_into is null order by id for update;
      -- Mesma semântica de checarGuardasDeContato: recusa truthy, não grant ausente.
      -- JSON null/false/0/string vazia e chave ausente são falsy em JavaScript.
      select array_agg(id order by id), bool_or(is_blocked), bool_or(is_anonymized),
        bool_or(coalesce((consent #> '{marketing,declined_at}') not in
          ('null'::jsonb,'false'::jsonb,'0'::jsonb,'""'::jsonb),false))
        into v_contacts, v_blocked, v_anonymized, v_declined
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
        insert into public.contacts(organization_id,name,phone_number,email,source)
          values(p_organization_id,coalesce(p_order->>'name','Comprador Kiwify'),v_phone,p_order->>'email','webhook')
          returning id into v_contact;
      end if;
    end if;
    if v_status <> 'invalid' then
      insert into public.crm_leads(organization_id,pipeline_id,stage_id,title,contact_id,currency,source,
        external_id,position_in_stage,source_metadata,custom_fields)
      values(p_organization_id,s.pipeline_id,s.stage_id,
        case when v_contact is null then 'Compra Kiwify' else coalesce(p_order->>'name','Compra Kiwify') end,
        v_contact,'BRL','webhook',v_external,
        coalesce((select max(position_in_stage)+1000 from public.crm_leads
          where organization_id=p_organization_id and stage_id=s.stage_id),1000),
        jsonb_build_object('provider','kiwify','integration_id',s.id,'external_id',v_external),
        jsonb_build_object('product_id',v_product,'kiwify_product_id',p_order->>'product_id')) returning id into v_lead;
      if v_phone is not null and not coalesce(v_blocked,false) and not coalesce(v_declined,false) then
        v_event := public.emit_event('lead.created','crm_lead',v_lead,
          jsonb_build_object('pipeline_id',s.pipeline_id,'stage_id',s.stage_id,'external_id',v_external,
            'product_id',v_product,'kiwify_event_type','order_approved'),
          jsonb_build_object('request_id',p_request_id,'external_id',v_external,'integration_id',s.id),p_organization_id);
      end if;
      if v_blocked then v_reason := 'contact_blocked';
      elsif v_declined then v_reason := 'consent_declined'; end if;
    end if;
  end if;
  insert into public.kiwify_receipts(organization_id,integration_id,order_id,event_type,fingerprint,status,reason,external_id,lead_id,event_id)
    values(p_organization_id,s.id,p_order->>'order_id',p_order->>'event_type',p_fingerprint,v_status,v_reason,v_external,v_lead,v_event)
    returning * into r;
  insert into public.webhook_lead_captures(organization_id,source_name,lead_id,contact_id,outcome,reject_reason,fields,request_id)
    values(p_organization_id,s.name,v_lead,v_contact,case when v_lead is null then 'recusado' else 'criado' end,
      v_reason,jsonb_build_object('kiwify_receipt_id',r.id,'status',v_status,'external_id',v_external),p_request_id);
  insert into public.api_audit_log(organization_id,action,resource_type,resource_id,request_id,metadata)
    values(p_organization_id,'kiwify.received','kiwify_receipt',r.id,p_request_id::text,jsonb_build_object('status',v_status,'reason',v_reason));
  return jsonb_build_object('status',v_status,'reason',v_reason,'receipt_id',r.id,'lead_id',v_lead);
end $$;
revoke execute on function public.fn_ingest_kiwify(uuid,uuid,jsonb,text,uuid,bytea) from public, anon, authenticated;
grant execute on function public.fn_ingest_kiwify(uuid,uuid,jsonb,text,uuid,bytea) to service_role;

-- Repara somente títulos do caminho órfão criado pela 0220. Sem associação por
-- e-mail e sem alterar a identidade/fingerprint durável dos recebimentos.
update public.crm_leads l set title='Compra Kiwify'
  where l.contact_id is null and l.source='webhook'
    and l.source_metadata->>'provider'='kiwify' and l.title is distinct from 'Compra Kiwify'
    and exists(select 1 from public.kiwify_receipts r where r.organization_id=l.organization_id
      and r.lead_id=l.id and r.status='accepted_no_phone');
notify pgrst, 'reload schema';
