import { readFileSync } from "node:fs";

/** Fixture mínima usa a guarda real, não substitui seu resultado por true. */
export async function installCaseResolutionBarriers(sql: { exec(query: string): Promise<unknown> }) {
  await sql.exec(`
    create table if not exists agent_cases(id uuid,organization_id uuid,conversation_id uuid);
    create table if not exists agent_case_events(organization_id uuid,case_id uuid,kind text,
      metadata jsonb default '{}',created_at timestamptz default now());
    create table if not exists case_resolution_intents(organization_id uuid,conversation_id uuid,message_id uuid,status text);
  `);
  const source = readFileSync("supabase/migrations/20261109160000_0247_inbox_case_resolution.sql", "utf8");
  const fn = source.match(/create or replace function public\.fn_case_internal_outbound_live\([\s\S]+?\$\$;/)?.[0];
  if (!fn) throw new Error("Guarda real de encerramento interno ausente da migration");
  await sql.exec(fn);
}
