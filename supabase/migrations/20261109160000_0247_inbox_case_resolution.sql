-- Resposta humana marcada: a intenção é do serviço, nunca do metadata do navegador.
-- O trigger apenas grava confirmação+evento na mesma transação do resultado do
-- transporte. Resolver consulta e devolver o comando são efeitos sem transporte.
alter table public.conversations add column if not exists ai_control_revision bigint not null default 0;
alter table public.contacts add column if not exists ai_control_revision bigint not null default 0;

create or replace function public.fn_conversation_control_revision() returns trigger
language plpgsql set search_path=public,pg_temp as $$
begin
 if tg_op='INSERT' then new.ai_control_revision:=0;
 elsif row(new.assigned_to_user_id,new.assignee_kind,new.bot_silenced_until,new.last_handoff_at,new.last_handoff_reason,new.status)
   is distinct from row(old.assigned_to_user_id,old.assignee_kind,old.bot_silenced_until,old.last_handoff_at,old.last_handoff_reason,old.status)
 then new.ai_control_revision:=old.ai_control_revision+1;
 else new.ai_control_revision:=old.ai_control_revision; end if;
 return new;
end $$;
revoke execute on function public.fn_conversation_control_revision() from public,anon,authenticated;
create or replace trigger trg_conversation_control_revision before insert or update on public.conversations
 for each row execute function public.fn_conversation_control_revision();

create or replace function public.fn_contact_control_revision() returns trigger
language plpgsql set search_path=public,pg_temp as $$
begin
 if tg_op='INSERT' then new.ai_control_revision:=0;
 elsif row(new.force_human,new.is_blocked,new.is_anonymized,new.ai_authorized_at,new.ai_authorized_reason)
   is distinct from row(old.force_human,old.is_blocked,old.is_anonymized,old.ai_authorized_at,old.ai_authorized_reason)
 then new.ai_control_revision:=old.ai_control_revision+1;
 else new.ai_control_revision:=old.ai_control_revision; end if;
 return new;
end $$;
revoke execute on function public.fn_contact_control_revision() from public,anon,authenticated;
create or replace trigger trg_contact_control_revision before insert or update on public.contacts
 for each row execute function public.fn_contact_control_revision();

create table if not exists public.case_resolution_intents (
 message_id uuid primary key references public.messages(id) on delete cascade,
 organization_id uuid not null references public.organizations(id) on delete cascade,
 conversation_id uuid not null references public.conversations(id) on delete cascade,
 contact_id uuid not null references public.contacts(id) on delete cascade,
 case_id uuid not null references public.agent_cases(id) on delete cascade,
 actor_user_id uuid references auth.users(id) on delete set null,
 conversation_revision bigint not null,
 contact_revision bigint not null,
 status text not null default 'pending' check(status in ('pending','confirmed','applied','partial','cancelled')),
 reason text,
 confirmation_event_id uuid,
 transport_started_at timestamptz,
 confirmed_at timestamptz,
 applied_at timestamptz,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create index if not exists case_resolution_intents_conversation on public.case_resolution_intents(organization_id,conversation_id,created_at desc);
alter table public.case_resolution_intents enable row level security;
drop policy if exists case_resolution_intents_select on public.case_resolution_intents;
create policy case_resolution_intents_select on public.case_resolution_intents for select to authenticated
 using(organization_id in (select public.fn_user_org_ids()) and exists(select 1 from public.conversations v
  where v.id=case_resolution_intents.conversation_id and v.organization_id=case_resolution_intents.organization_id));
revoke all on public.case_resolution_intents from public,anon,authenticated;
grant select on public.case_resolution_intents to authenticated;
grant all on public.case_resolution_intents to service_role;

-- Depois de vinculada, a linha é prova de uma operação do servidor. Não aceitar
-- UPDATE/DELETE direto do navegador: uma troca de status seguida por qualquer
-- atualização legítima do serviço não pode transformar recibo forjado em prova.
create or replace function public.fn_protect_case_resolution_message() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if current_setting('role',true) in ('anon','authenticated') and exists(
   select 1 from case_resolution_intents where organization_id=old.organization_id and message_id=old.id) then
  raise exception 'case_resolution_message_protected' using errcode='42501';
 end if;
 if tg_op='DELETE' then return old; end if;
 return new;
end $$;
revoke execute on function public.fn_protect_case_resolution_message() from public,anon,authenticated;
create or replace trigger trg_protect_case_resolution_message before update or delete on public.messages
 for each row execute function public.fn_protect_case_resolution_message();

create or replace function public.fn_prepare_case_resolution(p_org uuid,p_message uuid,p_case uuid,p_actor uuid)
returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare m messages%rowtype; a agent_cases%rowtype; v conversations%rowtype; c contacts%rowtype; i case_resolution_intents%rowtype;
begin
 select * into i from case_resolution_intents where organization_id=p_org and message_id=p_message;
 if found then
  if i.case_id<>p_case or i.actor_user_id is distinct from p_actor then raise exception 'case_resolution_conflict'; end if;
  return jsonb_build_object('case_id',i.case_id,'message_id',i.message_id,'status',i.status,'reason',i.reason);
 end if;
 if coalesce(fn_member_role_in_org(p_actor,p_org),'none') not in ('agent','manager','admin') then
  raise exception 'case_resolution_actor_forbidden'; end if;
 select * into m from messages where organization_id=p_org and id=p_message;
 if not found or m.direction<>'outbound' or m.sent_via<>'user' or m.sent_by_user_id is distinct from p_actor
  or m.type not in ('text','audio') or m.revoked_at is not null or m.status not in ('queued','sending')
 then raise exception 'case_resolution_message_invalid'; end if;
 select * into a from agent_cases where organization_id=p_org and id=p_case and conversation_id=m.conversation_id for update;
 if not found or a.status<>'awaiting_human' then raise exception 'case_resolution_case_invalid'; end if;
 perform 1 from agent_responsible_requests where organization_id=p_org and case_id=p_case for update;
 if exists(select 1 from agent_responsible_requests where organization_id=p_org and case_id=p_case and status='answered')
 then raise exception 'responsible_answer_in_flight'; end if;
 select * into v from conversations where organization_id=p_org and id=m.conversation_id and contact_id=m.contact_id for update;
 if not found or v.status in ('closed','archived') then raise exception 'case_resolution_conversation_invalid'; end if;
 select * into c from contacts where organization_id=p_org and id=v.contact_id for update;
 if not found or c.is_blocked or c.is_anonymized then raise exception 'case_resolution_contact_blocked'; end if;
 -- A mensagem continuava editável até este instante. Releia-a sob lock APÓS os
 -- locks de caso/conversa, conferindo novamente todos os vínculos e o ator.
 select * into m from messages where organization_id=p_org and id=p_message for update;
 if not found or m.conversation_id<>v.id or m.contact_id<>c.id or m.sent_by_user_id is distinct from p_actor
   or m.direction<>'outbound' or m.sent_via<>'user' or m.type not in ('text','audio')
   or m.revoked_at is not null or m.status not in ('queued','sending') then
  raise exception 'case_resolution_message_invalid'; end if;
 insert into case_resolution_intents(message_id,organization_id,conversation_id,contact_id,case_id,actor_user_id,conversation_revision,contact_revision)
 values(m.id,p_org,v.id,c.id,a.id,p_actor,v.ai_control_revision,c.ai_control_revision)
 on conflict(message_id) do nothing;
 select * into i from case_resolution_intents where organization_id=p_org and message_id=p_message;
 if not found or i.case_id<>p_case or i.actor_user_id is distinct from p_actor then raise exception 'case_resolution_conflict'; end if;
 return jsonb_build_object('case_id',i.case_id,'message_id',i.message_id,'status',i.status,'reason',i.reason);
end $$;
revoke execute on function public.fn_prepare_case_resolution(uuid,uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.fn_prepare_case_resolution(uuid,uuid,uuid,uuid) to service_role;

create or replace function public.fn_case_resolution_transport_live(p_org uuid,p_message uuid)
returns boolean language plpgsql security invoker set search_path=public,pg_temp as $$
declare i case_resolution_intents%rowtype;
begin
 select * into i from case_resolution_intents where organization_id=p_org and message_id=p_message for update;
 if not found or i.status<>'pending' or i.transport_started_at is not null then return false; end if;
 perform 1 from agent_cases where organization_id=p_org and id=i.case_id and status='awaiting_human' for update;
 if not found then return false; end if;
 perform 1 from agent_responsible_requests where organization_id=p_org and case_id=i.case_id for update;
 if exists(select 1 from conversations v join contacts c on c.organization_id=v.organization_id and c.id=v.contact_id
   where v.organization_id=p_org and v.id=i.conversation_id and c.id=i.contact_id
    and not c.is_blocked and not c.is_anonymized and v.status not in ('closed','archived')
    and v.ai_control_revision=i.conversation_revision and c.ai_control_revision=i.contact_revision)
   and coalesce(fn_member_role_in_org(i.actor_user_id,p_org),'none') in ('agent','manager','admin')
   and not exists(select 1 from agent_responsible_requests where organization_id=p_org and case_id=i.case_id and status='answered')
   and not exists(select 1 from case_resolution_intents other where other.organization_id=p_org and other.case_id=i.case_id
    and other.message_id<>i.message_id and other.transport_started_at is not null and other.status in ('pending','confirmed')) then
  update case_resolution_intents set transport_started_at=coalesce(transport_started_at,now()),updated_at=now()
   where organization_id=p_org and message_id=p_message;
  return true;
 end if;
 return false;
end $$;
revoke execute on function public.fn_case_resolution_transport_live(uuid,uuid) from public,anon,authenticated;
grant execute on function public.fn_case_resolution_transport_live(uuid,uuid) to service_role;

create or replace function public.fn_cancel_case_resolution(p_org uuid,p_message uuid)
returns void language sql security invoker set search_path=public,pg_temp as $$
 update public.case_resolution_intents i set status='cancelled',reason='send_failed_before_transport',updated_at=now()
  where i.organization_id=p_org and i.message_id=p_message and i.status='pending'
   and exists(select 1 from public.messages m where m.organization_id=i.organization_id and m.id=i.message_id
    and m.status='failed' and m.external_id is null and i.transport_started_at is null);
$$;
revoke execute on function public.fn_cancel_case_resolution(uuid,uuid) from public,anon,authenticated;
grant execute on function public.fn_cancel_case_resolution(uuid,uuid) to service_role;

-- O responsável aceita sob o MESMO lock do caso que o envio marcado usa. Assim,
-- quem ganhou antes da rede fica como único emissor; incerteza não libera outro.
create or replace function public.fn_guard_responsible_answer_against_inbox() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if new.status='answered' and old.status is distinct from new.status then
  perform 1 from agent_cases where organization_id=new.organization_id and id=new.case_id for update;
  if exists(select 1 from case_resolution_intents where organization_id=new.organization_id and case_id=new.case_id
    and transport_started_at is not null and status in ('pending','confirmed')) then
   raise exception 'inbox_response_in_flight' using errcode='55P03';
  end if;
 end if;
 return new;
end $$;
revoke execute on function public.fn_guard_responsible_answer_against_inbox() from public,anon,authenticated;
create or replace trigger trg_guard_responsible_answer_against_inbox before update of status on public.agent_responsible_requests
 for each row execute function public.fn_guard_responsible_answer_against_inbox();

create or replace function public.fn_confirm_case_resolution() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare i case_resolution_intents%rowtype; e uuid;
begin
 -- Um usuário pode editar messages diretamente pelo PostgREST. Só o escritor
 -- de resultado do servidor/canal pode fornecer a prova de transporte.
 if current_setting('role',true) in ('anon','authenticated') then return new; end if;
 if new.direction<>'outbound' or new.status not in ('sent','delivered','read')
   or nullif(new.external_id,'') is null or new.revoked_at is not null then return new; end if;
 update case_resolution_intents set status='confirmed',confirmed_at=now(),updated_at=now()
  where organization_id=new.organization_id and message_id=new.id and conversation_id=new.conversation_id
   and contact_id=new.contact_id and status='pending' and confirmation_event_id is null returning * into i;
 if not found then return new; end if;
 e:=public.emit_event('ai.case_resolution_confirmed','message',new.id,jsonb_build_object('message_id',new.id),
   jsonb_build_object('source','case_resolution_transport'),new.organization_id);
 update case_resolution_intents set confirmation_event_id=e where message_id=i.message_id and organization_id=i.organization_id;
 return new;
end $$;
revoke execute on function public.fn_confirm_case_resolution() from public,anon,authenticated;
create or replace trigger trg_confirm_case_resolution after update on public.messages
 for each row execute function public.fn_confirm_case_resolution();

create or replace function public.fn_apply_case_resolution(p_org uuid,p_message uuid)
returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare i case_resolution_intents%rowtype; a agent_cases%rowtype; v conversations%rowtype;
 c contacts%rowtype; m messages%rowtype; b text; note text; old_summary text;
begin
 select * into i from case_resolution_intents where organization_id=p_org and message_id=p_message for update;
 if not found then return null; end if;
 if i.status in ('applied','partial','cancelled','pending') then
  return jsonb_build_object('case_id',i.case_id,'message_id',i.message_id,'status',i.status,'reason',i.reason); end if;
 select * into m from messages where organization_id=p_org and id=i.message_id and conversation_id=i.conversation_id
  and contact_id=i.contact_id and sent_by_user_id=i.actor_user_id and direction='outbound';
 if not found or m.revoked_at is not null or m.status not in ('sent','delivered','read') or nullif(m.external_id,'') is null then
  update case_resolution_intents set status='cancelled',reason='message_not_confirmed',updated_at=now() where organization_id=p_org and message_id=i.message_id;
  return jsonb_build_object('case_id',i.case_id,'message_id',i.message_id,'status','cancelled','reason','message_not_confirmed'); end if;
 select * into a from agent_cases where organization_id=p_org and id=i.case_id and conversation_id=i.conversation_id for update;
 if not found or a.status<>'awaiting_human' then b:='case_already_closed';
 else
  -- Aceitar uma resposta do suporte também toma caso → pedido. Se ganhou a
  -- corrida, deixamos o envio dela terminar; jamais cancelamos uma rede incerta.
  perform 1 from agent_responsible_requests where organization_id=p_org and case_id=i.case_id for update;
  if exists(select 1 from agent_responsible_requests where organization_id=p_org and case_id=i.case_id and status='answered') then
   return jsonb_build_object('case_id',i.case_id,'message_id',i.message_id,'status','confirmed','reason','responsible_answer_in_flight'); end if;
  select * into v from conversations where organization_id=p_org and id=i.conversation_id and contact_id=i.contact_id for update;
  select * into c from contacts where organization_id=p_org and id=i.contact_id for update;
  if v.id is null or c.id is null then b:='conversation_changed';
  else
   note:=case when m.type='audio' then coalesce(nullif(m.media_derived_text,''),'Resposta em áudio enviada pela equipe; não inventar conteúdo sem transcrição.') else m.body end;
   update agent_cases set status='resolved',closed_at=now(),updated_at=now() where organization_id=p_org and id=i.case_id;
   insert into agent_case_events(organization_id,case_id,kind,actor_kind,actor_user_id,human_action,body,metadata)
    values(p_org,i.case_id,'human_replied','human',i.actor_user_id,'resolved',note,jsonb_build_object('message_id',m.id,'source','inbox')),
     (p_org,i.case_id,'resolved','human',i.actor_user_id,null,null,jsonb_build_object('message_id',m.id));
   -- O trigger existente do caso cancela pedidos ainda não respondidos. O
   -- UPDATE explícito também cobre instalações sem configuração de responsável.
   update agent_responsible_requests set status='cancelled' where organization_id=p_org and case_id=i.case_id and status in ('pending','failed');
   if c.is_blocked or c.is_anonymized then b:='contact_blocked';
   elsif v.ai_control_revision<>i.conversation_revision or c.ai_control_revision<>i.contact_revision then b:='human_control_changed';
   elsif v.status in ('closed','archived') then b:='conversation_closed';
   elsif exists(select 1 from agent_cases ac join conversations cv on cv.organization_id=ac.organization_id and cv.id=ac.conversation_id
      where ac.organization_id=p_org and cv.contact_id=i.contact_id and ac.status in ('awaiting_human','awaiting_lead'))
    or exists(select 1 from agent_responsible_requests where organization_id=p_org and contact_id=i.contact_id and status in ('pending','answered','failed')) then b:='pending_consultation';
   elsif exists(select 1 from conversations cv where cv.organization_id=p_org and cv.contact_id=i.contact_id and cv.id<>v.id
      and cv.status not in ('closed','archived') and (cv.assignee_kind='user' or cv.bot_silenced_until>now())) then b:='other_human_conversation';
   elsif coalesce(fn_member_role_in_org(i.actor_user_id,p_org),'none') not in ('agent','manager','admin') then b:='actor_access_revoked';
   else
    if v.assigned_to_user_id is not null then
     insert into conversation_assignment_events(organization_id,conversation_id,from_user_id,to_user_id,changed_by,reason)
      values(p_org,v.id,v.assigned_to_user_id,null,i.actor_user_id,'release'); end if;
    update conversations set assigned_to_user_id=null,assigned_to_user_name=null,assigned_at=null,assignee_kind='ai',status='ai_handling',
      bot_silenced_until=null,last_handoff_at=null,last_handoff_reason=null,status_changed_at=now(),updated_at=now()
      where organization_id=p_org and id=v.id;
    update contacts set force_human=false,ai_authorized_at=now(),ai_authorized_reason='retomada_manual' where organization_id=p_org and id=c.id;
    select rolling_summary into old_summary from lead_checkpoints where organization_id=p_org and contact_id=c.id order by seq desc limit 1;
    insert into lead_checkpoints(organization_id,contact_id,job_id,commitments,objections,next_action,rolling_summary)
      select p_org,c.id,null,coalesce(cp.commitments,'[]'::jsonb),coalesce(cp.objections,'[]'::jsonb),null,
       concat_ws(E'\n\n',nullif(old_summary,''),'A equipe já respondeu e resolveu a consulta: '||coalesce(note,'Resposta entregue.'))
      from (select 1) seed left join lateral(select commitments,objections from lead_checkpoints
       where organization_id=p_org and contact_id=c.id order by seq desc limit 1) cp on true;
    perform public.emit_event('ai.handoff_resolved','conversation',v.id,
      jsonb_build_object('conversation_id',v.id,'contact_id',c.id,'organization_id',p_org),
      jsonb_build_object('source','inbox_case_resolution','message_id',m.id),p_org);
   end if;
  end if;
 end if;
 update case_resolution_intents set status=case when b is null then 'applied' else 'partial' end,
   reason=b,applied_at=now(),updated_at=now() where organization_id=p_org and message_id=i.message_id;
 insert into api_audit_log(organization_id,actor_user_id,action,resource_type,resource_id,request_id,metadata)
  values(p_org,i.actor_user_id,'ai.case_replied','agent_case',i.case_id,i.message_id::text,
   jsonb_build_object('source','inbox_confirmed_resolution','message_id',i.message_id,
    'resolved',b is distinct from 'case_already_closed' and b is distinct from 'conversation_changed',
    'automatic_resumed',b is null,'blocking_reason',b));
 return jsonb_build_object('case_id',i.case_id,'message_id',i.message_id,'status',case when b is null then 'applied' else 'partial' end,'reason',b);
end $$;
revoke execute on function public.fn_apply_case_resolution(uuid,uuid) from public,anon,authenticated;
grant execute on function public.fn_apply_case_resolution(uuid,uuid) to service_role;

-- Barreira comum com o encerramento interno. Volatile: a leitura do evento é
-- feita DEPOIS de adquirir a conversa, inclusive quando foi necessário esperar.
create or replace function public.fn_case_internal_outbound_live(p_org uuid,p_job uuid,p_message uuid)
returns boolean language plpgsql volatile security invoker set search_path=public,pg_temp as $$
declare j job_queue%rowtype; m messages%rowtype; anchor_at timestamptz;
begin
 select * into j from job_queue where organization_id=p_org and id=p_job;
 select * into m from messages where organization_id=p_org and id=p_message;
 if j.id is null or m.id is null then return false; end if;
 if j.kind not in ('inbound_turn','case_reply_turn') then return true; end if;
 perform 1 from conversations where organization_id=p_org and id=m.conversation_id for update;
 if not found then return false; end if;
 if j.kind='inbound_turn' then
  select created_at into anchor_at from messages where organization_id=p_org
   and conversation_id=m.conversation_id and id::text=j.payload->>'inbound_message_id' and direction='inbound';
 end if;
 anchor_at:=coalesce(anchor_at,j.created_at);
 return not exists(select 1 from agent_case_events e join agent_cases a
   on a.organization_id=e.organization_id and a.id=e.case_id
   where e.organization_id=p_org and a.conversation_id=m.conversation_id and e.kind='resolved'
    and e.metadata->>'internal_no_send'='true' and e.created_at>=anchor_at
    and (j.kind='inbound_turn' or a.id::text=j.payload->>'case_id'));
end $$;
revoke execute on function public.fn_case_internal_outbound_live(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.fn_case_internal_outbound_live(uuid,uuid,uuid) to service_role;
notify pgrst, 'reload schema';
