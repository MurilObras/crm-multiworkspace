-- Consulta temporária e transferência são decisões distintas. Toda saída é fila+ledger.
create unique index if not exists ai_agents_org_id_unique on public.ai_agents(organization_id,id);
create unique index if not exists conversations_org_id_unique on public.conversations(organization_id,id);
create unique index if not exists contacts_org_id_unique on public.contacts(organization_id,id);
create unique index if not exists agent_cases_org_id_unique on public.agent_cases(organization_id,id);

create table if not exists public.agent_responsibles (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references public.organizations(id) on delete cascade,
 name text not null check(length(name) between 1 and 100),
 phone text not null check(phone ~ '^\+[1-9][0-9]{7,14}$'),
 enabled boolean not null default true,
 created_at timestamptz not null default now(),
 unique(organization_id,id), unique(organization_id,phone)
);
create table if not exists public.agent_responsible_settings (
 organization_id uuid not null references public.organizations(id) on delete cascade,
 agent_id uuid not null,
 enabled boolean not null default false,
 conditions text not null default '' check(length(conditions)<=4000),
 primary key(organization_id,agent_id),
 foreign key(organization_id,agent_id) references public.ai_agents(organization_id,id) on delete cascade
);
create table if not exists public.agent_responsible_bindings (
 organization_id uuid not null,
 agent_id uuid not null,
 responsible_id uuid not null,
 primary key(organization_id,agent_id,responsible_id),
 foreign key(organization_id,agent_id) references public.agent_responsible_settings(organization_id,agent_id) on delete cascade,
 foreign key(organization_id,responsible_id) references public.agent_responsibles(organization_id,id) on delete cascade
);
create table if not exists public.agent_responsible_requests (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references public.organizations(id) on delete cascade,
 case_id uuid not null,
 conversation_id uuid not null,
 contact_id uuid not null,
 agent_id uuid not null,
 kind text not null check(kind in ('consultation','handoff')),
 status text not null default 'pending' check(status in ('pending','answered','delivered','cancelled','failed')),
 accepted_responsible_id uuid,
 created_at timestamptz not null default now(),
 delivered_at timestamptz,
 unique(organization_id,id),
 foreign key(organization_id,case_id) references public.agent_cases(organization_id,id) on delete cascade,
 foreign key(organization_id,conversation_id) references public.conversations(organization_id,id) on delete cascade,
 foreign key(organization_id,contact_id) references public.contacts(organization_id,id) on delete cascade,
 foreign key(organization_id,agent_id) references public.ai_agents(organization_id,id),
 foreign key(organization_id,accepted_responsible_id) references public.agent_responsibles(organization_id,id)
);
create unique index if not exists responsible_request_open_case on public.agent_responsible_requests(organization_id,case_id)
 where status in ('pending','answered','failed');
create unique index if not exists responsible_request_open_conversation on public.agent_responsible_requests(organization_id,conversation_id)
 where status in ('pending','answered','failed');
create index if not exists responsible_request_pause on public.agent_responsible_requests(organization_id,contact_id)
 where status in ('pending','answered','failed');
create table if not exists public.agent_responsible_deliveries (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references public.organizations(id) on delete cascade,
 request_id uuid not null,
 responsible_id uuid,
 purpose text not null check(purpose in ('wait_notice','notification','answer','receipt')),
 target_conversation_id uuid not null,
 target_contact_id uuid not null,
 source_message_id uuid references public.messages(id) on delete set null,
 body text,
 job_id uuid unique references public.job_queue(id) on delete set null,
 message_id uuid references public.messages(id) on delete set null,
 media_storage_path text,
 status text not null default 'pending' check(status in ('pending','sending','sent','failed','uncertain','blocked')),
 created_at timestamptz not null default now(),
 unique(organization_id,id),
 foreign key(organization_id,request_id) references public.agent_responsible_requests(organization_id,id) on delete cascade,
 foreign key(organization_id,responsible_id) references public.agent_responsibles(organization_id,id),
 foreign key(organization_id,target_conversation_id) references public.conversations(organization_id,id) on delete cascade,
 foreign key(organization_id,target_contact_id) references public.contacts(organization_id,id) on delete cascade
);
create unique index if not exists responsible_delivery_once on public.agent_responsible_deliveries(request_id,purpose,coalesce(responsible_id,'00000000-0000-0000-0000-000000000000'::uuid))
 where purpose in ('wait_notice','notification','answer');
create unique index if not exists responsible_answer_once on public.agent_responsible_deliveries(request_id) where purpose='answer';
create unique index if not exists responsible_receipt_once on public.agent_responsible_deliveries(organization_id,source_message_id) where purpose='receipt';

-- Reconstituir o vocabulário anterior também no bloco original do baseline:
-- update.sh reaplica o baseline sobre bancos que já têm o kind novo.
alter table public.job_queue drop constraint if exists job_queue_kind_check;
alter table public.job_queue add constraint job_queue_kind_check check(kind in
 ('inbound_turn','followup_turn','watchdog','flywheel','case_reply_turn','operator_turn','responsible_delivery','responsible_reply'));
alter table public.job_queue drop constraint if exists job_queue_turn_needs_contact;
alter table public.job_queue add constraint job_queue_turn_needs_contact check(
 (kind in ('inbound_turn','followup_turn','case_reply_turn','operator_turn','responsible_delivery','responsible_reply'))=(contact_id is not null));

create or replace function public.fn_responsible_waiting(p_org uuid,p_contact uuid)
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
 select exists(select 1 from agent_responsible_requests where organization_id=p_org and contact_id=p_contact
   and status in ('pending','answered','failed'))
 or exists(select 1 from agent_responsibles r join contacts c on c.organization_id=r.organization_id and c.phone_number=r.phone
   where c.organization_id=p_org and c.id=p_contact);
$$;
revoke execute on function public.fn_responsible_waiting(uuid,uuid) from public,anon,authenticated;
grant execute on function public.fn_responsible_waiting(uuid,uuid) to service_role;

-- Outbox e job nascem no MESMO commit. Cada entrega tem uma identidade permanente.
create or replace function public.fn_queue_responsible_delivery(p_org uuid,p_request uuid,p_responsible uuid,
 p_purpose text,p_conv uuid,p_contact uuid,p_body text default null,p_source uuid default null)
returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare v_id uuid; v_job uuid;
begin
 if not exists(select 1 from agent_responsible_requests where id=p_request and organization_id=p_org) then
   raise exception 'responsible_request_not_found';
 end if;
 insert into agent_responsible_deliveries(organization_id,request_id,responsible_id,purpose,
  target_conversation_id,target_contact_id,body,source_message_id)
 values(p_org,p_request,p_responsible,p_purpose,p_conv,p_contact,p_body,p_source)
 on conflict do nothing returning id into v_id;
 if v_id is null then return null; end if;
 insert into job_queue(organization_id,contact_id,kind,source_event_id,payload)
 values(p_org,p_contact,'responsible_delivery',v_id,jsonb_build_object('delivery_id',v_id)) returning id into v_job;
 update agent_responsible_deliveries set job_id=v_job where id=v_id and organization_id=p_org;
 return v_id;
end $$;

-- A cópia de uma resposta também pertence ao cliente. Se a anonimização vencer
-- uma cópia em andamento, registrar o path depois dela REABRE a fila de remoção.
create or replace function public.fn_responsible_media_privacy() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if new.media_storage_path is not null and exists(select 1 from agent_responsible_requests r join contacts c
   on c.organization_id=r.organization_id and c.id=r.contact_id
   where r.organization_id=new.organization_id and r.id=new.request_id and c.is_anonymized) then
  insert into storage_redaction_queue(organization_id,bucket,object_path,status,attempts)
   values(new.organization_id,'whatsapp-media',new.media_storage_path,'pending',0)
   on conflict(bucket,object_path) do update set status='pending',attempts=0,processed_at=null,error_message=null;
 end if;
 return new;
end $$;
revoke execute on function public.fn_responsible_media_privacy() from public,anon,authenticated;
drop trigger if exists trg_responsible_media_privacy on public.agent_responsible_deliveries;
create trigger trg_responsible_media_privacy after update of media_storage_path on public.agent_responsible_deliveries
 for each row execute function public.fn_responsible_media_privacy();

create or replace function public.fn_redact_responsible_customer() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if not new.is_anonymized or old.is_anonymized then return new; end if;
 -- A mesma ordem caso → pedido → entregas do transporte e da resposta humana.
 -- Sem isso, anonimizar podia segurar uma entrega e esperar o pedido que o
 -- transporte segurava enquanto esperava essa mesma entrega.
 perform a.id from agent_cases a join agent_responsible_requests r on r.organization_id=a.organization_id and r.case_id=a.id
  where r.organization_id=new.organization_id and r.contact_id=new.id order by a.id for update of a;
 update agent_responsible_requests set status='cancelled' where organization_id=new.organization_id and contact_id=new.id;
 insert into storage_redaction_queue(organization_id,bucket,object_path,status,attempts)
  select new.organization_id,'whatsapp-media',path,'pending',0 from (
   select m.media_storage_path path from agent_responsible_deliveries d join agent_responsible_requests r on r.id=d.request_id and r.organization_id=d.organization_id
    join messages m on m.organization_id=d.organization_id and (m.id=d.message_id or m.id=d.source_message_id)
    where r.organization_id=new.organization_id and r.contact_id=new.id and m.media_storage_path is not null
   union select d.media_storage_path from agent_responsible_deliveries d join agent_responsible_requests r on r.id=d.request_id and r.organization_id=d.organization_id
    where r.organization_id=new.organization_id and r.contact_id=new.id and d.media_storage_path is not null
  ) paths where true on conflict(bucket,object_path) do update set status='pending',attempts=0,processed_at=null,error_message=null;
 update messages m set body='[redacted]',media_url=null,media_storage_path=null,media_derived_text=null,
  metadata=jsonb_build_object('responsible_internal',coalesce(m.metadata->'responsible_internal','false'::jsonb),
   'idempotency_key',m.metadata->'idempotency_key','outbound_attempt',jsonb_build_object('phase',m.metadata#>>'{outbound_attempt,phase}','retryable',false))
  where m.organization_id=new.organization_id and exists(select 1 from agent_responsible_deliveries d join agent_responsible_requests r on r.id=d.request_id and r.organization_id=d.organization_id
    where r.organization_id=new.organization_id and r.contact_id=new.id and (m.id=d.message_id or m.id=d.source_message_id));
 update agent_responsible_deliveries d set body=null from agent_responsible_requests r
  where r.organization_id=new.organization_id and r.contact_id=new.id and d.organization_id=r.organization_id and d.request_id=r.id;
 update agent_case_events e set body='[redacted]',metadata='{}' from agent_responsible_requests r
  where r.organization_id=new.organization_id and r.contact_id=new.id and e.organization_id=r.organization_id and e.case_id=r.case_id;
 update agent_cases a set summary='[redacted]',blocker='[redacted]',context_snapshot='{}'
  where a.organization_id=new.organization_id and exists(select 1 from agent_responsible_requests r where r.organization_id=a.organization_id and r.case_id=a.id and r.contact_id=new.id);
 return new;
end $$;
revoke execute on function public.fn_redact_responsible_customer() from public,anon,authenticated;
drop trigger if exists trg_redact_responsible_customer on public.contacts;
create trigger trg_redact_responsible_customer after update of is_anonymized on public.contacts
 for each row execute function public.fn_redact_responsible_customer();

-- O último CAS antes da rede também trava pedido e caso. A resposta pela tela
-- não pode disputar com um envio humano já iniciado por este caminho.
create or replace function public.fn_guard_responsible_transport() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare d agent_responsible_deliveries%rowtype; r agent_responsible_requests%rowtype; c contacts%rowtype; target contacts%rowtype; v conversations%rowtype;
begin
 if new.status<>'sending' then return new; end if;
 select q.* into d from agent_responsible_deliveries q join send_ledger l on l.organization_id=q.organization_id and l.job_id=q.job_id
  where q.organization_id=new.organization_id and l.id=new.id and l.seq=1;
 if not found then
  if new.metadata->>'responsible_delivery_id' is not null then raise exception 'responsible_delivery_invalid' using errcode='42501'; end if;
  return new;
 end if;
 select * into r from agent_responsible_requests where organization_id=new.organization_id and id=d.request_id;
 perform 1 from agent_cases where organization_id=r.organization_id and id=r.case_id for update;
 select * into r from agent_responsible_requests where organization_id=new.organization_id and id=d.request_id for update;
 select * into d from agent_responsible_deliveries where organization_id=new.organization_id and id=d.id for update;
 select * into c from contacts where organization_id=r.organization_id and id=r.contact_id;
 select * into target from contacts where organization_id=new.organization_id and id=d.target_contact_id;
 select * into v from conversations where organization_id=r.organization_id and id=r.conversation_id;
 if c.is_blocked or c.is_anonymized or target.is_blocked or target.is_anonymized
  or v.contact_id is distinct from r.contact_id or v.status in ('closed','archived')
  or new.contact_id is distinct from d.target_contact_id or new.conversation_id is distinct from d.target_conversation_id
  or not exists(select 1 from conversations dest join channel_sessions ch
    on ch.organization_id=dest.organization_id and ch.id=dest.channel_session_id
    where dest.organization_id=r.organization_id and dest.id=d.target_conversation_id
      and dest.contact_id=d.target_contact_id and dest.status not in ('closed','archived')
      and dest.channel_session_id=v.channel_session_id and new.channel_session_id=dest.channel_session_id
      and ch.archived_at is null and ch.provider='waha')
  or not exists(select 1 from job_queue j join send_ledger l on l.job_id=j.id and l.organization_id=j.organization_id
    where j.organization_id=r.organization_id and j.id=d.job_id and j.status='running' and l.id=new.id and l.seq=1)
  or target.phone_number is distinct from new.metadata#>>'{responsible_recipient,phone}'
  or target.wa_identity is distinct from new.metadata#>>'{responsible_recipient,identity}'
  or target.wa_lid is distinct from new.metadata#>>'{responsible_recipient,lid}' then
   raise exception 'responsible_delivery_invalid' using errcode='42501'; end if;
 if d.purpose='answer' and (r.status<>'answered' or r.accepted_responsible_id is distinct from d.responsible_id) then
  raise exception 'responsible_answer_cancelled' using errcode='42501'; end if;
 if d.purpose in ('answer','wait_notice') and
   (d.target_contact_id is distinct from r.contact_id or d.target_conversation_id is distinct from r.conversation_id) then
  raise exception 'responsible_customer_mismatch' using errcode='42501'; end if;
 if d.purpose in ('notification','wait_notice') and r.status<>'pending' then
  raise exception 'responsible_notice_cancelled' using errcode='42501'; end if;
 if d.purpose in ('answer','wait_notice') and r.kind='consultation' and (c.force_human or v.assignee_kind='user' or v.bot_silenced_until>now()) then
  raise exception 'responsible_human_in_control' using errcode='42501'; end if;
 if d.responsible_id is not null and not exists(select 1 from agent_responsibles p
  join agent_responsible_bindings b on b.organization_id=p.organization_id and b.responsible_id=p.id
  join agent_responsible_settings s on s.organization_id=b.organization_id and s.agent_id=b.agent_id
  where p.organization_id=r.organization_id and p.id=d.responsible_id and p.enabled and s.enabled and s.agent_id=r.agent_id
    and (d.purpose='answer' or p.phone=target.phone_number)) then
   raise exception 'responsible_not_authorized' using errcode='42501'; end if;
 update agent_responsible_deliveries set status='sending',message_id=new.id where organization_id=new.organization_id and id=d.id;
 return new;
end $$;
revoke execute on function public.fn_guard_responsible_transport() from public,anon,authenticated;
drop trigger if exists trg_guard_responsible_transport on public.messages;
create trigger trg_guard_responsible_transport before update of status on public.messages
 for each row execute function public.fn_guard_responsible_transport();

create or replace function public.fn_guard_responsible_case_resolution() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if new.status is distinct from old.status and exists(select 1 from agent_responsible_requests r
  join agent_responsible_deliveries d on d.organization_id=r.organization_id and d.request_id=r.id and d.purpose='answer'
  join job_queue j on j.organization_id=d.organization_id and j.id=d.job_id
  where r.organization_id=new.organization_id and r.case_id=new.id and r.status='answered' and d.status='sending' and j.status='running') then
  raise exception 'responsible_answer_in_flight' using errcode='55P03';
 end if;
 return new;
end $$;
revoke execute on function public.fn_guard_responsible_case_resolution() from public,anon,authenticated;
drop trigger if exists trg_guard_responsible_case_resolution on public.agent_cases;
create trigger trg_guard_responsible_case_resolution before update of status on public.agent_cases
 for each row execute function public.fn_guard_responsible_case_resolution();
revoke execute on function public.fn_queue_responsible_delivery(uuid,uuid,uuid,text,uuid,uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.fn_queue_responsible_delivery(uuid,uuid,uuid,text,uuid,uuid,text,uuid) to service_role;

create or replace function public.fn_start_responsible_request(p_org uuid,p_case uuid,p_kind text default 'consultation')
returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare v_case agent_cases%rowtype; v_conv conversations%rowtype; v_req uuid; r_staff record; v_contact uuid; v_target uuid; v_changed uuid;
begin
 select * into v_case from agent_cases where organization_id=p_org and id=p_case for update;
 if not found or v_case.agent_id is null or v_case.status not in ('awaiting_human','awaiting_lead') then return null; end if;
 select * into v_conv from conversations where organization_id=p_org and id=v_case.conversation_id;
 if v_conv.contact_id is null or v_conv.status in ('closed','archived') then return null; end if;
 perform 1 from ai_agents where organization_id=p_org and id=v_case.agent_id for share;
 if not exists(select 1 from agent_responsible_settings s join ai_agents a
    on a.organization_id=s.organization_id and a.id=s.agent_id
    where s.organization_id=p_org and s.agent_id=v_case.agent_id and s.enabled
      and a.archived_at is null and a.published_version_id is not null) then return null; end if;
 if not exists(select 1 from channel_sessions where organization_id=p_org and id=v_conv.channel_session_id
    and provider='waha' and archived_at is null) then return null; end if;
 select id into v_req from agent_responsible_requests where organization_id=p_org and conversation_id=v_case.conversation_id
   and status in ('pending','answered','failed');
 if v_req is not null then
   if p_kind='handoff' then
    update agent_responsible_requests set kind='handoff' where id=v_req and organization_id=p_org and kind<>'handoff' returning id into v_changed;
    if v_changed is not null then
     perform fn_queue_responsible_delivery(p_org,v_req,n.responsible_id,'receipt',n.target_conversation_id,n.target_contact_id,
      'Atualização: o cliente pediu atendimento humano. Abra o atendimento para acompanhar a conversa; a IA continuará pausada.')
      from agent_responsible_deliveries n where n.organization_id=p_org and n.request_id=v_req and n.purpose='notification';
    end if;
   end if;
   return v_req;
 end if;
 if not exists(select 1 from agent_responsible_bindings b join agent_responsibles r
  on r.organization_id=b.organization_id and r.id=b.responsible_id
  where b.organization_id=p_org and b.agent_id=v_case.agent_id and r.enabled) then return null; end if;
 insert into agent_responsible_requests(organization_id,case_id,conversation_id,contact_id,agent_id,kind)
 values(p_org,p_case,v_conv.id,v_conv.contact_id,v_case.agent_id,p_kind) returning id into v_req;
 if p_kind='consultation' then
  perform fn_queue_responsible_delivery(p_org,v_req,null,'wait_notice',v_conv.id,v_conv.contact_id,
    'Vou confirmar essa informação com o responsável e retorno por aqui.');
 end if;
 for r_staff in select r.* from agent_responsible_bindings b join agent_responsibles r
  on r.organization_id=b.organization_id and r.id=b.responsible_id
  where b.organization_id=p_org and b.agent_id=v_case.agent_id and r.enabled for share of r
 loop
  -- Responsável não pode ser o próprio cliente nem a conexão usada para avisá-lo.
  if exists(select 1 from contacts where organization_id=p_org and id=v_conv.contact_id and phone_number=r_staff.phone)
    or exists(select 1 from channel_sessions where organization_id=p_org and id=v_conv.channel_session_id and phone_number=r_staff.phone) then continue; end if;
  v_contact := fn_upsert_wa_contact(p_org,'phone',r_staff.phone,null,substring(r_staff.phone from 2)||'@c.us',r_staff.name);
  v_target := fn_upsert_wa_conversation(p_org,v_contact,v_conv.channel_session_id);
  perform fn_queue_responsible_delivery(p_org,v_req,r_staff.id,'notification',v_target,v_contact);
 end loop;
 return v_req;
end $$;
revoke execute on function public.fn_start_responsible_request(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.fn_start_responsible_request(uuid,uuid,text) to service_role;

create or replace function public.fn_responsible_case_changed()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if current_setting('role',true) in ('anon','authenticated') then return new; end if;
 if new.status='awaiting_human' and (tg_op='INSERT' or old.status is distinct from new.status) then
  perform fn_start_responsible_request(new.organization_id,new.id,
   case when new.context_snapshot->>'responsible_kind'='handoff' then 'handoff' else 'consultation' end);
 elsif new.status in ('resolved','escalated','cancelled','awaiting_lead') then
  -- A resposta externa aceita fecha o caso SÓ após confirmação do transporte.
  -- A resolução pela tela, por outro lado, invalida a consulta externa pendente.
  update agent_responsible_requests set status='cancelled'
   where organization_id=new.organization_id and case_id=new.id and status in ('pending','answered','failed')
    and (new.status<>'escalated' or kind<>'handoff');
 end if;
 return new;
end $$;

create or replace function public.fn_guard_responsible_case_open() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if current_setting('role',true) in ('anon','authenticated') then return new; end if;
 if exists(select 1 from agent_responsible_settings where organization_id=new.organization_id and agent_id=new.agent_id and enabled) then
  perform 1 from conversations where organization_id=new.organization_id and id=new.conversation_id for update;
  if exists(select 1 from agent_cases where organization_id=new.organization_id and conversation_id=new.conversation_id and status in ('awaiting_human','awaiting_lead')) then return null; end if;
 end if;
 return new;
end $$;
revoke execute on function public.fn_guard_responsible_case_open() from public,anon,authenticated;
drop trigger if exists trg_guard_responsible_case_open on public.agent_cases;
create trigger trg_guard_responsible_case_open before insert on public.agent_cases
 for each row execute function public.fn_guard_responsible_case_open();

-- Antes do evento de mensagem, marcar o canal interno. A identidade vem do contato
-- resolvido pelo webhook; nem o texto nem o payload do modelo concedem permissão.
create or replace function public.fn_mark_responsible_inbound() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_id uuid; v_internal boolean;
begin
 if new.direction='inbound' then
  new.metadata:=coalesce(new.metadata,'{}'::jsonb)-'responsible_internal'-'responsible_id';
  if current_setting('role',true) in ('anon','authenticated') then return new; end if;
  select r.id into v_id from agent_responsibles r join contacts c
   on c.organization_id=r.organization_id and c.phone_number=r.phone
   where c.organization_id=new.organization_id and c.id=new.contact_id;
  if v_id is not null then new.metadata:=new.metadata||
   jsonb_build_object('responsible_internal',true,'responsible_id',v_id); end if;
 elsif new.direction='outbound' then
  -- A marca interna não é uma autorização recebida do payload. Só o vínculo
  -- durável ledger → outbox pode suprimir eventos comerciais de uma saída.
  new.metadata:=coalesce(new.metadata,'{}'::jsonb)-'responsible_internal'-'responsible_id';
  if current_setting('role',true) not in ('anon','authenticated') then
   select d.responsible_id,d.purpose in ('notification','receipt') into v_id,v_internal
    from agent_responsible_deliveries d join send_ledger l on l.organization_id=d.organization_id and l.job_id=d.job_id
    where d.organization_id=new.organization_id and l.id=new.id and l.seq=1
      and d.target_conversation_id=new.conversation_id and d.target_contact_id=new.contact_id;
   if found then new.metadata:=new.metadata||jsonb_build_object('responsible_internal',v_internal,'responsible_id',v_id); end if;
  end if;
 end if;
 return new;
end $$;
revoke execute on function public.fn_mark_responsible_inbound() from public,anon,authenticated;
drop trigger if exists trg_mark_responsible_inbound on public.messages;
create trigger trg_mark_responsible_inbound before insert or update on public.messages
 for each row execute function public.fn_mark_responsible_inbound();

create or replace function public.fn_queue_responsible_reply() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if new.direction='inbound' and new.metadata->>'responsible_internal'='true' then
  insert into job_queue(organization_id,contact_id,kind,source_event_id,payload)
   values(new.organization_id,new.contact_id,'responsible_reply',new.id,jsonb_build_object('message_id',new.id)) on conflict do nothing;
 end if;
 return new;
end $$;
revoke execute on function public.fn_queue_responsible_reply() from public,anon,authenticated;
drop trigger if exists trg_queue_responsible_reply on public.messages;
create trigger trg_queue_responsible_reply after insert on public.messages
 for each row execute function public.fn_queue_responsible_reply();

create or replace function public.fn_emit_message_event() returns trigger
language plpgsql set search_path=public,pg_temp as $$
declare v_event text;
begin
 if new.metadata->>'responsible_internal'='true' then return new; end if;
 if new.direction='inbound' then v_event:='message.received';
 else v_event:=case new.status when 'sending' then 'message.sending' when 'sent' then 'message.sent'
  when 'failed' then 'message.failed' else 'message.outbound' end; end if;
 perform public.fn_log_event(new.organization_id,v_event,jsonb_build_object(
  'message_id',new.id,'conversation_id',new.conversation_id,'contact_id',new.contact_id,
  'direction',new.direction,'type',new.type,'status',new.status,'external_id',new.external_id,
  'channel_session_id',new.channel_session_id,'body_preview',left(new.body,280)));
 return new;
end $$;
revoke execute on function public.fn_emit_message_event() from public,anon;
grant execute on function public.fn_emit_message_event() to service_role;
revoke execute on function public.fn_responsible_case_changed() from public,anon,authenticated;
drop trigger if exists trg_responsible_case_changed on public.agent_cases;
create trigger trg_responsible_case_changed after insert or update of status on public.agent_cases
 for each row execute function public.fn_responsible_case_changed();

-- Somente configuração admite escrita via usuário; os pedidos/outbox são do serviço.
do $$ declare t text; begin
 foreach t in array array['agent_responsibles','agent_responsible_settings','agent_responsible_bindings',
 'agent_responsible_requests','agent_responsible_deliveries'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('drop policy if exists tenant_isolation_%s_select on public.%I',t,t);
  execute format('create policy tenant_isolation_%s_select on public.%I for select to authenticated using (organization_id in (select fn_user_org_ids()))',t,t);
  execute format('revoke all on public.%I from anon,authenticated',t);
  execute format('grant select on public.%I to authenticated',t);
  execute format('grant all on public.%I to service_role',t);
 end loop;
end $$;
