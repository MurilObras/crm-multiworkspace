-- 0232: textos do ciclo são configuração, mesmo sem número conectado.
alter table public.obra_access_integrations
  add column if not exists registration_message text check (length(registration_message)<=2000),
  add column if not exists usage_message text check (length(usage_message)<=2000),
  add column if not exists activation_message text check (length(activation_message)<=2000);

-- Preserva inclusive texto vazio (mensagem desativada) nas configurações antigas.
update public.obra_access_integrations i set
  registration_message=coalesce((select r.actions->0->'config'->>'template' from public.automation_rules r
    where r.organization_id=i.organization_id and r.id=i.registration_rule_id),'')
  where i.registration_rule_id is not null and i.registration_message is null;
update public.obra_access_integrations i set
  usage_message=coalesce((select r.actions->0->'config'->>'template' from public.automation_rules r
    where r.organization_id=i.organization_id and r.id=i.usage_rule_id),'')
  where i.usage_rule_id is not null and i.usage_message is null;
update public.obra_access_integrations i set
  activation_message=coalesce((select r.actions->0->'config'->>'template' from public.automation_rules r
    where r.organization_id=i.organization_id and r.id=i.activation_rule_id),'')
  where i.activation_rule_id is not null and i.activation_message is null;

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
  update public.obra_access_integrations set registration_message=p_registration,usage_message=p_usage,activation_message=p_activation,
    outreach_enabled=p_enabled,outreach_channel_id=p_channel,
    recovery_pointer_id=p_recovery,registration_rule_id=ids[1],usage_rule_id=ids[2],activation_rule_id=ids[3],updated_at=now()
    where organization_id=p_org and id=p_integration;
  return jsonb_build_object('outreach_enabled',p_enabled);
end $$;
revoke execute on function public.fn_configure_obra_outreach(uuid,uuid,boolean,uuid,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.fn_configure_obra_outreach(uuid,uuid,boolean,uuid,uuid,text,text,text) to service_role;


notify pgrst,'reload schema';
