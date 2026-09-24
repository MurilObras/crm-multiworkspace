-- Gerenciamento preserva o ledger, as regras e a identidade pública da integração.
alter table public.kiwify_integrations add column if not exists archived_at timestamptz;
alter table public.kiwify_integrations drop constraint if exists kiwify_integrations_organization_id_store_id_key;
create unique index if not exists kiwify_active_store_key
  on public.kiwify_integrations(organization_id,store_id) where archived_at is null;
create unique index if not exists automation_rules_org_id_key on public.automation_rules(organization_id,id);
create table if not exists public.kiwify_automation_links (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  integration_id uuid not null,
  rule_id uuid not null,
  primary key(organization_id,integration_id,rule_id),
  foreign key(organization_id,integration_id) references public.kiwify_integrations(organization_id,id),
  foreign key(organization_id,rule_id) references public.automation_rules(organization_id,id) on delete cascade
);
alter table public.kiwify_automation_links enable row level security;
revoke all on public.kiwify_automation_links from public,anon,authenticated;
grant all on public.kiwify_automation_links to service_role;

-- Uma única passagem: reaplicar o baseline NÃO restaura vínculos removidos.
-- Regras genéricas também recebiam compras antes desta mudança. Preservamos
-- esse universo; o motor continua avaliando todas as condições originais.
alter table public.automation_rules add column if not exists kiwify_links_initialized boolean not null default false;
do $$ begin
insert into public.kiwify_automation_links(organization_id,integration_id,rule_id)
select r.organization_id,i.id,r.id from public.automation_rules r
join public.kiwify_integrations i on i.organization_id=r.organization_id
where not r.kiwify_links_initialized and r.trigger_event='lead.created'
on conflict do nothing;
update public.automation_rules set kiwify_links_initialized=true where not kiwify_links_initialized;
end $$;
alter table public.automation_rules alter column kiwify_links_initialized set default true;

create or replace function public.fn_manage_kiwify(
  p_organization_id uuid,p_integration_id uuid,p_operation text,p_config jsonb,
  p_secret_encrypted bytea,p_actor_user_id uuid,p_request_id uuid
) returns uuid language plpgsql security invoker set search_path=public,pg_temp as $$
declare s public.kiwify_integrations; m jsonb; v_rule uuid;
begin
  if not exists(select 1 from public.user_organizations where organization_id=p_organization_id
    and user_id=p_actor_user_id and revoked_at is null and accepted_at is not null
    and role in ('manager','admin')) then
    raise exception 'invalid_configuration_actor' using errcode='42501';
  end if;
  select * into s from public.kiwify_integrations
    where organization_id=p_organization_id and id=p_integration_id for update;
  if not found then raise exception 'integration_not_found'; end if;
  if p_operation='archive' then
    if s.archived_at is not null then return s.id; end if;
    update public.kiwify_integrations set archived_at=now(),is_active=false
      where organization_id=p_organization_id and id=s.id;
  elsif s.archived_at is not null then raise exception 'integration_archived';
  elsif p_operation='edit' then
    if coalesce(length(btrim(p_config->>'name')),0) not between 1 and 100
      or coalesce(p_config->>'store_id','') !~ '^[a-zA-Z0-9_-]{1,128}$'
      or jsonb_typeof(p_config->'products') is distinct from 'array'
      then raise exception 'invalid_configuration'; end if;
    if jsonb_array_length(p_config->'products') not between 1 and 100 then raise exception 'invalid_product'; end if;
    if not exists(select 1 from public.crm_pipelines where organization_id=p_organization_id
      and id=(p_config->>'pipeline_id')::uuid) then raise exception 'invalid_pipeline'; end if;
    if not exists(select 1 from public.crm_stages where organization_id=p_organization_id
      and pipeline_id=(p_config->>'pipeline_id')::uuid and id=(p_config->>'stage_id')::uuid)
      then raise exception 'invalid_stage'; end if;
    for m in select * from jsonb_array_elements(p_config->'products') loop
      if coalesce(m->>'external_product_id','') !~ '^[a-zA-Z0-9_-]{1,128}$'
        or not exists(select 1 from public.catalog_products where organization_id=p_organization_id
          and id=(m->>'product_id')::uuid and ativo) then raise exception 'invalid_product'; end if;
    end loop;
    if (select count(distinct x->>'external_product_id') from jsonb_array_elements(p_config->'products') x)
      <> jsonb_array_length(p_config->'products') then raise exception 'duplicate_mapping'; end if;
    update public.kiwify_integrations set name=btrim(p_config->>'name'),store_id=p_config->>'store_id',
      pipeline_id=(p_config->>'pipeline_id')::uuid,stage_id=(p_config->>'stage_id')::uuid,
      secret_encrypted=coalesce(p_secret_encrypted,s.secret_encrypted)
      where organization_id=p_organization_id and id=s.id;
    delete from public.kiwify_product_mappings where organization_id=p_organization_id and integration_id=s.id;
    insert into public.kiwify_product_mappings(organization_id,integration_id,external_product_id,product_id)
      select p_organization_id,s.id,x->>'external_product_id',(x->>'product_id')::uuid
      from jsonb_array_elements(p_config->'products') x;
  elsif p_operation in ('link','unlink') then
    v_rule := (p_config->>'rule_id')::uuid;
    perform id from public.automation_rules where organization_id=p_organization_id and id=v_rule for update;
    if not found then raise exception 'automation_not_found'; end if;
    if p_operation='link' then
      if not exists(select 1 from public.automation_rules where organization_id=p_organization_id
        and id=v_rule and trigger_event='lead.created'
        and conditions @> '[{"field":"event.kiwify_event_type","op":"eq","value":"order_approved"}]'::jsonb)
        then raise exception 'incompatible_automation'; end if;
      insert into public.kiwify_automation_links values(p_organization_id,s.id,v_rule) on conflict do nothing;
    else
      delete from public.kiwify_automation_links where organization_id=p_organization_id
        and integration_id=s.id and rule_id=v_rule;
    end if;
  else raise exception 'invalid_operation'; end if;
  insert into public.api_audit_log(organization_id,actor_user_id,action,resource_type,resource_id,request_id,metadata)
    values(p_organization_id,p_actor_user_id,'kiwify.'||p_operation,'kiwify_integration',s.id,p_request_id::text,
      case when v_rule is null then '{}'::jsonb else jsonb_build_object('rule_id',v_rule) end);
  return s.id;
end $$;
revoke execute on function public.fn_manage_kiwify(uuid,uuid,text,jsonb,bytea,uuid,uuid) from public,anon,authenticated;
grant execute on function public.fn_manage_kiwify(uuid,uuid,text,jsonb,bytea,uuid,uuid) to service_role;
-- Criação recebe a mesma validação tenant-aware da edição; nenhum mapeamento
-- inativo é aceito para só descobrir o erro quando a primeira compra chegar.
create or replace function public.fn_configure_kiwify(p_organization_id uuid,p_config jsonb,p_token text,
  p_secret_encrypted bytea,p_request_id uuid,p_actor_user_id uuid) returns uuid
language plpgsql security invoker set search_path=public,pg_temp as $$
declare v_id uuid; m jsonb;
begin
  if not exists(select 1 from public.user_organizations where organization_id=p_organization_id
    and user_id=p_actor_user_id and revoked_at is null and accepted_at is not null and role in ('manager','admin'))
    then raise exception 'invalid_configuration_actor' using errcode='42501'; end if;
  if p_secret_encrypted is null or p_token is null or p_token !~ '^[a-f0-9]{64}$'
    or coalesce(length(btrim(p_config->>'name')),0) not between 1 and 100
    or coalesce(p_config->>'store_id','') !~ '^[a-zA-Z0-9_-]{1,128}$'
    or jsonb_typeof(p_config->'products') is distinct from 'array' then raise exception 'invalid_configuration'; end if;
  if jsonb_array_length(p_config->'products') not between 1 and 100 then raise exception 'invalid_product'; end if;
  if not exists(select 1 from public.crm_pipelines where organization_id=p_organization_id and id=(p_config->>'pipeline_id')::uuid)
    then raise exception 'invalid_pipeline'; end if;
  if not exists(select 1 from public.crm_stages where organization_id=p_organization_id
    and pipeline_id=(p_config->>'pipeline_id')::uuid and id=(p_config->>'stage_id')::uuid) then raise exception 'invalid_stage'; end if;
  insert into public.kiwify_integrations(organization_id,store_id,name,path_token,secret_encrypted,pipeline_id,stage_id)
    values(p_organization_id,p_config->>'store_id',p_config->>'name',p_token,p_secret_encrypted,
      (p_config->>'pipeline_id')::uuid,(p_config->>'stage_id')::uuid) returning id into v_id;
  for m in select * from jsonb_array_elements(p_config->'products') loop
    if not exists(select 1 from public.catalog_products where organization_id=p_organization_id and id=(m->>'product_id')::uuid and ativo)
      then raise exception 'invalid_product'; end if;
    insert into public.kiwify_product_mappings values(p_organization_id,v_id,m->>'external_product_id',(m->>'product_id')::uuid);
  end loop;
  insert into public.api_audit_log(organization_id,actor_user_id,action,resource_type,resource_id,request_id)
    values(p_organization_id,p_actor_user_id,'kiwify.configured','kiwify_integration',v_id,p_request_id::text);
  return v_id;
end $$;
revoke execute on function public.fn_configure_kiwify(uuid,jsonb,text,bytea,uuid,uuid) from public,anon,authenticated;
grant execute on function public.fn_configure_kiwify(uuid,jsonb,text,bytea,uuid,uuid) to service_role;
notify pgrst,'reload schema';
