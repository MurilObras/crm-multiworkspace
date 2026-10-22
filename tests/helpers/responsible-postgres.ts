import { readFileSync } from "node:fs";

/** Instala a função real em fixtures PGlite mínimas; o baseline/RLS é testado no PG. */
export async function installResponsiblePause(sql: { exec(query: string): Promise<unknown> }) {
  await sql.exec(`alter table contacts add column if not exists phone_number text;
    create table if not exists agent_responsible_requests(organization_id uuid,contact_id uuid,status text);
    create table if not exists agent_responsibles(organization_id uuid,phone text);`);
  const source = readFileSync("supabase/migrations/20261022010000_0237_responsible_whatsapp.sql","utf8");
  const fn = source.match(/create or replace function public\.fn_responsible_waiting\([\s\S]+?\$\$;/)?.[0];
  if (!fn) throw new Error("Guarda de consulta ausente");
  await sql.exec(fn);
}
