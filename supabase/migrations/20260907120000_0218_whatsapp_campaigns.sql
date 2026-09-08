-- Campanhas: publico congelado, sequencias de mensagens e reservas irreversiveis
-- por canal antes do transporte. Um passo e IMEDIATO; os seguintes tem delay em
-- minutos. A cota por hora e COMPARTILHADA pelo mesmo channel_session entre
-- campanhas concorrentes, serializada por lock na sessao do canal.
create unique index if not exists campaigns_contacts_tenant_key on public.contacts(organization_id, id);
create unique index if not exists campaigns_channels_tenant_key on public.channel_sessions(organization_id, id);
create unique index if not exists campaigns_messages_tenant_key on public.messages(organization_id, contact_id, id);

create table if not exists public.whatsapp_campaigns (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 120),
  channel_session_id uuid not null,
  steps jsonb not null check (jsonb_typeof(steps) = 'array' and jsonb_array_length(steps) between 1 and 20),
  filters jsonb not null check (jsonb_typeof(filters) = 'object' and length(filters->>'tag') > 0
    and filters ? 'tag' and (filters - 'tag' - 'source') = '{}'::jsonb),
  hourly_limit integer not null check (hourly_limit between 1 and 10000),
  status text not null default 'running' check (status in ('running', 'completed')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  started_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, channel_session_id)
    references public.channel_sessions(organization_id, id) on delete restrict
);
-- Publico congelado: um contato por campanha. Nenhum estado de envio mora aqui.
create table if not exists public.whatsapp_campaign_recipients (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  campaign_id uuid not null,
  contact_id uuid not null,
  created_at timestamptz not null default now(),
  unique (campaign_id, contact_id),
  foreign key (organization_id, campaign_id) references public.whatsapp_campaigns(organization_id, id) on delete cascade,
  foreign key (organization_id, contact_id) references public.contacts(organization_id, id) on delete restrict
);
-- Progresso POR destinatario E POR passo. Idempotencia (campaign, contact, step).
create table if not exists public.whatsapp_campaign_recipient_steps (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  campaign_id uuid not null,
  contact_id uuid not null,
  step_index integer not null check (step_index >= 0),
  status text not null default 'pending' check (status in ('pending','sent','failed','skipped_opt_out','stopped_reply')),
  message_id uuid,
  failure_reason text,
  created_at timestamptz not null default now(),
  processed_at timestamptz,
  reserved_at timestamptz,
  unique (campaign_id, contact_id, step_index),
  foreign key (organization_id, campaign_id) references public.whatsapp_campaigns(organization_id, id) on delete cascade,
  foreign key (organization_id, contact_id) references public.contacts(organization_id, id) on delete restrict,
  foreign key (organization_id, contact_id, message_id) references public.messages(organization_id, contact_id, id) on delete restrict
);
create index if not exists campaigns_org_created on public.whatsapp_campaigns(organization_id, created_at desc, id);
create index if not exists campaigns_step_claim on public.whatsapp_campaign_recipient_steps(organization_id, campaign_id, step_index, status, id);
create index if not exists campaigns_step_reservations on public.whatsapp_campaign_recipient_steps(campaign_id, reserved_at) where reserved_at is not null;

alter table public.whatsapp_campaigns enable row level security;
alter table public.whatsapp_campaign_recipients enable row level security;
alter table public.whatsapp_campaign_recipient_steps enable row level security;
drop policy if exists tenant_isolation_whatsapp_campaigns_read on public.whatsapp_campaigns;
create policy tenant_isolation_whatsapp_campaigns_read on public.whatsapp_campaigns for select to authenticated
  using (organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'viewer'));
drop policy if exists tenant_isolation_whatsapp_campaign_recipients_read on public.whatsapp_campaign_recipients;
create policy tenant_isolation_whatsapp_campaign_recipients_read on public.whatsapp_campaign_recipients for select to authenticated
  using (organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'viewer'));
drop policy if exists tenant_isolation_whatsapp_campaign_recipient_steps_read on public.whatsapp_campaign_recipient_steps;
create policy tenant_isolation_whatsapp_campaign_recipient_steps_read on public.whatsapp_campaign_recipient_steps for select to authenticated
  using (organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'viewer'));
revoke all on public.whatsapp_campaigns, public.whatsapp_campaign_recipients, public.whatsapp_campaign_recipient_steps from public, anon, authenticated;
grant select on public.whatsapp_campaigns, public.whatsapp_campaign_recipients, public.whatsapp_campaign_recipient_steps to authenticated;
grant all on public.whatsapp_campaigns, public.whatsapp_campaign_recipients, public.whatsapp_campaign_recipient_steps to service_role;

create or replace function public.launch_whatsapp_campaign(
  p_id uuid, p_organization_id uuid, p_created_by uuid, p_name text,
  p_channel_session_id uuid, p_steps jsonb, p_filters jsonb, p_hourly_limit integer
) returns uuid language plpgsql security invoker set search_path = public as $$
declare
  v integer;
begin
  -- Apenas backend autorizado; o UUID do pedido torna uma repeticao HTTP inofensiva.
  if exists (select 1 from whatsapp_campaigns where id = p_id and organization_id = p_organization_id) then
    return p_id;
  end if;
  if jsonb_typeof(p_steps) <> 'array' or jsonb_array_length(p_steps) < 1 or jsonb_array_length(p_steps) > 20 then
    raise exception 'invalid_steps' using errcode = '22023';
  end if;
  for v in 0 .. jsonb_array_length(p_steps) - 1 loop
    if p_steps -> v ->> 'message' is null or length(btrim(p_steps -> v ->> 'message')) = 0 then
      raise exception 'invalid_steps' using errcode = '22023';
    end if;
    if p_steps -> v ->> 'delay_minutes' is null or (p_steps -> v ->> 'delay_minutes')::integer < 0 then
      raise exception 'invalid_steps' using errcode = '22023';
    end if;
  end loop;
  if not exists (select 1 from channel_sessions where id = p_channel_session_id
    and organization_id = p_organization_id and archived_at is null and status = 'WORKING') then
    raise exception 'invalid_channel' using errcode = '22023';
  end if;
  insert into whatsapp_campaigns(id, organization_id, created_by, name, channel_session_id, steps, filters, hourly_limit)
    values (p_id, p_organization_id, p_created_by, p_name, p_channel_session_id, p_steps, p_filters, p_hourly_limit)
    on conflict (id) do nothing;
  if not found then
    if not exists (select 1 from whatsapp_campaigns where id = p_id and organization_id = p_organization_id) then
      raise exception 'campaign_id_conflict' using errcode = '22023';
    end if;
    return p_id;
  end if;
  -- Mesmo recorte de contacts/_handler.ts: tag contains + source eq, sem fundidos.
  insert into whatsapp_campaign_recipients(organization_id, campaign_id, contact_id)
    select p_organization_id, p_id, id from contacts
    where organization_id = p_organization_id and is_merged_into is null
      and tags @> array[p_filters->>'tag']
      and (p_filters->>'source' is null or source = p_filters->>'source')
    on conflict (campaign_id, contact_id) do nothing;
  -- Passo 0 imediato para todo o publico congelado; passos seguintes nascem sob demanda.
  insert into whatsapp_campaign_recipient_steps(organization_id, campaign_id, contact_id, step_index)
    select p_organization_id, p_id, contact_id, 0 from whatsapp_campaign_recipients
    where organization_id = p_organization_id and campaign_id = p_id
    on conflict (campaign_id, contact_id, step_index) do nothing;
  perform public.emit_event('whatsapp_campaign.requested', 'whatsapp_campaign', p_id,
    jsonb_build_object('step_index', 0), jsonb_build_object('actor_user_id', p_created_by), p_organization_id);
  return p_id;
end $$;
revoke execute on function public.launch_whatsapp_campaign(uuid,uuid,uuid,text,uuid,jsonb,jsonb,integer) from public, anon, authenticated;
grant execute on function public.launch_whatsapp_campaign(uuid,uuid,uuid,text,uuid,jsonb,jsonb,integer) to service_role;

create or replace function public.claim_whatsapp_campaign_step(
  p_organization_id uuid, p_campaign_id uuid, p_step_index integer, p_contact_id uuid default null
) returns jsonb language plpgsql security invoker set search_path = public as $$
declare
  c whatsapp_campaigns%rowtype;
  r whatsapp_campaign_recipient_steps%rowtype;
  used bigint;
  oldest timestamptz;
  newest timestamptz;
  t timestamptz;
begin
  -- Serializa a campanha para enxergar um estado consistente.
  select * into c from whatsapp_campaigns where organization_id = p_organization_id and id = p_campaign_id for update;
  if not found or c.status <> 'running' then return jsonb_build_object('done', true); end if;
  -- A cota por hora e do NUMERO: lock na sessao serializa a reserva entre campanhas concorrentes.
  perform 1 from channel_sessions where id = c.channel_session_id and organization_id = p_organization_id for update;
  t := clock_timestamp();
  if p_contact_id is null then
    select * into r from whatsapp_campaign_recipient_steps where organization_id = p_organization_id
      and campaign_id = c.id and step_index = p_step_index and status = 'pending' and reserved_at is null
      order by id limit 1 for update;
  else
    select * into r from whatsapp_campaign_recipient_steps where organization_id = p_organization_id
      and campaign_id = c.id and step_index = p_step_index and contact_id = p_contact_id
      and status = 'pending' and reserved_at is null limit 1 for update;
  end if;
  if not found then
    if not exists (select 1 from whatsapp_campaign_recipient_steps where organization_id = p_organization_id
      and campaign_id = c.id and status = 'pending') then
      update whatsapp_campaigns set status = 'completed' where id = c.id and organization_id = p_organization_id;
    end if;
    return jsonb_build_object('done', true);
  end if;
  select count(*), min(s.reserved_at), max(s.reserved_at) into used, oldest, newest
    from whatsapp_campaign_recipient_steps s
    join whatsapp_campaigns cc on cc.id = s.campaign_id and cc.organization_id = s.organization_id
    where s.organization_id = p_organization_id and cc.organization_id = p_organization_id
      and cc.channel_session_id = c.channel_session_id and s.reserved_at > t - interval '1 hour';
  if used >= c.hourly_limit then return jsonb_build_object('retry_at', oldest + interval '1 hour'); end if;
  if newest > t - interval '5 seconds' then return jsonb_build_object('retry_at', newest + interval '5 seconds'); end if;
  -- Falha conservadora ANTES da rede: queda do processo nunca devolve a pending.
  update whatsapp_campaign_recipient_steps set reserved_at = t, status = 'failed',
    failure_reason = 'send_uncertain_manual_inspection', processed_at = t
    where id = r.id and organization_id = p_organization_id and campaign_id = c.id;
  return jsonb_build_object('step_id', r.id, 'contact_id', r.contact_id);
end $$;
revoke execute on function public.claim_whatsapp_campaign_step(uuid,uuid,integer,uuid) from public, anon, authenticated;
grant execute on function public.claim_whatsapp_campaign_step(uuid,uuid,integer,uuid) to service_role;

create or replace function public.finalize_whatsapp_campaign_step(
  p_organization_id uuid, p_campaign_id uuid, p_contact_id uuid,
  p_step_index integer, p_status text, p_message_id uuid default null, p_failure_reason text default null
) returns boolean language plpgsql security invoker set search_path = public as $$
declare
  c whatsapp_campaigns%rowtype;
  n_steps integer;
  next_idx integer;
  step_delay integer;
  due timestamptz;
  updated_id uuid;
begin
  -- So a linha reservada (status='failed' incerto) pode ser finalizada uma unica vez.
  update whatsapp_campaign_recipient_steps set status = p_status,
      message_id = coalesce(p_message_id, message_id),
      failure_reason = p_failure_reason, processed_at = now()
    where organization_id = p_organization_id and campaign_id = p_campaign_id
      and contact_id = p_contact_id and step_index = p_step_index and status = 'failed'
    returning id into updated_id;
  if not found then return false; end if;
  if p_status <> 'sent' then return true; end if;
  select * into c from whatsapp_campaigns where organization_id = p_organization_id and id = p_campaign_id;
  if not found then return true; end if;
  n_steps := jsonb_array_length(c.steps);
  next_idx := p_step_index + 1;
  if next_idx >= n_steps then return true; end if;
  step_delay := coalesce((c.steps -> next_idx ->> 'delay_minutes')::integer, 0);
  insert into whatsapp_campaign_recipient_steps(organization_id, campaign_id, contact_id, step_index)
    values (p_organization_id, p_campaign_id, p_contact_id, next_idx)
    on conflict (campaign_id, contact_id, step_index) do nothing;
  due := now() + (step_delay * interval '1 minute');
  insert into event_log(organization_id, event_type, entity_kind, entity_id, payload, metadata, next_attempt_at)
    values (p_organization_id, 'whatsapp_campaign.requested', 'whatsapp_campaign', p_campaign_id,
      jsonb_build_object('step_index', next_idx, 'contact_id', p_contact_id),
      jsonb_build_object('actor_user_id', c.created_by), due);
  return true;
end $$;
revoke execute on function public.finalize_whatsapp_campaign_step(uuid,uuid,uuid,integer,text,uuid,text) from public, anon, authenticated;
grant execute on function public.finalize_whatsapp_campaign_step(uuid,uuid,uuid,integer,text,uuid,text) to service_role;

notify pgrst, 'reload schema';
