-- Publicos de lista e agendamento no event_log existente. A RPC 0218 continua
-- disponivel para pedidos ja publicados; nenhum dado nem SQL aplicado e reescrito.
alter table public.whatsapp_campaigns add column if not exists scheduled_at timestamptz;
alter table public.whatsapp_campaigns drop constraint if exists whatsapp_campaigns_status_check;
alter table public.whatsapp_campaigns add constraint whatsapp_campaigns_status_check
  check (status in ('scheduled', 'running', 'completed'));
alter table public.whatsapp_campaigns drop constraint if exists whatsapp_campaigns_filters_check;
alter table public.whatsapp_campaigns add constraint whatsapp_campaigns_filters_check
  check (filters = '{"mode":"list"}'::jsonb or
    (jsonb_typeof(filters) = 'object' and length(filters->>'tag') > 0
      and filters ? 'tag' and (filters - 'tag' - 'source') = '{}'::jsonb));

create or replace function public.prepare_whatsapp_campaign(
  p_id uuid, p_organization_id uuid, p_created_by uuid, p_name text,
  p_channel_session_id uuid, p_steps jsonb, p_filters jsonb, p_hourly_limit integer,
  p_audience jsonb, p_scheduled_at timestamptz
) returns uuid language plpgsql security invoker set search_path = public as $$
declare
  v integer;
  item jsonb;
  contact uuid;
begin
  -- Serializa retries antes de criar contatos ou emitir qualquer evento.
  perform pg_advisory_xact_lock(hashtextextended(p_id::text, 219));
  if exists (select 1 from whatsapp_campaigns where id = p_id) then
    if not exists (select 1 from whatsapp_campaigns where id = p_id and organization_id = p_organization_id) then
      raise exception 'campaign_id_conflict' using errcode = '22023';
    end if;
    return p_id;
  end if;
  if p_scheduled_at is not null and (not isfinite(p_scheduled_at) or p_scheduled_at <= clock_timestamp()) then
    raise exception 'schedule_must_be_future' using errcode = '22023';
  end if;
  if p_audience is null then
    -- Preserva exatamente o recorte e a validacao de tag/origem ja homologados.
    perform public.launch_whatsapp_campaign(p_id, p_organization_id, p_created_by,
      p_name, p_channel_session_id, p_steps, p_filters, p_hourly_limit);
  else
    if jsonb_typeof(p_audience) <> 'array' or jsonb_array_length(p_audience) not between 1 and 500
      or p_filters <> '{}'::jsonb then
      raise exception 'invalid_audience' using errcode = '22023';
    end if;
    if p_steps is null or jsonb_typeof(p_steps) <> 'array' or jsonb_array_length(p_steps) not between 1 and 20 then
      raise exception 'invalid_steps' using errcode = '22023';
    end if;
    for v in 0 .. jsonb_array_length(p_steps) - 1 loop
      if coalesce(length(btrim(p_steps -> v ->> 'message')), 0) not between 1 and 4096
        or p_steps -> v ->> 'delay_minutes' is null
        or (p_steps -> v ->> 'delay_minutes')::integer not between 0 and 43200 then
        raise exception 'invalid_steps' using errcode = '22023';
      end if;
    end loop;
    if not exists (select 1 from channel_sessions where id = p_channel_session_id
      and organization_id = p_organization_id and archived_at is null and status = 'WORKING') then
      raise exception 'invalid_channel' using errcode = '22023';
    end if;
    insert into whatsapp_campaigns(id, organization_id, created_by, name, channel_session_id, steps, filters, hourly_limit)
      values (p_id, p_organization_id, p_created_by, p_name, p_channel_session_id, p_steps, '{"mode":"list"}', p_hourly_limit);
    for item in select value from jsonb_array_elements(p_audience) loop
      if coalesce(item->>'phone_number', '') !~ '^\+[0-9]{8,15}$' then
        raise exception 'invalid_phone' using errcode = '22023';
      end if;
      -- O upsert da casa resolve nono digito, unique_violation e org local.
      -- Sem chat/lid inventado, consentimento fabricado ou arquivo bruto salvo.
      contact := public.fn_upsert_wa_contact(p_organization_id, 'phone', item->>'phone_number', null, null, null);
      if contact is null then raise exception 'contact_upsert_failed'; end if;
      update contacts set name = left(nullif(btrim(item->>'name'), ''), 200)
        where id = contact and organization_id = p_organization_id and name is null and not is_anonymized;
      insert into whatsapp_campaign_recipients(organization_id, campaign_id, contact_id)
        values (p_organization_id, p_id, contact) on conflict (campaign_id, contact_id) do nothing;
    end loop;
    insert into whatsapp_campaign_recipient_steps(organization_id, campaign_id, contact_id, step_index)
      select p_organization_id, p_id, contact_id, 0 from whatsapp_campaign_recipients
        where organization_id = p_organization_id and campaign_id = p_id
      on conflict (campaign_id, contact_id, step_index) do nothing;
    perform public.emit_event('whatsapp_campaign.requested', 'whatsapp_campaign', p_id,
      jsonb_build_object('step_index', 0), jsonb_build_object('actor_user_id', p_created_by), p_organization_id);
  end if;
  if p_scheduled_at is not null then
    update whatsapp_campaigns set status = 'scheduled', scheduled_at = p_scheduled_at
      where id = p_id and organization_id = p_organization_id;
    update event_log set next_attempt_at = p_scheduled_at
      where entity_id = p_id and organization_id = p_organization_id
        and event_type = 'whatsapp_campaign.requested';
  end if;
  return p_id;
end $$;
revoke execute on function public.prepare_whatsapp_campaign(uuid,uuid,uuid,text,uuid,jsonb,jsonb,integer,jsonb,timestamptz) from public, anon, authenticated;
grant execute on function public.prepare_whatsapp_campaign(uuid,uuid,uuid,text,uuid,jsonb,jsonb,integer,jsonb,timestamptz) to service_role;

create or replace function public.start_scheduled_whatsapp_campaign(p_organization_id uuid, p_campaign_id uuid)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare
  c whatsapp_campaigns%rowtype;
begin
  select * into c from whatsapp_campaigns
    where id = p_campaign_id and organization_id = p_organization_id for update;
  if not found then return jsonb_build_object('done', true); end if;
  if c.status = 'scheduled' then
    if c.scheduled_at > clock_timestamp() then return jsonb_build_object('retry_at', c.scheduled_at); end if;
    update whatsapp_campaigns set status = 'running', started_at = clock_timestamp()
      where id = p_campaign_id and organization_id = p_organization_id returning * into c;
  end if;
  return jsonb_build_object('status', c.status, 'started_at', c.started_at);
end $$;
revoke execute on function public.start_scheduled_whatsapp_campaign(uuid,uuid) from public, anon, authenticated;
grant execute on function public.start_scheduled_whatsapp_campaign(uuid,uuid) to service_role;

notify pgrst, 'reload schema';
