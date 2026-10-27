-- 0243: o plano privado e seus marcadores só podem ser escritos pelos serviços.
-- A fila já é consumida por workers/admin; as telas usam leitura e rotas autorizadas.
revoke insert,update,delete,truncate,references,trigger on public.job_queue from public,anon,authenticated;

-- Defesa contra um GRANT acidental futuro: RLS também impede forjar/reabrir jobs.
drop policy if exists job_queue_internal_insert on public.job_queue;
create policy job_queue_internal_insert on public.job_queue as restrictive
 for insert to authenticated with check (false);
drop policy if exists job_queue_internal_update on public.job_queue;
create policy job_queue_internal_update on public.job_queue as restrictive
 for update to authenticated using (false) with check (false);
drop policy if exists job_queue_internal_delete on public.job_queue;
create policy job_queue_internal_delete on public.job_queue as restrictive
 for delete to authenticated using (false);

-- O metadata legado mantém a leitura atual. Texto privado só é visível para
-- quem pode ler a conversa exata, sem inferir por contato ou outra sessão.
drop policy if exists job_queue_private_delivery_select on public.job_queue;
create policy job_queue_private_delivery_select on public.job_queue as restrictive
 for select to authenticated,service_role using (
  not(payload ? 'response_delivery') or exists (
   select 1 from public.conversations c
    where c.organization_id=job_queue.organization_id
     and c.contact_id=job_queue.contact_id
     and c.id::text=job_queue.payload->>'conversation_id'
     and public.fn_can_view_conversation(c.organization_id,c.assigned_to_user_id)
  )
 );
