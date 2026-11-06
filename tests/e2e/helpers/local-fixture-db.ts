import pg from "pg";

/** O runner publica o destino de .env.e2e; nunca escolha outro container. */
export function localFixtureDb(): pg.Pool {
  const connectionString = process.env.SUPABASE_DB_URL;
  const apiUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!connectionString || !apiUrl) throw new Error("explicit_local_e2e_destinations_required");
  const db = new URL(connectionString);
  const api = new URL(apiUrl);
  const loopback = new Set(["localhost", "127.0.0.1", "[::1]"]);
  if (!loopback.has(db.hostname) || !loopback.has(api.hostname) ||
      !["postgres:", "postgresql:"].includes(db.protocol) || api.protocol !== "http:") {
    throw new Error("local_e2e_destinations_required");
  }
  return new pg.Pool({ connectionString, max: 1 });
}
