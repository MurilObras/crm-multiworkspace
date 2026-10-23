import { afterAll, beforeAll, expect, it } from "vitest";
import pg from "pg";

if (!process.env.TEST_DB_CONTAINER)
  throw new Error("Rode via pnpm test:db, somente em banco descartável.");
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 2,
});
const org = "b8090000-0000-4000-8000-000000000001";
let agent: string;
beforeAll(async () => {
  await pool.query(
    "insert into organizations(id,slug,legal_name,display_name) values($1,'config-revision-proof','Revision','Revision')",
    [org],
  );
  agent = (
    await pool.query(
      "insert into ai_agents(organization_id,name,system_prompt) values($1,'Revision','test') returning id",
      [org],
    )
  ).rows[0].id;
});
afterAll(async () => {
  await pool.query("delete from organizations where id=$1", [org]);
  await pool.end();
});

it("duas conexões com a mesma revisão: só uma grava; JSON grande não entra no predicado", async () => {
  const revision = (await pool.query("select config_revision from ai_agents where id=$1", [agent]))
    .rows[0].config_revision;
  const sql =
    "update ai_agents set config=$1 where id=$2 and organization_id=$3 and config_revision=$4 returning config_revision";
  const results = await Promise.all(
    [1, 2].map((value) =>
      pool.query(sql, [
        JSON.stringify({ padding: "x".repeat(64_000), value }),
        agent,
        org,
        revision,
      ]),
    ),
  );
  expect(results.map((r) => r.rowCount).sort()).toEqual([0, 1]);
  const row = (
    await pool.query("select config,config_revision from ai_agents where id=$1", [agent])
  ).rows[0];
  expect(BigInt(row.config_revision)).toBe(BigInt(revision) + 1n);
  expect([1, 2]).toContain(row.config.value);
  expect(
    (
      await pool.query(sql, [
        "{}",
        agent,
        "b8090000-0000-4000-8000-000000000099",
        row.config_revision,
      ])
    ).rowCount,
  ).toBe(0);
});

it("alteração sem mudança de config não avança nem permite forjar a revisão", async () => {
  const before = (await pool.query("select config_revision from ai_agents where id=$1", [agent]))
    .rows[0].config_revision;
  await pool.query("update ai_agents set name='Outra descrição',config_revision=-1 where id=$1", [
    agent,
  ]);
  const after = (await pool.query("select config_revision from ai_agents where id=$1", [agent]))
    .rows[0].config_revision;
  expect(after).toBe(before);
  const permissions = await pool.query(
    "select has_function_privilege('anon','public.fn_ai_agent_config_revision()','execute') as anon,has_function_privilege('authenticated','public.fn_ai_agent_config_revision()','execute') as authenticated",
  );
  expect(permissions.rows[0]).toEqual({ anon: false, authenticated: false });
});
