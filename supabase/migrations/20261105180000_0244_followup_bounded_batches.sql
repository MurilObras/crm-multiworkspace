-- Seleção pequena no banco; não transfere todas as conversas/metadata ao Node.
-- O episódio continua sendo decidido por fn_enroll_silence_episode (0236).
create or replace function public.fn_silence_contact_page(
  p_org uuid, p_cutoff timestamptz, p_segments text[], p_after uuid, p_limit integer
) returns table(contact_id uuid)
language sql stable security invoker set search_path=public,pg_temp as $$
  select c.id from public.contacts c
  join lateral (
    select v.last_inbound_at,v.channel_session_id from public.conversations v
    where v.organization_id=p_org and v.contact_id=c.id
      and v.status not in ('closed','archived') and v.last_inbound_at is not null
    order by v.last_inbound_at desc,v.id desc limit 1
  ) recent on true
  left join public.channel_sessions s on s.organization_id=p_org and s.id=recent.channel_session_id
  where c.organization_id=p_org and (p_after is null or c.id>p_after)
    and not c.is_blocked and not c.is_anonymized and not c.force_human
    and recent.last_inbound_at<=p_cutoff
    and (coalesce(cardinality(p_segments),0)=0 or c.tags && p_segments)
    and (s.metadata->>'ai_gate' is distinct from 'allowlist' or c.ai_authorized_at is not null)
    and not exists(select 1 from public.agent_responsibles r where r.organization_id=p_org and r.phone=c.phone_number)
    and not exists(select 1 from public.agent_responsible_requests r where r.organization_id=p_org
      and r.contact_id=c.id and r.status in ('pending','answered','failed'))
    and not exists(select 1 from public.followup_enrollments e where e.organization_id=p_org
      and e.contact_id=c.id and e.status in ('active','waiting_reply','paused_handoff','paused_manual'))
  order by c.id limit greatest(1,least(coalesce(p_limit,50),50));
$$;
revoke execute on function public.fn_silence_contact_page(uuid,timestamptz,text[],uuid,integer) from public,anon,authenticated;
grant execute on function public.fn_silence_contact_page(uuid,timestamptz,text[],uuid,integer) to service_role;

create or replace function public.fn_enroll_silence_batch(p_inputs jsonb)
returns table(contact_id uuid, inserted boolean)
language plpgsql security invoker set search_path=public,pg_temp as $$
declare item jsonb; org uuid;
begin
  if jsonb_typeof(p_inputs) is distinct from 'array' then
    raise exception 'silence_batch_invalid' using errcode='22023';
  end if;
  if jsonb_array_length(p_inputs)<1 or jsonb_array_length(p_inputs)>50 then
    raise exception 'silence_batch_size_invalid' using errcode='22023';
  end if;
  org:=(p_inputs->0->>'organization_id')::uuid;
  if org is null or exists(select 1 from jsonb_array_elements(p_inputs) x
    where (x->>'organization_id')::uuid is distinct from org) then
    raise exception 'silence_batch_org_invalid' using errcode='22023';
  end if;
  -- Ordem única de locks por contato, inclusive entre pointers concorrentes.
  for item in select value from jsonb_array_elements(p_inputs) order by value->>'contact_id' loop
    contact_id:=(item->>'contact_id')::uuid;
    -- O controle humano também trava o contato. Revalida a consulta interna
    -- depois desse lock, não com um snapshot anterior à espera por ele.
    perform 1 from public.contacts c where c.organization_id=org
      and c.id=(item->>'contact_id')::uuid for update;
    if exists(select 1 from public.agent_responsible_requests r where r.organization_id=org
      and r.contact_id=(item->>'contact_id')::uuid and r.status in ('pending','answered','failed'))
      or exists(select 1 from public.contacts c join public.agent_responsibles r
        on r.organization_id=org and r.phone=c.phone_number
        where c.organization_id=org and c.id=(item->>'contact_id')::uuid) then
      inserted:=false;
    else
      inserted:=public.fn_enroll_silence_episode(item);
    end if;
    return next;
  end loop;
end $$;
revoke execute on function public.fn_enroll_silence_batch(jsonb) from public,anon,authenticated;
grant execute on function public.fn_enroll_silence_batch(jsonb) to service_role;
notify pgrst, 'reload schema';
