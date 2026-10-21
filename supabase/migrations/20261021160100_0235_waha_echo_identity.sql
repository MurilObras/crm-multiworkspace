-- Correlaciona pelo ID que o provedor confirmou, nunca por corpo ou horário.
-- O eco permanece arquivado para referências/auditoria, sem aparecer duplicado.
create or replace function public.fn_waha_outbound_identity() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare canonical text;
begin
  if new.direction<>'outbound' or new.external_id is null or not exists(
    select 1 from public.channel_sessions s where s.id=new.channel_session_id
      and s.organization_id=new.organization_id and s.provider='waha') then return new; end if;
  canonical:=regexp_replace(new.external_id,'^.*_','');
  if canonical='' then return new; end if;
  if new.sent_via in ('ai','user') then
    -- UPDATE da confirmação toma o lock do original antes do eco. O sender
    -- conserva seu fence de job/ledger; este trigger não inventa confirmação.
    update public.messages m set external_id=null,metadata=coalesce(m.metadata,'{}')||jsonb_build_object(
      'reconciled_into_message_id',new.id::text,'original_external_id',m.external_id)
    where m.organization_id=new.organization_id and m.conversation_id=new.conversation_id
      and m.channel_session_id=new.channel_session_id and m.contact_id=new.contact_id
      and m.id<>new.id and m.direction='outbound' and m.sent_via='external_device'
      and m.type=new.type and regexp_replace(m.external_id,'^.*_','')=canonical;
  end if;
  new.external_id:=canonical;
  return new;
end $$;
revoke execute on function public.fn_waha_outbound_identity() from public,anon,authenticated;
drop trigger if exists tr_waha_outbound_identity on public.messages;
create trigger tr_waha_outbound_identity before insert or update of external_id on public.messages
  for each row execute function public.fn_waha_outbound_identity();

-- Repara duplicatas antigas sem apagar linhas nem FKs. Apenas grupos da MESMA
-- conversa/número/contato com prova de envio CRM confirmado são reconciliados.
with ranked as (
  select m.id,m.organization_id,m.conversation_id,m.channel_session_id,m.contact_id,
    regexp_replace(m.external_id,'^.*_','') as canonical,
    first_value(m.id) over w as original,
    first_value(m.sent_via) over w as origin
  from public.messages m join public.channel_sessions s on s.id=m.channel_session_id and s.organization_id=m.organization_id
  where s.provider='waha' and m.direction='outbound' and m.external_id is not null
    and m.status in ('sent','delivered','read')
  window w as (partition by m.organization_id,m.conversation_id,m.channel_session_id,m.contact_id,m.type,
    regexp_replace(m.external_id,'^.*_','') order by (m.sent_via in ('ai','user')) desc,m.created_at,m.id)
) update public.messages m set external_id=null,metadata=coalesce(m.metadata,'{}')||jsonb_build_object(
    'reconciled_into_message_id',r.original::text,'original_external_id',m.external_id)
  from ranked r where r.id=m.id and r.organization_id=m.organization_id and r.id<>r.original
    and r.origin in ('ai','user') and m.sent_via='external_device';
