-- Uma resposta interrompe a sequência. Um novo silêncio retoma a MESMA
-- inscrição, sem apagar etapas, repetir envios ou renovar o orçamento do fluxo.
alter table public.followup_enrollments add column if not exists silence_anchor_at timestamptz;

-- Retomar a mesma etapa também invalida jobs preparados antes da resposta.
create or replace function public.fn_followup_node_epoch() returns trigger
language plpgsql security invoker set search_path=public,pg_temp as $$
begin
  new.node_epoch:=old.node_epoch+case when new.current_node_id is distinct from old.current_node_id
    or (new.silence_anchor_at is distinct from old.silence_anchor_at) then 1 else 0 end;
  return new;
end $$;
revoke execute on function public.fn_followup_node_epoch() from public,anon,authenticated;

create or replace function public.fn_followup_complete_step(
  p_org uuid,p_id uuid,p_expected jsonb,p_event jsonb,p_patch jsonb
) returns boolean language plpgsql security invoker set search_path=public,pg_temp as $$
declare e public.followup_enrollments; n public.followup_enrollments; inserted_id uuid;
  enqueue_at timestamptz; manual_due timestamptz;
begin
  select * into e from public.followup_enrollments where organization_id=p_org and id=p_id for update;
  if not found or e.current_node_id is distinct from p_expected->>'current_node_id'
    or ((p_expected->>'node_epoch') is not null and e.node_epoch<>(p_expected->>'node_epoch')::integer)
    or (e.status not in ('active','waiting_reply','paused_manual','paused_handoff')
      and not coalesce((e.status='cancelled' and e.outcome='replied' and e.cancel_reason='cancel_on_reply'
        and p_event->>'event_type'='action_sent'),false)) then return false; end if;
  if p_event->'payload'->>'enrollment_action_key' is not null and
    p_event->'payload'->>'enrollment_action_key' is distinct from (
      select ev.idempotency_key from public.followup_enrollment_events ev where ev.organization_id=p_org
        and ev.enrollment_id=e.id and ev.node_id=e.current_node_id and ev.event_type in ('turn_enqueued','classify_enqueued')
      order by substring(ev.idempotency_key from '([0-9]+)$')::integer desc nulls last limit 1)
    then return false; end if;
  if e.status not in ('active','waiting_reply') or e.status is distinct from p_expected->>'status'
    or e.current_node_id is distinct from p_expected->>'current_node_id'
    or e.steps_taken is distinct from (p_expected->>'steps_taken')::integer
    or e.updated_at is distinct from (p_expected->>'updated_at')::timestamptz then
    -- A rede já confirmou o envio: conserva a prova, SEM mudar a pausa/nó.
    -- Ao retomar, o motor reconhece action_sent e avança sem reenviar.
    if p_event->>'event_type'='action_sent' and not exists(select 1 from public.followup_enrollment_events ev
      where ev.organization_id=p_org and ev.enrollment_id=p_id and ev.idempotency_key=p_event->>'idempotency_key'
        and ev.event_type='action_sent') then
      insert into public.followup_enrollment_events(organization_id,enrollment_id,node_id,event_type,payload,idempotency_key)
        values(p_org,p_id,e.current_node_id,'action_sent',coalesce(p_event->'payload','{}'),
          (p_event->>'idempotency_key')||':confirmed') on conflict do nothing;
    end if;
    return false;
  end if;
  if p_event->>'node_id' is distinct from e.current_node_id then return false; end if;
  n:=jsonb_populate_record(e,p_patch);
  -- O turno pode ter começado ANTES de uma remarcação. Conserva a conclusão,
  -- mas o próximo passo continua no último prazo escolhido pela pessoa.
  select ev.created_at into enqueue_at from public.followup_enrollment_events ev
    where ev.organization_id=p_org and ev.enrollment_id=p_id and ev.node_id=e.current_node_id
      and ev.event_type in ('turn_enqueued','classify_enqueued')
      and (p_event->'payload'->>'enrollment_action_key' is null
        or ev.idempotency_key=p_event->'payload'->>'enrollment_action_key')
    order by ev.created_at desc,ev.id desc limit 1;
  if enqueue_at is not null then
    select coalesce((ev.payload->>'next_eval_at')::timestamptz,ev.created_at+interval '30 minutes') into manual_due
      from public.followup_enrollment_events ev where ev.organization_id=p_org and ev.enrollment_id=p_id
        and ev.node_id=e.current_node_id and ev.created_at>enqueue_at
        and ev.event_type in ('resumed_manual','snoozed_manual','handoff_resumed')
      order by ev.created_at desc,ev.id desc limit 1;
    if n.status in ('active','waiting_reply') and manual_due>clock_timestamp() then
      n.next_eval_at:=greatest(n.next_eval_at,manual_due);
    end if;
  end if;
  insert into public.followup_enrollment_events(organization_id,enrollment_id,node_id,event_type,payload,idempotency_key)
    values(p_org,p_id,e.current_node_id,p_event->>'event_type',coalesce(p_event->'payload','{}'),p_event->>'idempotency_key')
    on conflict(enrollment_id,idempotency_key) where idempotency_key is not null do nothing returning id into inserted_id;
  if inserted_id is null then
    -- Um recheck pode ter gravado a chave antes de atualizar a inscrição.
    if p_event->>'event_type'='action_sent' and not exists(select 1 from public.followup_enrollment_events ev
      where ev.organization_id=p_org and ev.enrollment_id=p_id and ev.idempotency_key=p_event->>'idempotency_key'
        and ev.event_type='action_sent') then
      insert into public.followup_enrollment_events(organization_id,enrollment_id,node_id,event_type,payload,idempotency_key)
        values(p_org,p_id,e.current_node_id,'action_sent',coalesce(p_event->'payload','{}'),
          (p_event->>'idempotency_key')||':confirmed') on conflict do nothing;
    end if;
    return false;
  end if;
  update public.followup_enrollments set current_node_id=n.current_node_id,status=n.status,
    next_eval_at=n.next_eval_at,claimed_until=n.claimed_until,steps_taken=n.steps_taken,
    timing_plan=n.timing_plan,updated_at=n.updated_at where organization_id=p_org and id=p_id;
  return true;
end $$;
revoke execute on function public.fn_followup_complete_step(uuid,uuid,jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.fn_followup_complete_step(uuid,uuid,jsonb,jsonb,jsonb) to service_role;

create or replace function public.fn_followup_job_live(p_org uuid,p_job uuid,p_contact uuid)
returns boolean language sql stable security invoker set search_path=public,pg_temp as $$
  select exists(select 1 from public.job_queue j where j.organization_id=p_org and j.id=p_job
    and j.contact_id is not distinct from p_contact and (
      j.kind<>'followup_turn' or j.payload->>'followup_enrollment_id' is null or exists(
        select 1 from public.followup_enrollments e join public.followup_flow_pointers p
          on p.id=e.pointer_id and p.organization_id=e.organization_id
        where e.organization_id=p_org and e.contact_id=p_contact
          and e.id::text=j.payload->>'followup_enrollment_id'
          and e.status in ('active','waiting_reply') and p.status='active'
          and e.current_node_id=j.payload->>'node_id'
          and (j.payload->>'node_epoch' is null or e.node_epoch=(j.payload->>'node_epoch')::integer)
          and (j.payload->>'node_epoch' is not null or not exists(select 1 from public.followup_enrollment_events ev
            where ev.organization_id=p_org and ev.enrollment_id=e.id and ev.created_at>j.created_at and ev.node_id<>e.current_node_id))
          and (j.payload->>'enrollment_action_key' is null or j.payload->>'enrollment_action_key'=(
            select ev.idempotency_key from public.followup_enrollment_events ev
            where ev.organization_id=p_org and ev.enrollment_id=e.id and ev.node_id=e.current_node_id
              and ev.event_type in ('turn_enqueued','classify_enqueued')
            order by substring(ev.idempotency_key from '([0-9]+)$')::integer desc nulls last limit 1))
          and (coalesce(p.trigger_config->'cancel_on_reply'='true'::jsonb,false)=false or not exists(
            select 1 from public.messages m where m.organization_id=p_org and m.contact_id=p_contact
              and m.direction='inbound' and m.sent_at>coalesce(e.silence_anchor_at,e.started_at)))
      )))
$$;
revoke execute on function public.fn_followup_job_live(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.fn_followup_job_live(uuid,uuid,uuid) to service_role;

-- O relógio anterior fica no evento para a retomada nunca antecipar a etapa.
-- O status anterior impede que uma resposta desfaça uma pausa manual/humana.
create or replace function public.fn_cancel_followup_on_reply() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare e public.followup_enrollments;
begin
  if new.direction<>'inbound' then return new; end if;
  for e in select f.* from public.followup_enrollments f
    join public.followup_flow_pointers p on p.organization_id=f.organization_id and p.id=f.pointer_id
    where f.organization_id=new.organization_id and f.contact_id=new.contact_id
      and f.status in ('active','waiting_reply','paused_handoff','paused_manual')
      and new.sent_at>coalesce(f.silence_anchor_at,f.started_at)
      and coalesce(p.trigger_config->'cancel_on_reply'='true'::jsonb,false)
    for update of f
  loop
    update public.followup_enrollments set status='cancelled',outcome='replied',cancel_reason='cancel_on_reply',
      next_eval_at=null,claimed_until=null,completed_at=clock_timestamp(),updated_at=clock_timestamp()
      where organization_id=e.organization_id and id=e.id;
    insert into public.followup_enrollment_events(organization_id,enrollment_id,node_id,event_type,payload,idempotency_key)
      values(e.organization_id,e.id,e.current_node_id,'reactivity_replied',jsonb_build_object(
        'reason','cancel_on_reply','inbound_at',new.sent_at,'previous_status',e.status,
        'next_eval_at',e.next_eval_at,'node_epoch',e.node_epoch),'reply:'||new.id::text) on conflict do nothing;
  end loop;
  return new;
end $$;
revoke execute on function public.fn_cancel_followup_on_reply() from public,anon,authenticated;

create or replace function public.fn_enroll_silence_episode(p_input jsonb) returns boolean
language plpgsql security invoker set search_path=public,pg_temp as $$
declare org uuid:=(p_input->>'organization_id')::uuid; contact uuid:=(p_input->>'contact_id')::uuid;
  pointer uuid:=(p_input->>'pointer_id')::uuid; last_inbound timestamptz; threshold integer; segments text[];
  e public.followup_enrollments; reply_payload jsonb; prior_due timestamptz; due timestamptz; confirmed boolean; node_type text; last_control text;
begin
  perform 1 from public.contacts c where c.organization_id=org and c.id=contact
    and not c.is_blocked and not c.is_anonymized and not c.force_human for update;
  if not found then return false; end if;
  select (p.trigger_config->'params'->>'threshold_minutes')::integer,
    array(select jsonb_array_elements_text(coalesce(p.trigger_config->'params'->'segments','[]')))
    into threshold,segments from public.followup_flow_pointers p
    where p.organization_id=org and p.id=pointer and p.status='active'
      and p.active_version_id=(p_input->>'version_id')::uuid and p.trigger_config->>'kind'='silence';
  if not found or threshold is null then return false; end if;
  if cardinality(segments)>0 and not exists(select 1 from public.contacts c where c.organization_id=org
    and c.id=contact and c.tags && segments) then return false; end if;
  select max(v.last_inbound_at) into last_inbound from public.conversations v
    where v.organization_id=org and v.contact_id=contact and v.status not in ('closed','archived');
  if last_inbound is null or last_inbound>now()-make_interval(mins=>threshold) then return false; end if;
  if exists(select 1 from public.conversations v where v.organization_id=org and v.contact_id=contact
    and (v.assignee_kind='user' or v.bot_silenced_until>now())) then return false; end if;
  if exists(select 1 from public.followup_enrollments f where f.organization_id=org and f.contact_id=contact
    and f.status in ('active','waiting_reply','paused_handoff','paused_manual')) then return false; end if;

  select * into e from public.followup_enrollments f where f.organization_id=org and f.contact_id=contact
    and f.pointer_id=pointer order by f.started_at desc,f.id desc limit 1 for update;
  if found then
    -- Só a resposta permite continuação. Esgotamento, conversão, opt-out,
    -- cancelamento humano e falha terminal NÃO ganham um orçamento novo.
    if e.status<>'cancelled' or e.outcome is distinct from 'replied'
      or e.cancel_reason is distinct from 'cancel_on_reply'
      or last_inbound<=coalesce(e.silence_anchor_at,e.started_at) then return false; end if;
    select ev.payload into reply_payload from public.followup_enrollment_events ev
      where ev.organization_id=org and ev.enrollment_id=e.id and ev.event_type='reactivity_replied'
        and (ev.payload->>'node_epoch' is null or ev.payload->>'node_epoch'=e.node_epoch::text)
      order by ev.created_at desc,ev.id desc limit 1;
    if reply_payload->>'previous_status' in ('paused_manual','paused_handoff') then return false; end if;
    if reply_payload->>'previous_status' is null then
      select ev.event_type into last_control from public.followup_enrollment_events ev
        where ev.organization_id=org and ev.enrollment_id=e.id
          and ev.created_at<=coalesce(e.completed_at,e.updated_at)
          and ev.event_type in ('paused_manual','handoff_paused','cancelled_manual','resumed_manual','handoff_resumed','snoozed_manual')
        order by ev.created_at desc,ev.id desc limit 1;
      if last_control in ('paused_manual','handoff_paused','cancelled_manual') then return false; end if;
    end if;
    -- Nas inscrições canceladas antes da 0236, o evento da resposta ainda
    -- não guardava o próximo prazo. Recupera o último relógio registrado.
    prior_due:=(reply_payload->>'next_eval_at')::timestamptz;
    if prior_due is null then
      select (ev.payload->>'next_eval_at')::timestamptz into prior_due
        from public.followup_enrollment_events ev where ev.organization_id=org and ev.enrollment_id=e.id
          and ev.node_id=e.current_node_id and ev.payload->>'next_eval_at' is not null
          and ev.created_at<=coalesce(e.completed_at,e.updated_at)
          and ev.event_type in ('wait_started','resumed_manual','snoozed_manual','handoff_resumed')
        order by ev.created_at desc,ev.id desc limit 1;
    end if;
    -- Não compete com efeitos ainda em execução nem refaz transporte incerto.
    if exists(select 1 from public.job_queue j where j.organization_id=org and j.contact_id=contact
      and j.kind='followup_turn' and j.payload->>'followup_enrollment_id'=e.id::text and j.status='running')
      or exists(select 1 from public.job_queue j join public.send_ledger l on l.organization_id=j.organization_id and l.job_id=j.id
        left join public.messages m on m.organization_id=org and m.contact_id=contact
          and m.metadata->>'idempotency_key'=l.id::text
        where j.organization_id=org and j.contact_id=contact and j.kind='followup_turn'
          and j.payload->>'followup_enrollment_id'=e.id::text
          and case
            when m.status in ('sent','delivered','read') and m.external_id is not null then false
            when l.status not in ('requested','queued','accepted','failed','vetoed') then true
            when m.id is null then l.status<>'requested'
            when m.status='sending' or m.metadata->'outbound_attempt'->>'phase' in ('started','uncertain') then true
            when l.status='vetoed' or m.metadata->'outbound_attempt'->>'phase'='rejected' then false
            when m.metadata->'outbound_attempt'->>'phase'='prepared' and m.status in ('queued','failed') then false
            else true end) then return false; end if;
    select n->>'type' into node_type from public.followup_flow_versions v,
      lateral jsonb_array_elements(v.graph->'nodes') n where v.organization_id=org and v.id=e.version_id
      and n->>'id'=e.current_node_id;
    if node_type is null then return false; end if;
    -- Se o ACK chegou antes da interrupção e o callback caiu, a prova física
    -- ainda vence. Só a ocupação atual do nó pode fornecer essa prova.
    select exists(select 1 from public.job_queue j join public.send_ledger l on l.organization_id=j.organization_id and l.job_id=j.id
      join public.messages m on m.organization_id=org and m.contact_id=contact
        and m.metadata->>'idempotency_key'=l.id::text
      where j.organization_id=org and j.contact_id=contact and j.kind='followup_turn'
        and j.payload->>'followup_enrollment_id'=e.id::text and j.payload->>'node_id'=e.current_node_id
        and j.payload->>'node_epoch'=e.node_epoch::text and m.status in ('sent','delivered','read')
        and m.external_id is not null) into confirmed;
    -- A retomada espera tanto o novo silêncio quanto o prazo já configurado.
    -- A próxima espera não vira uma nova primeira mensagem de duas em duas horas.
    due:=greatest(last_inbound+make_interval(mins=>threshold),prior_due);
    insert into public.followup_enrollment_events(organization_id,enrollment_id,node_id,event_type,payload,idempotency_key)
      values(org,e.id,e.current_node_id,'silence_resumed',jsonb_build_object(
        'inbound_at',last_inbound,'next_eval_at',due,'confirmed',confirmed,
        'previous_steps_taken',e.steps_taken),'silence:'||e.node_epoch::text);
    update public.followup_enrollments set status='active',outcome=null,cancel_reason=null,completed_at=null,
      silence_anchor_at=last_inbound,next_eval_at=due,claimed_until=null,updated_at=clock_timestamp()
      where organization_id=org and id=e.id;
    return true;
  end if;

  insert into public.followup_enrollments(organization_id,pointer_id,version_id,contact_id,current_node_id,next_eval_at,agent_id)
    values(org,pointer,(p_input->>'version_id')::uuid,contact,p_input->>'current_node_id',
      (p_input->>'next_eval_at')::timestamptz,(p_input->>'agent_id')::uuid);
  return true;
exception when unique_violation then return false;
end $$;
revoke execute on function public.fn_enroll_silence_episode(jsonb) from public,anon,authenticated;
grant execute on function public.fn_enroll_silence_episode(jsonb) to service_role;
notify pgrst, 'reload schema';
