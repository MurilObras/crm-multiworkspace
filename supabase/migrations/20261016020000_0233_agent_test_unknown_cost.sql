-- O seam devolve NULL para modelo sem preço cadastrado. Desconhecido não é zero.
alter table public.ai_agent_runs alter column cost_cents drop not null;
alter table public.ai_agent_runs alter column cost_cents drop default;
notify pgrst, 'reload schema';
