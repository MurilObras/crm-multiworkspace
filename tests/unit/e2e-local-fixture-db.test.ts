// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { localFixtureDb } from "../e2e/helpers/local-fixture-db";

const { Pool } = vi.hoisted(() => ({ Pool: vi.fn(function () { return {}; }) }));
vi.mock("pg", () => ({ default: { Pool } }));
afterEach(() => { vi.unstubAllEnvs(); Pool.mockClear(); });

it.each([
  ["", "http://127.0.0.1:55421"],
  ["postgresql://test@127.0.0.1:55422/postgres", ""],
  ["postgresql://test@remote.invalid/postgres", "http://127.0.0.1:55421"],
  ["postgresql://test@127.0.0.1:55422/postgres", "https://remote.invalid"],
  ["https://localhost:55422/postgres", "http://127.0.0.1:55421"],
])("recusa um destino ausente ou remoto antes de abrir conexão: %s / %s", (db, api) => {
  vi.stubEnv("SUPABASE_DB_URL", db);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", api);
  expect(() => localFixtureDb()).toThrow();
  expect(Pool).not.toHaveBeenCalled();
});

it("usa o banco explicitamente publicado pelo runner, sem depender de nome de container", () => {
  const db = "postgresql://test@127.0.0.1:55422/postgres";
  vi.stubEnv("SUPABASE_DB_URL", db);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:55421");
  localFixtureDb();
  expect(Pool).toHaveBeenCalledExactlyOnceWith({ connectionString: db, max: 1 });
});
