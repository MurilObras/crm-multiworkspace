-- O enrollment já tem a proveniência (0222). Resposta interrompe o follow-up
-- pós-compra em QUALQUER nó, sem mudar o fluxo publicado nem criar scheduler.
create or replace function public.fn_kiwify_followup_reply() returns trigger
language plpgsql security invoker set search_path=public,pg_temp as $$
declare v_contact uuid;
begin
  if tg_table_name='followup_enrollments' then
    if new.automation_run_id is null or new.status not in ('active','waiting_reply','paused_handoff') then return new; end if;
    perform id from public.contacts where organization_id=new.organization_id and id=new.contact_id for update;
    if exists(select 1 from public.automation_rule_runs r
      join public.kiwify_receipts k on k.organization_id=r.organization_id and k.event_id=r.event_id
      join public.event_log e on e.organization_id=k.organization_id and e.id=k.event_id
      join public.conversations c on c.organization_id=r.organization_id and c.contact_id=new.contact_id
      join public.messages m on m.organization_id=c.organization_id and m.conversation_id=c.id
      where r.organization_id=new.organization_id and r.id=new.automation_run_id
        and m.direction='inbound' and m.created_at >= e.created_at) then
      new.status := 'cancelled'; new.outcome := 'replied'; new.cancel_reason := 'cancel_on_reply';
      new.next_eval_at := null; new.completed_at := now(); new.claimed_until := null;
    end if;
    return new;
  end if;
  if new.direction <> 'inbound' then return new; end if;
  select contact_id into v_contact from public.conversations where organization_id=new.organization_id and id=new.conversation_id;
  perform id from public.contacts where organization_id=new.organization_id and id=v_contact for update;
  update public.followup_enrollments f set status='cancelled',outcome='replied',cancel_reason='cancel_on_reply',
    next_eval_at=null,claimed_until=null,completed_at=now(),updated_at=now()
  where f.organization_id=new.organization_id and f.contact_id=v_contact
    and f.status in ('active','waiting_reply','paused_handoff')
    and exists(select 1 from public.automation_rule_runs r
      join public.kiwify_receipts k on k.organization_id=r.organization_id and k.event_id=r.event_id
      join public.event_log e on e.organization_id=k.organization_id and e.id=k.event_id
      where r.organization_id=f.organization_id and r.id=f.automation_run_id and new.created_at >= e.created_at);
  return new;
end $$;
revoke execute on function public.fn_kiwify_followup_reply() from public,anon,authenticated;
grant execute on function public.fn_kiwify_followup_reply() to service_role;
drop trigger if exists kiwify_followup_before_enroll on public.followup_enrollments;
create trigger kiwify_followup_before_enroll before insert or update on public.followup_enrollments
  for each row execute function public.fn_kiwify_followup_reply();
drop trigger if exists kiwify_followup_after_reply on public.messages;
create trigger kiwify_followup_after_reply after insert on public.messages
  for each row execute function public.fn_kiwify_followup_reply();
