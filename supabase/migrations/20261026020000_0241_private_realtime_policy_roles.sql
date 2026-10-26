-- Políticas privadas não se aplicam a sessões anônimas. O Realtime avalia
-- cada papel inscrito: um anon não pode chamar helpers privados e abortar
-- o lote que também entregaria eventos aos usuários autenticados.
-- Não concede EXECUTE, não muda predicados nem permissões entre organizações.
do $roles$
declare
  p record;
  destinos text;
begin
  for p in
    select c.relname, pol.polname, pol.polroles
    from pg_policy pol
    join pg_class c on c.oid = pol.polrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = any(array[
        'ai_agent_runs', 'ai_agents', 'ai_knowledge_sources',
        'calendar_appointments', 'conversations', 'crm_lead_activities',
        'crm_lead_reactivations', 'crm_lead_risk_states', 'crm_leads', 'messages'
      ])
      and pol.polcmd in ('r', '*')
      and 0 = any(pol.polroles)
  loop
    -- Conserva papéis explícitos de clones; troca apenas PUBLIC pelos papéis
    -- da aplicação. As regras de escrita separadas não participam do SELECT.
    select string_agg(quote_ident(rolname), ', ' order by rolname)
      into destinos
      from pg_roles
      where oid = any(array_remove(p.polroles, 0::oid)
        || array['authenticated'::regrole::oid, 'service_role'::regrole::oid]);
    execute format('alter policy %I on public.%I to %s', p.polname, p.relname, destinos);
  end loop;
end;
$roles$;
