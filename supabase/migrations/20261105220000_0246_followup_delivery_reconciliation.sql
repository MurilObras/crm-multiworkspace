-- Reconciliação da ação com fila e ledger da ocupação exata, sem reenvio.
create index if not exists idx_job_queue_followup_occupation on public.job_queue
 (organization_id,(payload->>'followup_enrollment_id'),(payload->>'node_id'),(payload->>'node_epoch'),created_at desc)
 where kind='followup_turn';

create or replace function public.fn_followup_reconcile_action(
 p_org uuid,p_id uuid,p_expected jsonb,p_next text
) returns text language plpgsql security invoker set search_path=public,pg_temp as $$
declare e public.followup_enrollments; j public.job_queue; action_key text;
 total integer; accepted integer; uncertain integer; held integer; result text; reason text;
 legacy_due timestamptz; veto text;
begin
 select * into e from public.followup_enrollments where organization_id=p_org and id=p_id for update;
 if not found or e.status not in ('active','waiting_reply')
   or e.status is distinct from p_expected->>'status'
   or e.current_node_id is distinct from p_expected->>'current_node_id'
   or e.node_epoch is distinct from (p_expected->>'node_epoch')::integer
   or e.steps_taken is distinct from (p_expected->>'steps_taken')::integer
   or e.updated_at is distinct from (p_expected->>'updated_at')::timestamptz then return 'stale'; end if;
 select ev.idempotency_key into action_key from public.followup_enrollment_events ev
   where ev.organization_id=p_org and ev.enrollment_id=p_id and ev.node_id=e.current_node_id
     and ev.event_type='turn_enqueued'
     and ev.created_at>=coalesce((select max(r.created_at) from public.followup_enrollment_events r
       where r.organization_id=p_org and r.enrollment_id=p_id and r.event_type='silence_resumed'),e.started_at)
   order by ev.created_at desc,ev.id desc limit 1;
 if action_key is null then return 'missing'; end if;
 select * into j from public.job_queue where organization_id=p_org and contact_id=e.contact_id and kind='followup_turn'
   and payload->>'followup_enrollment_id'=e.id::text and payload->>'node_id'=e.current_node_id
   and payload->>'node_epoch'=e.node_epoch::text and payload->>'enrollment_action_key'=action_key
   order by created_at desc,id desc limit 1;
 if not found then return 'missing'; end if;
 -- Enquanto o dono do job executa, não compete pelo seu checkpoint nem julga o transporte.
 if j.status in ('pending','running') then
   update public.followup_enrollments set next_eval_at=greatest(clock_timestamp()+interval '1 minute',j.run_after),
     claimed_until=null where organization_id=p_org and id=p_id;
   return 'waiting';
 end if;
 -- Compatibilidade com reentradas já agendadas antes desta correção.
 select min(next_run_at) into legacy_due from public.cron_jobs
   where organization_id=p_org and contact_id=e.contact_id and enabled
     and payload->>'reschedule_of'=j.id::text
     and payload->>'followup_enrollment_id'=e.id::text
     and payload->>'node_id'=e.current_node_id and payload->>'node_epoch'=e.node_epoch::text;
 if legacy_due is not null and not exists(select 1 from public.send_ledger where organization_id=p_org and job_id=j.id and status in ('accepted','requested','queued','uncertain')) then
   update public.followup_enrollments set next_eval_at=greatest(clock_timestamp()+interval '1 minute',legacy_due),claimed_until=null
     where organization_id=p_org and id=p_id;
   return 'waiting';
 end if;
 select vetoed_code into veto from public.before_send_traces where organization_id=p_org and job_id=j.id
   order by created_at desc,id desc limit 1;
 select count(*),count(*) filter(where status='accepted'),
   count(*) filter(where status in ('requested','uncertain')),count(*) filter(where status='queued')
   into total,accepted,uncertain,held from public.send_ledger where organization_id=p_org and job_id=j.id;
 if j.status='done' and total>0 and total=accepted and p_next is not null then
   if public.fn_followup_complete_step(p_org,p_id,p_expected,
     jsonb_build_object('node_id',e.current_node_id,'event_type','action_sent',
       'idempotency_key','delivery:'||j.id::text,'payload',jsonb_build_object('job_id',j.id,'enrollment_action_key',action_key,'reconciled',true)),
     jsonb_build_object('current_node_id',p_next,'status','active','steps_taken',e.steps_taken+1,
       'next_eval_at',clock_timestamp(),'claimed_until',null,'updated_at',clock_timestamp())) then return 'confirmed'; end if;
   return 'stale';
 end if;
 -- Entrega parcial, em trânsito ou retida não é prova de ausência de envio.
 if accepted>0 or uncertain>0 or held>0 then
   result:='review'; reason:='action_delivery_requires_review';
 elsif (total=0 and veto in ('contato_bloqueado','lgpd_anonymized')) or (j.status='failed' and j.last_error in
   ('contact_blocked','followup_inactive','lead_replied','human_in_control','opted_out','followup_expired','stale_inbound')) then
   result:='cancelled'; reason:=coalesce(veto,j.last_error);
 else result:='dead'; reason:='action_job_'||j.status||'_without_confirmed_delivery'; end if;
 update public.followup_enrollments set status=case when result='review' then 'paused_manual' else result end,
   last_error=reason,cancel_reason=case when result='cancelled' then reason else cancel_reason end,
   next_eval_at=null,claimed_until=null,completed_at=case when result in ('cancelled','dead') then clock_timestamp() else completed_at end,
   updated_at=clock_timestamp() where organization_id=p_org and id=p_id;
 insert into public.followup_enrollment_events(organization_id,enrollment_id,node_id,event_type,payload,idempotency_key)
   values(p_org,p_id,e.current_node_id,'action_delivery_reconciled',jsonb_build_object('job_id',j.id,'result',result,'reason',reason),
     'terminal:'||j.id::text) on conflict do nothing;
 if result<>'cancelled' then
   insert into public.agent_inbox_items(organization_id,kind,severity,title,body,ref_kind,ref_id)
     values(p_org,'followup_dead','warn',case when result='review' then 'Envio de acompanhamento precisa de conferência' else 'Acompanhamento terminou sem envio confirmado' end,
       case when result='review' then 'A inscrição foi pausada. Há entrega parcial, retida ou incerta; confira o atendimento antes de retomar para evitar repetição.'
       else 'A tarefa terminou sem confirmação de transporte. Confira a origem e as condições do atendimento antes de retomar.' end,
       'followup_enrollment',p_id);
 end if;
 return result;
end $$;
revoke execute on function public.fn_followup_reconcile_action(uuid,uuid,jsonb,text) from public,anon,authenticated;
grant execute on function public.fn_followup_reconcile_action(uuid,uuid,jsonb,text) to service_role;
notify pgrst, 'reload schema';
