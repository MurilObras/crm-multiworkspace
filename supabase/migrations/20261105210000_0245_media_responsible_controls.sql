-- Controles compatíveis com as configurações anteriores: aviso ligado;
-- consulta automática por falha de áudio somente por escolha do operador.
alter table public.agent_responsible_settings add column if not exists notify_client boolean not null default true;
alter table public.agent_responsible_settings add column if not exists audio_failures_to_responsible boolean not null default false;

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
 if p_kind='consultation' and exists(select 1 from agent_responsible_settings
    where organization_id=p_org and agent_id=v_case.agent_id and notify_client) then
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
notify pgrst, 'reload schema';
