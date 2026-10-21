-- A ocupação muda ao sair/voltar ao mesmo nó; rechecks não mudam sua identidade.
alter table public.followup_enrollments add column if not exists node_epoch integer not null default 0;
create or replace function public.fn_followup_node_epoch() returns trigger
language plpgsql security invoker set search_path=public,pg_temp as $$
begin
  new.node_epoch:=old.node_epoch+case when new.current_node_id is distinct from old.current_node_id then 1 else 0 end;
  return new;
end $$;
revoke execute on function public.fn_followup_node_epoch() from public,anon,authenticated;
drop trigger if exists tr_followup_node_epoch on public.followup_enrollments;
create trigger tr_followup_node_epoch before update on public.followup_enrollments
  for each row execute function public.fn_followup_node_epoch();

-- Adota a ocupação dos jobs anteriores à coluna, apenas com histórico compatível.
update public.job_queue j set payload=j.payload||jsonb_build_object('node_epoch',e.node_epoch)
from public.followup_enrollments e where j.organization_id=e.organization_id and j.contact_id=e.contact_id
  and j.kind='followup_turn' and j.status in ('pending','running')
  and j.payload->>'followup_enrollment_id'=e.id::text and j.payload->>'node_id'=e.current_node_id
  and j.payload->>'node_epoch' is null and not exists(select 1 from public.followup_enrollment_events ev
    where ev.organization_id=e.organization_id and ev.enrollment_id=e.id and ev.created_at>j.created_at
      and ev.node_id<>e.current_node_id);

-- Progressão tardia não pode desfazer intervenção humana. Evento e avanço
-- pertencem à mesma transação; um CAS perdido não consome a chave do passo.
create or replace function public.fn_followup_complete_step(
  p_org uuid,p_id uuid,p_expected jsonb,p_event jsonb,p_patch jsonb
) returns boolean language plpgsql security invoker set search_path=public,pg_temp as $$
declare e public.followup_enrollments; n public.followup_enrollments; inserted_id uuid;
begin
  select * into e from public.followup_enrollments where organization_id=p_org and id=p_id for update;
  if not found or e.current_node_id is distinct from p_expected->>'current_node_id'
    or ((p_expected->>'node_epoch') is not null and e.node_epoch<>(p_expected->>'node_epoch')::integer)
    or e.status not in ('active','waiting_reply','paused_manual','paused_handoff') then return false; end if;
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

-- Barreira genérica, independente da integração de assinatura. Jobs legados
-- sem inscrição mantêm sua política; jobs de fluxo exigem nó e ocupação atuais.
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
              and m.direction='inbound' and m.sent_at>e.started_at))
      )))
$$;
revoke execute on function public.fn_followup_job_live(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.fn_followup_job_live(uuid,uuid,uuid) to service_role;

-- O cancelamento não espera o drain do event_log: uma mensagem já persistida
-- interrompe também o trabalho que estava na fila. O consumidor mantém replay
-- e contatos irmãos; este trigger é a barreira síncrona para o contato exato.
create or replace function public.fn_cancel_followup_on_reply() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if new.direction<>'inbound' then return new; end if;
  with stopped as (
    update public.followup_enrollments e set status='cancelled',outcome='replied',cancel_reason='cancel_on_reply',
      next_eval_at=null,claimed_until=null,completed_at=clock_timestamp(),updated_at=clock_timestamp()
    from public.followup_flow_pointers p where p.id=e.pointer_id and p.organization_id=e.organization_id
      and e.organization_id=new.organization_id and e.contact_id=new.contact_id
      and e.status in ('active','waiting_reply','paused_handoff','paused_manual')
      and new.sent_at>e.started_at and coalesce(p.trigger_config->'cancel_on_reply'='true'::jsonb,false)
    returning e.*
  ) insert into public.followup_enrollment_events(organization_id,enrollment_id,node_id,event_type,payload,idempotency_key)
    select organization_id,id,current_node_id,'reactivity_replied',jsonb_build_object('reason','cancel_on_reply'),
      'reply:'||new.id::text from stopped on conflict do nothing;
  return new;
end $$;
revoke execute on function public.fn_cancel_followup_on_reply() from public,anon,authenticated;
drop trigger if exists tr_cancel_followup_on_reply on public.messages;
create trigger tr_cancel_followup_on_reply after insert on public.messages for each row execute function public.fn_cancel_followup_on_reply();

-- Corrige inscrições antigas que ignoraram uma resposta, sem reenvio e sem IDs
-- de cliente. A reaplicação do baseline não altera inscrições já encerradas.
with stopped as (
  update public.followup_enrollments e set status='cancelled',outcome='replied',cancel_reason='cancel_on_reply',
    next_eval_at=null,claimed_until=null,completed_at=clock_timestamp(),updated_at=clock_timestamp()
  from public.followup_flow_pointers p where p.id=e.pointer_id and p.organization_id=e.organization_id
    and e.status in ('active','waiting_reply','paused_handoff','paused_manual')
    and coalesce(p.trigger_config->'cancel_on_reply'='true'::jsonb,false)
    and exists(select 1 from public.messages m where m.organization_id=e.organization_id and m.contact_id=e.contact_id
      and m.direction='inbound' and m.sent_at>e.started_at)
  returning e.*
) insert into public.followup_enrollment_events(organization_id,enrollment_id,node_id,event_type,payload,idempotency_key)
  select organization_id,id,current_node_id,'reactivity_replied',jsonb_build_object('reason','cancel_on_reply','source','migration_0234'),
    'migration:0234:replied' from stopped on conflict do nothing;

-- Uma varredura por silêncio não reabre o mesmo episódio encerrado. O lock do
-- contato serializa sweeps concorrentes. Inscrições manuais usam a API existente.
create or replace function public.fn_enroll_silence_episode(p_input jsonb) returns boolean
language plpgsql security invoker set search_path=public,pg_temp as $$
declare org uuid:=(p_input->>'organization_id')::uuid; contact uuid:=(p_input->>'contact_id')::uuid;
  pointer uuid:=(p_input->>'pointer_id')::uuid; last_inbound timestamptz; threshold integer; segments text[];
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
  if exists(select 1 from public.followup_enrollments e where e.organization_id=org and e.contact_id=contact
    and (e.status in ('active','waiting_reply','paused_handoff','paused_manual') or
      (e.pointer_id=pointer and coalesce(e.completed_at,e.updated_at)>=last_inbound))) then return false; end if;
  insert into public.followup_enrollments(organization_id,pointer_id,version_id,contact_id,current_node_id,next_eval_at,agent_id)
    values(org,pointer,(p_input->>'version_id')::uuid,contact,p_input->>'current_node_id',
      (p_input->>'next_eval_at')::timestamptz,(p_input->>'agent_id')::uuid);
  return true;
exception when unique_violation then return false;
end $$;
revoke execute on function public.fn_enroll_silence_episode(jsonb) from public,anon,authenticated;
grant execute on function public.fn_enroll_silence_episode(jsonb) to service_role;

-- A pausa humana também suspende o relógio do motor: rechecks não consomem
-- o orçamento enquanto o atendente está no comando. O rodízio por org permanece.
create or replace function fn_claim_due_followup_enrollments(p_limit int, p_lease_seconds int)
returns setof followup_enrollments
language sql
security definer
set search_path = public
as $$
  with orgs as (
    -- Sem a condição de claim aqui de propósito: o lateral abaixo a aplica, e uma
    -- organização cujos vencidos estão todos com lease apenas devolve zero linhas.
    select distinct organization_id
      from followup_enrollments
     where status in ('active','waiting_reply')
       and next_eval_at <= now()
  ),
  fila as (
    select f.id, f.next_eval_at, f.posicao_na_org
      from orgs
      cross join lateral (
        select d.id,
               d.next_eval_at,
               row_number() over (order by d.next_eval_at) as posicao_na_org
          from followup_enrollments d
         where d.organization_id = orgs.organization_id
           and d.status in ('active','waiting_reply')
           and d.next_eval_at <= now()
           and (d.claimed_until is null or d.claimed_until < now())
           and not exists(select 1 from contacts c where c.organization_id=d.organization_id
             and c.id=d.contact_id and (c.force_human or c.is_blocked))
           and not exists(select 1 from conversations v where v.organization_id=d.organization_id
             and v.contact_id=d.contact_id and (v.assignee_kind='user' or v.bot_silenced_until>now()))
         order by d.next_eval_at
         limit p_limit
      ) f
  ),
  escolhidos as (
    -- O rodízio: posição 1 de todas as organizações, depois a 2 de todas, etc.
    -- Empate na mesma posição vai para quem esperou mais.
    select id from fila order by posicao_na_org, next_eval_at limit p_limit
  ),
  travados as (
    select e.id from followup_enrollments e
     where e.id in (select id from escolhidos)
     for update skip locked
  )
  update followup_enrollments e
     set claimed_until = now() + make_interval(secs => p_lease_seconds),
         updated_at = now()
   where e.id in (select id from travados)
     -- A condição de lease É REPETIDA AQUI, e não é redundante com a CTE `fila`.
     -- Sem ela, duas conexões simultâneas reclamam as MESMAS linhas: a segunda
     -- espera o lock da primeira, e quando ele sai o Postgres (READ COMMITTED)
     -- reavalia só o WHERE do UPDATE — que não olhava `claimed_until` — e grava
     -- por cima. O `skip locked` da CTE não salva: as duas materializam a mesma
     -- lista antes de qualquer lock existir. Medido: interseção de 5 em 5 no
     -- invariante de concorrência (followup-schema.test.ts).
     and (e.claimed_until is null or e.claimed_until < now())
  returning e.*;
$$;


revoke execute on function public.fn_claim_due_followup_enrollments(int,int) from public,anon,authenticated;
grant execute on function public.fn_claim_due_followup_enrollments(int,int) to service_role;
