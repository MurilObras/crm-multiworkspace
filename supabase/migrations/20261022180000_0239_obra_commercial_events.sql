-- v3 é aditivo: v2 continua controlando os retornos de teste e as 96 horas.
create table if not exists public.obra_commercial_links(
 organization_id uuid not null references public.organizations(id) on delete cascade,
 product_user_id uuid not null,contact_id uuid not null references public.contacts(id) on delete no action deferrable initially deferred,lead_id uuid not null,
 created_at timestamptz not null default now(),primary key(organization_id,product_user_id),
 unique(organization_id,lead_id),
 foreign key(organization_id,lead_id) references public.crm_leads(organization_id,id) on delete no action deferrable initially deferred
);
create table if not exists public.obra_commercial_receipts(
 organization_id uuid not null references public.organizations(id) on delete cascade,
 integration_id uuid not null references public.obra_access_integrations(id) on delete cascade,
 event_id uuid not null,product_user_id uuid not null,
 event_type text not null check(event_type in ('lead_registered','first_payment_received')),
 fingerprint text not null check(fingerprint ~ '^[a-f0-9]{64}$'),
 lead_id uuid not null,received_at timestamptz not null default now(),
 primary key(organization_id,integration_id,event_id),
 foreign key(organization_id,lead_id) references public.crm_leads(organization_id,id) on delete no action deferrable initially deferred
);
alter table public.obra_commercial_links enable row level security;
alter table public.obra_commercial_receipts enable row level security;
revoke all on public.obra_commercial_links,public.obra_commercial_receipts from public,anon,authenticated;
grant all on public.obra_commercial_links,public.obra_commercial_receipts to service_role;

create or replace function public.fn_receive_obra_commercial(
 p_org uuid,p_integration uuid,p_payload jsonb,p_fingerprint text,p_phone_variants text[],p_secret_encrypted bytea
) returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare cfg public.obra_access_integrations;r public.obra_commercial_receipts;b public.obra_commercial_links;
 c uuid;l uuid;stage uuid;n integer;other_email integer;kind text:=p_payload->>'event_type';
 product_user uuid:=(p_payload->>'product_user_id')::uuid;event uuid:=(p_payload->>'event_id')::uuid;
begin
 -- Serializa entregas e rotação de segredo; nenhuma identidade vem do workspace do payload.
 select * into cfg from public.obra_access_integrations where organization_id=p_org and id=p_integration for update;
 if not found or not cfg.is_active or not cfg.lifecycle_enabled or cfg.secret_encrypted is distinct from p_secret_encrypted
   then return jsonb_build_object('status','configuration_error');end if;
 if (p_payload->>'version')::integer<>3 or kind not in ('lead_registered','first_payment_received')
   or coalesce(cardinality(p_phone_variants),0)=0 then return jsonb_build_object('status','invalid_event');end if;
 select * into r from public.obra_commercial_receipts where organization_id=p_org and integration_id=p_integration and event_id=event;
 if found then
   if r.fingerprint<>p_fingerprint then return jsonb_build_object('status','conflict');end if;
   return jsonb_build_object('status','duplicate','event_id',event);
 end if;
 select * into b from public.obra_commercial_links where organization_id=p_org and product_user_id=product_user;
 c:=b.contact_id;l:=b.lead_id;
 if c is null then
   select contact_id,lead_id into c,l from public.obra_subscription_states where organization_id=p_org and product_user_id=product_user;
   if c is null then select contact_id,lead_id into c,l from public.obra_access_links where organization_id=p_org and product_user_id=product_user::text;end if;
 end if;
 if c is null then
   select count(*),(array_agg(id order by id))[1] into n,c from public.contacts where organization_id=p_org
     and phone_number=any(p_phone_variants) and is_merged_into is null and not is_anonymized;
   select count(*) into other_email from public.contacts where organization_id=p_org
     and email_normalized=lower(p_payload->>'email') and (c is null or id<>c) and is_merged_into is null;
   if n>1 or other_email>0 then return jsonb_build_object('status','identity_conflict');end if;
   if c is null then
     select id into stage from public.crm_stages where organization_id=p_org and pipeline_id=cfg.pipeline_id
       and not is_archived and not is_won and not is_lost order by position,id limit 1 for share;
     if stage is null then return jsonb_build_object('status','configuration_error');end if;
     insert into public.contacts(organization_id,name,email,phone_number,source)
       values(p_org,p_payload->>'name',lower(p_payload->>'email'),p_payload->>'phone','app_registration') returning id into c;
   elsif exists(select 1 from public.contacts where organization_id=p_org and id=c and email_normalized is not null
       and email_normalized<>lower(p_payload->>'email')) then return jsonb_build_object('status','identity_conflict');end if;
 end if;
 perform 1 from public.contacts where organization_id=p_org and id=c and not is_anonymized and is_merged_into is null for update;
 if not found then return jsonb_build_object('status','identity_conflict');end if;
 if l is null then
   select count(*),(array_agg(id order by id))[1] into n,l from public.crm_leads where organization_id=p_org
     and contact_id=c and pipeline_id=cfg.pipeline_id and status='open';
   if n>1 then return jsonb_build_object('status','identity_conflict');end if;
   if l is null then
     select id into stage from public.crm_stages where organization_id=p_org and pipeline_id=cfg.pipeline_id
       and not is_archived and not is_won and not is_lost order by position,id limit 1;
     if stage is null then return jsonb_build_object('status','configuration_error');end if;
     insert into public.crm_leads(organization_id,pipeline_id,stage_id,contact_id,title,source,created_at,position_in_stage)
       values(p_org,cfg.pipeline_id,stage,c,p_payload->>'name','app_registration',(p_payload->>'user_created_at')::timestamptz,
         (select coalesce(max(position_in_stage),0)+1000 from public.crm_leads where organization_id=p_org and stage_id=stage)) returning id into l;
   end if;
 end if;
 if not exists(select 1 from public.crm_leads where organization_id=p_org and id=l and contact_id=c and pipeline_id=cfg.pipeline_id)
   or exists(select 1 from public.obra_commercial_links where organization_id=p_org and lead_id=l and product_user_id<>product_user)
   then return jsonb_build_object('status','identity_conflict');end if;
 insert into public.obra_commercial_links(organization_id,product_user_id,contact_id,lead_id)values(p_org,product_user,c,l)
   on conflict(organization_id,product_user_id) do nothing;
 perform public.fn_capture_dashboard_attribution(p_org,c,null,l,
   'app_registration',null,null,p_payload->>'crm_ref');
 if kind='first_payment_received' then
   perform public.fn_record_crm_first_payment(p_org,l,(p_payload->>'amount_cents')::integer,p_payload->>'currency',
     (p_payload->>'paid_at')::timestamptz,1,'integration','obra:'||product_user::text||':first_payment',null,'',null,
     not coalesce((p_payload->>'has_trial')::boolean,false));
 end if;
 insert into public.obra_commercial_receipts(organization_id,integration_id,event_id,product_user_id,event_type,fingerprint,lead_id)
   values(p_org,p_integration,event,product_user,kind,p_fingerprint,l);
 update public.obra_access_integrations set last_received_at=now() where organization_id=p_org and id=p_integration;
 return jsonb_build_object('status','accepted','event_id',event);
end $$;
revoke execute on function public.fn_receive_obra_commercial(uuid,uuid,jsonb,text,text[],bytea) from public,anon,authenticated;
grant execute on function public.fn_receive_obra_commercial(uuid,uuid,jsonb,text,text[],bytea) to service_role;
create or replace function public.fn_export_obra_commercial(p_org uuid,p_contact uuid) returns jsonb
language sql stable security invoker set search_path=public,pg_temp as $$
 select jsonb_build_object('product_links',(select coalesce(jsonb_agg(jsonb_build_object('product_user_id',b.product_user_id,
   'lead_id',b.lead_id,'created_at',b.created_at)),'[]') from public.obra_commercial_links b
   where b.organization_id=p_org and b.contact_id=p_contact),
   'receipts',(select coalesce(jsonb_agg(jsonb_build_object('event_id',r.event_id,'event_type',r.event_type,'received_at',r.received_at)),'[]')
     from public.obra_commercial_receipts r join public.crm_leads l on l.organization_id=r.organization_id and l.id=r.lead_id
     where l.organization_id=p_org and l.contact_id=p_contact))
$$;
revoke execute on function public.fn_export_obra_commercial(uuid,uuid) from public,anon,authenticated;
grant execute on function public.fn_export_obra_commercial(uuid,uuid) to service_role;
notify pgrst,'reload schema';
