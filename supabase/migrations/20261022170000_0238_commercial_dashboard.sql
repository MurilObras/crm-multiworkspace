-- Primeiro pagamento e qualificação são fatos próprios, não inferências de status.
create unique index if not exists crm_leads_org_id_unique on public.crm_leads(organization_id,id);

create table if not exists public.crm_first_payments (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references public.organizations(id) on delete cascade,
 lead_id uuid not null,
 amount_cents integer not null check(amount_cents>0),
 currency text not null check(currency ~ '^[A-Z]{3}$'),
 paid_at timestamptz not null,
 quantity integer not null default 1 check(quantity between 1 and 10000),
 source text not null check(source in ('manual','integration')),
 external_id text,
 confirmed_by uuid references auth.users(id) on delete set null,
 note text not null default '' check(length(note)<=1000),
 voided_at timestamptz,
 history jsonb not null default '[]'::jsonb check(jsonb_typeof(history)='array'),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(organization_id,lead_id), unique(organization_id,external_id),
 foreign key(organization_id,lead_id) references public.crm_leads(organization_id,id) on delete no action deferrable initially deferred
);
create index if not exists crm_first_payments_period on public.crm_first_payments(organization_id,paid_at) where voided_at is null;

create table if not exists public.crm_lead_qualifications (
 organization_id uuid not null references public.organizations(id) on delete cascade,
 lead_id uuid not null, stage_id uuid not null,
 qualified_at timestamptz not null default now(),
 primary key(organization_id,lead_id),
 foreign key(organization_id,lead_id) references public.crm_leads(organization_id,id) on delete cascade
);

create table if not exists public.crm_campaign_assignments (
 organization_id uuid not null references public.organizations(id) on delete cascade,
 account_id text not null check(account_id ~ '^act_[0-9]+$'),
 campaign_id text not null check(campaign_id ~ '^[0-9]+$'),
 campaign_name text not null check(length(campaign_name) between 1 and 500),
 currency text not null check(currency ~ '^[A-Z]{3}$'),
 account_timezone text not null,
 enabled boolean not null default true,
 created_at timestamptz not null default now(),
 primary key(organization_id,account_id,campaign_id),
 unique(account_id,campaign_id)
);

create table if not exists public.crm_ad_spend_daily (
 organization_id uuid not null references public.organizations(id) on delete cascade,
 account_id text not null, campaign_id text not null,
 campaign_name text not null, day date not null,
 currency text not null check(currency ~ '^[A-Z]{3}$'),
 amount_cents bigint not null check(amount_cents>=0 and amount_cents<=9007199254740991),
 updated_at timestamptz not null default now(),
 primary key(organization_id,account_id,campaign_id,day),
 foreign key(organization_id,account_id,campaign_id)
   references public.crm_campaign_assignments(organization_id,account_id,campaign_id) on delete no action deferrable initially deferred
);

-- Um dia sem linha de gasto só é zero quando a leitura COMPLETA o confirmou.
create table if not exists public.crm_ad_spend_coverage (
 organization_id uuid not null, account_id text not null, campaign_id text not null, day date not null,
 currency text not null check(currency ~ '^[A-Z]{3}$'), account_timezone text not null,
 synced_at timestamptz not null default now(),
 primary key(organization_id,account_id,campaign_id,day),
 foreign key(organization_id,account_id,campaign_id)
   references public.crm_campaign_assignments(organization_id,account_id,campaign_id) on delete cascade
);
create table if not exists public.crm_ad_sync_accounts (
 organization_id uuid not null references public.organizations(id) on delete cascade,
 account_id text not null check(account_id ~ '^act_[0-9]+$'),
 lease_id uuid, locked_until timestamptz, last_attempt_at timestamptz,
 last_success_at timestamptz, last_error text,
 primary key(organization_id,account_id)
);

create table if not exists public.crm_lead_attribution (
 organization_id uuid not null references public.organizations(id) on delete cascade,
 lead_id uuid not null, source text not null,
 account_id text, campaign_id text, campaign_name text,
 adset_id text, ad_id text, click_id text,
 resolution_attempted_at timestamptz,
 method text not null check(method in ('referral','tracking_link','manual','inbound')),
 captured_at timestamptz not null default now(),
 primary key(organization_id,lead_id),
 foreign key(organization_id,lead_id) references public.crm_leads(organization_id,id) on delete cascade,
 foreign key(organization_id,account_id,campaign_id)
   references public.crm_campaign_assignments(organization_id,account_id,campaign_id) on delete no action deferrable initially deferred,
 check((account_id is null)=(campaign_id is null))
);

create table if not exists public.crm_campaign_links (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null,account_id text not null,campaign_id text not null,
 code text not null unique check(code ~ '^[a-f0-9]{24}$'),
 destination_url text not null check(length(destination_url) between 8 and 2000),
 kind text not null check(kind in ('whatsapp','website')),
 enabled boolean not null default true,created_at timestamptz not null default now(),
 foreign key(organization_id,account_id,campaign_id)
   references public.crm_campaign_assignments(organization_id,account_id,campaign_id) on delete no action deferrable initially deferred
);

-- Service role escreve somente após os guards da API/integração. Leitura herda o lead.
do $$ declare t text; begin
 foreach t in array array['crm_first_payments','crm_lead_qualifications','crm_lead_attribution'] loop
   execute format('alter table public.%I enable row level security',t);
   execute format('revoke all on public.%I from public,anon,authenticated',t);
   execute format('grant select on public.%I to authenticated',t);
   execute format('grant all on public.%I to service_role',t);
   execute format('drop policy if exists dashboard_parent_scope on public.%I',t);
   execute format('create policy dashboard_parent_scope on public.%1$I for select to authenticated using (
     organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id,''agent'')
     and exists(select 1 from public.crm_leads l where l.organization_id=%1$I.organization_id and l.id=%1$I.lead_id))',t);
 end loop;
 foreach t in array array['crm_campaign_assignments','crm_ad_spend_daily','crm_ad_spend_coverage','crm_ad_sync_accounts','crm_campaign_links'] loop
   execute format('alter table public.%I enable row level security',t);
   execute format('revoke all on public.%I from public,anon,authenticated',t);
   execute format('grant select on public.%I to authenticated',t);
   execute format('grant all on public.%I to service_role',t);
   execute format('drop policy if exists dashboard_marketing_scope on public.%I',t);
   execute format('create policy dashboard_marketing_scope on public.%I for select to authenticated using (
     organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id,''manager''))',t);
 end loop;
end $$;

-- Referências externas e revisões não são necessárias para o atendente ler seus indicadores.
revoke select on public.crm_first_payments from authenticated;
grant select(id,organization_id,lead_id,amount_cents,currency,paid_at,quantity,source,note,voided_at,created_at,updated_at)
 on public.crm_first_payments to authenticated;
revoke select on public.crm_lead_attribution from authenticated;
grant select(organization_id,lead_id,source,account_id,campaign_id,campaign_name,adset_id,ad_id,method,captured_at)
 on public.crm_lead_attribution to authenticated;

create or replace function public.fn_record_crm_first_payment(
 p_org uuid,p_lead uuid,p_amount integer,p_currency text,p_paid_at timestamptz,p_quantity integer,
 p_source text,p_external_id text,p_actor uuid,p_note text,p_expected_at timestamptz default null,p_close_lead boolean default true
) returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare old_payment public.crm_first_payments; result public.crm_first_payments; target_lead public.crm_leads; won_stage uuid; target_contact uuid;
begin
 if p_amount is null or p_amount<=0 or p_quantity is null or p_quantity not between 1 and 10000
   or p_currency is null or p_currency !~ '^[A-Z]{3}$' or p_paid_at is null or p_paid_at>now()+interval '5 minutes'
   or p_source is null or p_source not in ('manual','integration') or p_close_lead is null or coalesce(length(p_note),0)>1000
   or (p_source='manual' and p_actor is null)
   or (p_source='integration' and coalesce(length(p_external_id),0)=0) then
   raise exception 'invalid_first_payment' using errcode='22023';
 end if;
 select contact_id into target_contact from public.crm_leads where organization_id=p_org and id=p_lead;
 if target_contact is not null then
   perform 1 from public.contacts where organization_id=p_org and id=target_contact and not is_anonymized for update;
   if not found then raise exception 'contact_anonymized' using errcode='22023'; end if;
 end if;
 -- O mesmo lock serializa criação, edição manual e recebimentos duplicados.
 select * into target_lead from public.crm_leads where organization_id=p_org and id=p_lead for update;
 if not found then raise exception 'lead_not_found' using errcode='P0002'; end if;
 select * into old_payment from public.crm_first_payments where organization_id=p_org and lead_id=p_lead for update;
 if found then
   if p_source='integration' then
     if old_payment.source='integration' and old_payment.external_id=p_external_id
       and (old_payment.amount_cents<>p_amount or old_payment.currency<>p_currency or old_payment.paid_at<>p_paid_at or old_payment.quantity<>p_quantity) then
       raise exception 'first_payment_event_conflict' using errcode='23505';
     end if;
     return jsonb_build_object('changed',false,'payment',to_jsonb(old_payment));
   end if;
   if p_expected_at is null then
     if old_payment.voided_at is null and old_payment.amount_cents=p_amount and old_payment.currency=p_currency
       and old_payment.paid_at=p_paid_at and old_payment.quantity=p_quantity and old_payment.note=coalesce(p_note,'') then
       return jsonb_build_object('changed',false,'payment',to_jsonb(old_payment));
     end if;
     raise exception 'first_payment_exists' using errcode='23505';
   end if;
   if old_payment.updated_at<>p_expected_at then raise exception 'first_payment_changed' using errcode='40001'; end if;
   update public.crm_first_payments set amount_cents=p_amount,currency=p_currency,paid_at=p_paid_at,
     quantity=p_quantity,note=coalesce(p_note,''),confirmed_by=p_actor,voided_at=null,updated_at=clock_timestamp(),
     history=history || jsonb_build_array(jsonb_build_object('before',to_jsonb(old_payment)-'history','actor',p_actor,'at',clock_timestamp()))
     where organization_id=p_org and lead_id=p_lead returning * into result;
 else
   if p_expected_at is not null then raise exception 'first_payment_changed' using errcode='40001'; end if;
   insert into public.crm_first_payments(organization_id,lead_id,amount_cents,currency,paid_at,quantity,source,external_id,confirmed_by,note)
     values(p_org,p_lead,p_amount,p_currency,p_paid_at,p_quantity,p_source,p_external_id,p_actor,coalesce(p_note,'')) returning * into result;
 end if;
 -- Registro financeiro e avanço ficam na mesma transação; o trigger canônico resolve o status.
 if p_close_lead and old_payment.id is null and target_lead.status<>'won' then
   select id into won_stage from public.crm_stages where organization_id=p_org and pipeline_id=target_lead.pipeline_id
     and is_won and not is_archived order by position,id limit 1;
   if won_stage is not null then
     update public.crm_leads set stage_id=won_stage,closed_at=p_paid_at where organization_id=p_org and id=p_lead;
     perform public.emit_event('lead.stage_changed','crm_lead',p_lead,
       jsonb_build_object('from_stage_id',target_lead.stage_id,'to_stage_id',won_stage,'stage_id',won_stage,
         'pipeline_id',target_lead.pipeline_id,'contact_id',target_lead.contact_id,'status','won'),
       jsonb_build_object('source','confirmed_first_payment'),p_org);
   end if;
 end if;
 -- Só o consumidor financeiro usa este evento; status won isolado não é prova de recebimento.
 perform public.emit_event('crm.first_payment.confirmed','crm_lead',p_lead,
   jsonb_build_object('payment_id',result.id),jsonb_build_object('source','dashboard'),p_org);
 return jsonb_build_object('changed',true,'payment',to_jsonb(result),
   'funnel_closed',exists(select 1 from public.crm_leads where organization_id=p_org and id=p_lead and status='won'));
end $$;
revoke execute on function public.fn_record_crm_first_payment(uuid,uuid,integer,text,timestamptz,integer,text,text,uuid,text,timestamptz,boolean) from public,anon,authenticated;
grant execute on function public.fn_record_crm_first_payment(uuid,uuid,integer,text,timestamptz,integer,text,text,uuid,text,timestamptz,boolean) to service_role;

create or replace function public.fn_void_crm_first_payment(p_org uuid,p_lead uuid,p_expected_at timestamptz,p_actor uuid,p_reason text)
returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare old_payment public.crm_first_payments; result public.crm_first_payments; target_contact uuid;
begin
 if p_actor is null or length(btrim(coalesce(p_reason,''))) not between 3 and 1000 then
   raise exception 'invalid_payment_reason' using errcode='22023';
 end if;
 -- A mesma ordem do registro/anonimização evita recolocar dados pessoais na nota.
 select contact_id into target_contact from public.crm_leads where organization_id=p_org and id=p_lead;
 if target_contact is not null then
   perform 1 from public.contacts where organization_id=p_org and id=target_contact and not is_anonymized for update;
   if not found then raise exception 'contact_anonymized' using errcode='22023'; end if;
 end if;
 perform 1 from public.crm_leads where organization_id=p_org and id=p_lead for update;
 select * into old_payment from public.crm_first_payments where organization_id=p_org and lead_id=p_lead for update;
 if not found then raise exception 'payment_not_found' using errcode='P0002'; end if;
 if p_expected_at is null or old_payment.updated_at<>p_expected_at then raise exception 'first_payment_changed' using errcode='40001'; end if;
 if old_payment.voided_at is not null then return jsonb_build_object('changed',false,'payment',to_jsonb(old_payment)); end if;
 update public.crm_first_payments set voided_at=clock_timestamp(),note=p_reason,confirmed_by=p_actor,updated_at=clock_timestamp(),
   history=history || jsonb_build_array(jsonb_build_object('before',to_jsonb(old_payment)-'history','actor',p_actor,'at',clock_timestamp()))
   where organization_id=p_org and lead_id=p_lead returning * into result;
 return jsonb_build_object('changed',true,'payment',to_jsonb(result));
end $$;
revoke execute on function public.fn_void_crm_first_payment(uuid,uuid,timestamptz,uuid,text) from public,anon,authenticated;
grant execute on function public.fn_void_crm_first_payment(uuid,uuid,timestamptz,uuid,text) to service_role;

create or replace function public.fn_dashboard_qualification_entry() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if tg_op='UPDATE' and new.stage_id is not distinct from old.stage_id and new.pipeline_id is not distinct from old.pipeline_id then return new; end if;
 if exists(select 1 from public.crm_pipelines p where p.organization_id=new.organization_id and p.id=new.pipeline_id
   and not p.is_archived and (p.settings->'dashboard'->'qualified_stage_ids') ? new.stage_id::text) then
   insert into public.crm_lead_qualifications(organization_id,lead_id,stage_id)
     values(new.organization_id,new.id,new.stage_id) on conflict(organization_id,lead_id) do nothing;
 end if;
 return new;
end $$;
revoke execute on function public.fn_dashboard_qualification_entry() from public,anon,authenticated;
grant execute on function public.fn_dashboard_qualification_entry() to service_role;
drop trigger if exists dashboard_qualification_entry on public.crm_leads;
create trigger dashboard_qualification_entry after insert or update of stage_id,pipeline_id on public.crm_leads
 for each row execute function public.fn_dashboard_qualification_entry();

-- Snapshot único: paginação HTTP de várias tabelas produziria números de instantes diferentes.
create or replace function public.fn_crm_dashboard_inputs(
 p_org uuid,p_from timestamptz,p_to timestamptz,p_from_day date,p_to_day date,
 p_pipeline uuid default null,p_owner_user uuid default null,p_owner_agent uuid default null,
 p_source text default null,p_account text default null,p_campaign text default null
) returns jsonb language plpgsql stable security invoker set search_path=public,pg_temp as $$
declare result jsonb;
begin
 if not public.fn_role_at_least(p_org,'agent') then raise exception 'dashboard_forbidden' using errcode='42501'; end if;
 if p_from is null or p_to is null or p_from>=p_to or p_to-p_from>interval '367 days'
   or p_from_day is null or p_to_day is null or p_from_day>p_to_day or p_to_day-p_from_day>366 then
   raise exception 'dashboard_invalid_period' using errcode='22023';
 end if;
 with visible as materialized (
   select l.* from public.crm_leads l
   left join public.crm_lead_attribution a on a.organization_id=l.organization_id and a.lead_id=l.id
   where l.organization_id=p_org
     and (p_pipeline is null or l.pipeline_id=p_pipeline)
     and (p_owner_user is null or l.owner_user_id=p_owner_user)
     and (p_owner_agent is null or l.owner_agent_id=p_owner_agent)
     and (p_source is null or coalesce(a.source,l.source)=p_source)
     and (p_account is null or a.account_id=p_account)
     and (p_campaign is null or a.campaign_id=p_campaign)
     and (l.status='open' or l.created_at>=p_from and l.created_at<p_to
       or exists(select 1 from public.crm_first_payments f where f.organization_id=p_org and f.lead_id=l.id
         and f.paid_at>=p_from and f.paid_at<p_to and f.voided_at is null))
   order by l.id limit 50001
 ) select jsonb_build_object(
   'as_of',statement_timestamp(),
   'pipeline_measurements',(select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'dashboard_settings',p.settings->'dashboard')),'[]')
     from public.crm_pipelines p where p.organization_id=p_org),
   'too_many', (select count(*)>50000 from visible),
   'leads', (select coalesce(jsonb_agg(jsonb_build_object('id',l.id,'title',l.title,'created_at',l.created_at,
     'pipeline_id',l.pipeline_id,'stage_id',l.stage_id,'status',l.status,'value_cents',l.value_cents,'currency',l.currency,
     'owner_user_id',l.owner_user_id,'owner_agent_id',l.owner_agent_id,'source',l.source,'source_metadata','{}'::jsonb)),'[]') from visible l),
   'payments', (select coalesce(jsonb_agg(jsonb_build_object('lead_id',f.lead_id,'amount_cents',f.amount_cents,'currency',f.currency,
     'paid_at',f.paid_at,'quantity',f.quantity,'voided_at',f.voided_at)),'[]')
     from public.crm_first_payments f join visible l on l.id=f.lead_id and l.organization_id=f.organization_id where f.organization_id=p_org),
   'qualifications', (select coalesce(jsonb_agg(to_jsonb(q)),'[]') from public.crm_lead_qualifications q
     join visible l on l.id=q.lead_id and l.organization_id=q.organization_id where q.organization_id=p_org),
   'attributions', (select coalesce(jsonb_agg(jsonb_build_object('lead_id',a.lead_id,'source',a.source,'account_id',a.account_id,
     'campaign_id',a.campaign_id,'campaign_name',a.campaign_name,'captured_at',a.captured_at)),'[]') from public.crm_lead_attribution a
     join visible l on l.id=a.lead_id and l.organization_id=a.organization_id where a.organization_id=p_org),
   'coverage', (select coalesce(jsonb_agg(to_jsonb(c)),'[]') from (
     select a.account_id,a.campaign_id,a.campaign_name,a.currency,a.account_timezone,
       count(s.day) as covered_days,min(s.synced_at) as oldest_sync_at
     from public.crm_campaign_assignments a left join public.crm_ad_spend_coverage s
       on s.organization_id=a.organization_id and s.account_id=a.account_id and s.campaign_id=a.campaign_id
       and s.day between p_from_day and p_to_day and s.currency=a.currency and s.account_timezone=a.account_timezone
     where a.organization_id=p_org and (p_account is null or a.account_id=p_account) and (p_campaign is null or a.campaign_id=p_campaign)
     group by a.account_id,a.campaign_id,a.campaign_name,a.currency,a.account_timezone
   ) c),
   'spend', (select coalesce(jsonb_agg(to_jsonb(s)),'[]') from public.crm_ad_spend_daily s
     where s.organization_id=p_org and s.day>=p_from_day and s.day<=p_to_day
       and (p_account is null or s.account_id=p_account) and (p_campaign is null or s.campaign_id=p_campaign))
 ) into result;
 if (result->>'too_many')::boolean then raise exception 'dashboard_too_many_leads' using errcode='54000'; end if;
 return result-'too_many';
end $$;
revoke execute on function public.fn_crm_dashboard_inputs(uuid,timestamptz,timestamptz,date,date,uuid,uuid,uuid,text,text,text) from public,anon;
grant execute on function public.fn_crm_dashboard_inputs(uuid,timestamptz,timestamptz,date,date,uuid,uuid,uuid,text,text,text) to authenticated;

create or replace function public.fn_configure_crm_dashboard(
 p_org uuid,p_pipeline uuid,p_stages uuid[],p_quantity_label text,p_confirmed_conversions boolean
) returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare old_settings jsonb; result jsonb;
begin
 if length(btrim(coalesce(p_quantity_label,''))) not between 1 and 50 or p_stages is null or cardinality(p_stages)>100 or p_confirmed_conversions is null then
   raise exception 'dashboard_invalid_settings' using errcode='22023'; end if;
 select settings into old_settings from public.crm_pipelines where organization_id=p_org and id=p_pipeline and not is_archived for update;
 if not found then raise exception 'pipeline_not_found' using errcode='P0002'; end if;
 if (select count(*) from public.crm_stages where organization_id=p_org and pipeline_id=p_pipeline
   and id=any(p_stages) and not is_archived)<>cardinality(p_stages) then
   raise exception 'dashboard_invalid_stages' using errcode='22023'; end if;
 result:=jsonb_build_object('qualified_stage_ids',to_jsonb(p_stages),'quantity_label',btrim(p_quantity_label),
   'qualification_started_at',coalesce(nullif(old_settings->'dashboard'->'qualification_started_at','null'::jsonb),
     case when cardinality(p_stages)>0 then to_jsonb(clock_timestamp()) else 'null'::jsonb end));
 update public.crm_pipelines set settings=jsonb_set(coalesce(settings,'{}'),'{dashboard}',result,true)
   where organization_id=p_org and id=p_pipeline;
 update public.organizations set settings=jsonb_set(coalesce(settings,'{}'),'{dashboard}',
   coalesce(settings->'dashboard','{}')||jsonb_build_object('confirmed_payment_conversions',p_confirmed_conversions),true)
   where id=p_org;
 return result;
end $$;
revoke execute on function public.fn_configure_crm_dashboard(uuid,uuid,uuid[],text,boolean) from public,anon,authenticated;
grant execute on function public.fn_configure_crm_dashboard(uuid,uuid,uuid[],text,boolean) to service_role;

create or replace function public.fn_claim_dashboard_ad_sync(p_org uuid,p_account text)
returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare claimed public.crm_ad_sync_accounts; campaigns jsonb;
begin
 select jsonb_agg(campaign_id order by campaign_id) into campaigns from public.crm_campaign_assignments
   where organization_id=p_org and account_id=p_account and enabled;
 if campaigns is null then return null; end if;
 insert into public.crm_ad_sync_accounts(organization_id,account_id) values(p_org,p_account) on conflict do nothing;
 update public.crm_ad_sync_accounts set lease_id=gen_random_uuid(),locked_until=clock_timestamp()+interval '3 minutes',
   last_attempt_at=clock_timestamp() where organization_id=p_org and account_id=p_account
   and (locked_until is null or locked_until<clock_timestamp()) returning * into claimed;
 if not found then return null; end if;
 return jsonb_build_object('lease_id',claimed.lease_id,'campaign_ids',campaigns);
end $$;
revoke execute on function public.fn_claim_dashboard_ad_sync(uuid,text) from public,anon,authenticated;
grant execute on function public.fn_claim_dashboard_ad_sync(uuid,text) to service_role;

-- Só substitui o intervalo após TODAS as páginas. Token de lease impede uma
-- rodada vencida de sobrescrever uma consulta posterior que já terminou.
create or replace function public.fn_finish_dashboard_ad_sync(
 p_org uuid,p_account text,p_lease uuid,p_from date,p_to date,p_campaigns text[],p_currency text,p_timezone text,p_rows jsonb,p_error text default null
) returns boolean language plpgsql security invoker set search_path=public,pg_temp as $$
declare campaign text;
begin
 perform 1 from public.crm_ad_sync_accounts where organization_id=p_org and account_id=p_account
   and lease_id=p_lease and locked_until>clock_timestamp() for update;
 if not found then return false; end if;
 if p_error is not null then
   update public.crm_ad_sync_accounts set lease_id=null,locked_until=null,last_error=left(p_error,200)
     where organization_id=p_org and account_id=p_account and lease_id=p_lease;
   return true;
 end if;
 if p_from is null or p_to is null or p_to<p_from or p_to-p_from>365 or p_campaigns is null or cardinality(p_campaigns) not between 1 and 1000
   or p_currency is null or p_currency !~ '^[A-Z]{3}$' or not exists(select 1 from pg_timezone_names where name=p_timezone)
   or p_rows is null or jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows)>10000 then
   raise exception 'invalid_ad_sync' using errcode='22023'; end if;
 if (select count(*) from public.crm_campaign_assignments where organization_id=p_org and account_id=p_account
   and campaign_id=any(p_campaigns))<>cardinality(p_campaigns) then raise exception 'invalid_ad_campaigns' using errcode='22023'; end if;
 if exists(select 1 from jsonb_to_recordset(p_rows) as r(campaign_id text,day date,currency text,amount_cents bigint)
   where r.campaign_id is null or not r.campaign_id=any(p_campaigns) or r.day is null or r.day<p_from or r.day>p_to
   or r.currency is distinct from p_currency or r.amount_cents is null or r.amount_cents<0 or r.amount_cents>9007199254740991) then
   raise exception 'invalid_ad_rows' using errcode='22023'; end if;
 delete from public.crm_ad_spend_daily where organization_id=p_org and account_id=p_account
   and campaign_id=any(p_campaigns) and day between p_from and p_to;
 insert into public.crm_ad_spend_daily(organization_id,account_id,campaign_id,campaign_name,day,currency,amount_cents)
   select p_org,p_account,r.campaign_id,a.campaign_name,r.day,p_currency,r.amount_cents
   from jsonb_to_recordset(p_rows) as r(campaign_id text,day date,amount_cents bigint)
   join public.crm_campaign_assignments a on a.organization_id=p_org and a.account_id=p_account and a.campaign_id=r.campaign_id;
 foreach campaign in array p_campaigns loop
   insert into public.crm_ad_spend_coverage(organization_id,account_id,campaign_id,day,currency,account_timezone,synced_at)
     select p_org,p_account,campaign,p_from+i,p_currency,p_timezone,clock_timestamp() from generate_series(0,p_to-p_from) as g(i)
     on conflict(organization_id,account_id,campaign_id,day) do update set currency=excluded.currency,
       account_timezone=excluded.account_timezone,synced_at=excluded.synced_at;
 end loop;
 update public.crm_campaign_assignments set currency=p_currency,account_timezone=p_timezone
   where organization_id=p_org and account_id=p_account and campaign_id=any(p_campaigns);
 update public.crm_ad_sync_accounts set last_success_at=clock_timestamp(),last_error=null,locked_until=null,lease_id=null
   where organization_id=p_org and account_id=p_account and lease_id=p_lease;
 return true;
end $$;
revoke execute on function public.fn_finish_dashboard_ad_sync(uuid,text,uuid,date,date,text[],text,text,jsonb,text) from public,anon,authenticated;
grant execute on function public.fn_finish_dashboard_ad_sync(uuid,text,uuid,date,date,text[],text,text,jsonb,text) to service_role;

-- Uma conta por tick, a mais atrasada primeiro. Sem dados pessoais nem token.
create or replace function public.fn_dashboard_due_ad_account() returns jsonb
language sql stable security invoker set search_path=public,pg_temp as $$
 select jsonb_build_object('organization_id',a.organization_id,'account_id',a.account_id,'timezone',min(o.timezone))
 from public.crm_campaign_assignments a join public.organizations o on o.id=a.organization_id
 left join public.crm_ad_sync_accounts s on s.organization_id=a.organization_id and s.account_id=a.account_id
 where a.enabled and (s.locked_until is null or s.locked_until<now())
   and (s.last_attempt_at is null or s.last_attempt_at<now()-interval '1 hour')
 group by a.organization_id,a.account_id order by min(s.last_attempt_at) asc nulls first,a.organization_id,a.account_id limit 1
$$;
revoke execute on function public.fn_dashboard_due_ad_account() from public,anon,authenticated;
grant execute on function public.fn_dashboard_due_ad_account() to service_role;

create or replace function public.fn_capture_dashboard_attribution(
 p_org uuid,p_contact uuid,p_message uuid,p_lead uuid,p_source text,p_ad text,p_click text,p_code text
) returns boolean language plpgsql security invoker set search_path=public,pg_temp as $$
declare target uuid; link public.crm_campaign_links; a public.crm_campaign_assignments;
begin
 -- Mesmo lock da anonimização: não reintroduzir IDs pessoais depois da redação.
 perform 1 from public.contacts where organization_id=p_org and id=p_contact and not is_anonymized and not is_blocked for update;
 if not found then return false; end if;
 if p_message is not null and not exists(select 1 from public.messages where organization_id=p_org and id=p_message
   and contact_id=p_contact and direction='inbound') then raise exception 'invalid_attribution_message' using errcode='22023'; end if;
 select id into target from public.crm_leads where organization_id=p_org and contact_id=p_contact
   and status='open' and (p_lead is null or id=p_lead) order by created_at desc,id desc limit 1 for update;
 if target is null then return false; end if;
 if p_ad is not null and p_ad !~ '^[0-9]{1,100}$' or length(p_click)>500
   or p_source not in ('whatsapp','meta_ads','google_ads','app_registration') then raise exception 'invalid_attribution' using errcode='22023'; end if;
 if p_code is not null then
   select * into link from public.crm_campaign_links where organization_id=p_org and code=p_code and enabled;
   if found then select * into a from public.crm_campaign_assignments where organization_id=p_org
     and account_id=link.account_id and campaign_id=link.campaign_id; end if;
 end if;
 insert into public.crm_lead_attribution(organization_id,lead_id,source,account_id,campaign_id,campaign_name,ad_id,click_id,method)
 values(p_org,target,case when a.campaign_id is not null then 'meta_ads' else p_source end,
   a.account_id,a.campaign_id,a.campaign_name,p_ad,p_click,
   case when a.campaign_id is not null then 'tracking_link' when p_ad is not null or p_click is not null then 'referral' else 'inbound' end)
 on conflict(organization_id,lead_id) do update set
   source=excluded.source,account_id=excluded.account_id,campaign_id=excluded.campaign_id,campaign_name=excluded.campaign_name,
   ad_id=excluded.ad_id,click_id=excluded.click_id,method=excluded.method,captured_at=excluded.captured_at
 where crm_lead_attribution.method='inbound' and excluded.method<>'inbound';
 return found;
end $$;
revoke execute on function public.fn_capture_dashboard_attribution(uuid,uuid,uuid,uuid,text,text,text,text) from public,anon,authenticated;
grant execute on function public.fn_capture_dashboard_attribution(uuid,uuid,uuid,uuid,text,text,text,text) to service_role;

-- Dados pessoais novos entram na mesma transação da anonimização existente.
create or replace function public.fn_dashboard_redact_contact() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if new.is_anonymized and (not old.is_anonymized) then
   update public.crm_first_payments f set note='',history='[]'::jsonb,external_id=null
     from public.crm_leads l where l.organization_id=new.organization_id and l.contact_id=new.id
       and f.organization_id=l.organization_id and f.lead_id=l.id;
   update public.crm_lead_attribution a set click_id=null
     from public.crm_leads l where l.organization_id=new.organization_id and l.contact_id=new.id
       and a.organization_id=l.organization_id and a.lead_id=l.id;
 end if;
 return new;
end $$;
revoke execute on function public.fn_dashboard_redact_contact() from public,anon,authenticated;
grant execute on function public.fn_dashboard_redact_contact() to service_role;
drop trigger if exists dashboard_redact_contact on public.contacts;
create trigger dashboard_redact_contact after update of is_anonymized on public.contacts for each row execute function public.fn_dashboard_redact_contact();

create or replace function public.fn_export_dashboard_contact(p_org uuid,p_contact uuid) returns jsonb
language sql stable security invoker set search_path=public,pg_temp as $$
 select jsonb_build_object(
   'payments',(select coalesce(jsonb_agg(jsonb_build_object('lead_id',p.lead_id,'amount_cents',p.amount_cents,
     'currency',p.currency,'paid_at',p.paid_at,'quantity',p.quantity,'note',p.note,'voided_at',p.voided_at,
     'history',(select coalesce(jsonb_agg(jsonb_build_object('at',h->'at','before',jsonb_build_object(
       'amount_cents',h->'before'->'amount_cents','currency',h->'before'->'currency','paid_at',h->'before'->'paid_at',
       'quantity',h->'before'->'quantity','note',h->'before'->'note','voided_at',h->'before'->'voided_at'))),'[]')
       from jsonb_array_elements(p.history) as e(h)))),'[]') from public.crm_first_payments p
     join public.crm_leads l on l.organization_id=p.organization_id and l.id=p.lead_id where l.organization_id=p_org and l.contact_id=p_contact),
   'attributions',(select coalesce(jsonb_agg(jsonb_build_object('lead_id',a.lead_id,'source',a.source,'account_id',a.account_id,
     'campaign_id',a.campaign_id,'ad_id',a.ad_id,'click_id',a.click_id,'method',a.method,'captured_at',a.captured_at)),'[]')
     from public.crm_lead_attribution a join public.crm_leads l on l.organization_id=a.organization_id and l.id=a.lead_id
     where l.organization_id=p_org and l.contact_id=p_contact)
 )
$$;
revoke execute on function public.fn_export_dashboard_contact(uuid,uuid) from public,anon,authenticated;
grant execute on function public.fn_export_dashboard_contact(uuid,uuid) to service_role;

notify pgrst, 'reload schema';
