-- 0242: correlação de retenções e descarte LGPD do plano privado de resposta.
alter table public.before_send_traces add column if not exists conversation_id uuid references public.conversations(id) on delete set null;
alter table public.before_send_traces add column if not exists response_key uuid;
create index if not exists idx_send_trace_conversation on public.before_send_traces(organization_id,channel_session_id,contact_id,created_at desc);

create or replace function public.fn_conversation_retentions(p_org uuid,p_conversation uuid)
returns table(id uuid,created_at timestamptz,vetoed_gate text,vetoed_code text,delivery_state text)
language sql stable security definer set search_path=''
as $$
 with scope as (
  select c.* from public.conversations c where c.id=p_conversation and c.organization_id=p_org
   and (coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'role',nullif(current_setting('request.jwt.claim.role',true),''))='service_role' or public.fn_can_view_conversation(c.organization_id,c.assigned_to_user_id))
 ), classified as (
 select t.id,t.created_at,t.vetoed_gate,t.vetoed_code,
  case when t.response_key is null then 'historical'
   when coalesce(d.uncertain,0)>0 then 'uncertain'
   when coalesce(d.expected,0)>0 and d.confirmed=d.expected then 'resolved'
   when coalesce(d.confirmed,0)>0 then 'partial' else 'pending' end delivery_state
 from public.before_send_traces t join scope c on c.organization_id=t.organization_id
  and c.contact_id=t.contact_id and c.channel_session_id=t.channel_session_id
 left join public.job_queue j on j.id=t.job_id and j.organization_id=t.organization_id and j.contact_id=t.contact_id
 left join lateral (
  select max(case when m.metadata->>'response_part_count' ~ '^[0-9]{1,2}$'
    then least((m.metadata->>'response_part_count')::integer,25) else 0 end) expected,
   count(*) filter(where m.status in('sent','delivered','read') and m.external_id is not null)::integer confirmed,
   count(*) filter(where (m.status='sending' or m.metadata->'outbound_attempt'->>'phase' in('started','uncertain'))
     and not(m.status in('sent','delivered','read') and m.external_id is not null))::integer uncertain
  from public.messages m join public.send_ledger l on l.organization_id=m.organization_id and l.contact_id=m.contact_id
   and l.crm_message_id=m.id and l.id::text=m.metadata->>'idempotency_key' and l.job_id=t.job_id
  where m.organization_id=t.organization_id and m.contact_id=t.contact_id and m.conversation_id=c.id
   and m.channel_session_id=c.channel_session_id and m.direction='outbound'
   and m.metadata->>'response_key'=t.response_key::text
 ) d on true
 where t.vetoed_gate is not null and t.created_at>=now()-interval '24 hours'
  and (t.conversation_id=c.id or (t.conversation_id is null and j.payload->>'conversation_id'=c.id::text))
 ) select * from classified where delivery_state<>'resolved'
 order by (delivery_state='historical'),created_at desc limit 5;
$$;
revoke all on function public.fn_conversation_retentions(uuid,uuid) from public,anon;
grant execute on function public.fn_conversation_retentions(uuid,uuid) to authenticated,service_role;

create or replace function public.fn_redact_response_delivery() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if TG_OP='DELETE' or NEW.is_anonymized then
  update public.job_queue set payload=payload-'response_delivery' where organization_id=OLD.organization_id and contact_id=OLD.id;
 end if;
 if TG_OP='DELETE' then return OLD; end if;
 return NEW;
end; $$;
revoke all on function public.fn_redact_response_delivery() from public,anon,authenticated;
drop trigger if exists redact_response_delivery on public.contacts;
create trigger redact_response_delivery before update of is_anonymized or delete on public.contacts
 for each row execute function public.fn_redact_response_delivery();
