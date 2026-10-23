// @vitest-environment node
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const migration = readFileSync(
  "supabase/migrations/20261023190000_0240_agent_config_revision.sql",
  "utf8",
);

it("a revisão é do banco, cobre null/ABA e reaplicar a migration não altera dados", async () => {
  const db = new PGlite();
  try {
    await db.exec(
      "create role anon; create role authenticated; create table ai_agents(id int primary key, config jsonb, name text)",
    );
    await db.exec(migration);
    const triggerOid = (await db.query("select oid from pg_trigger where tgname='trg_ai_agent_config_revision'")).rows[0];
    await db.exec(`insert into ai_agents values(1,null,'Inicial',999)`);
    const read = async () =>
      BigInt(
        (await db.query<{ config_revision: number }>("select config_revision from ai_agents"))
          .rows[0]!.config_revision,
      );
    expect(await read()).toBe(0n);
    await db.exec("update ai_agents set name='Renomeado',config_revision=99");
    expect(await read()).toBe(0n);
    await db.exec(`update ai_agents set config='{}'`);
    expect(await read()).toBe(1n);
    await db.exec(`update ai_agents set config='{}',config_revision=-1`);
    expect(await read()).toBe(1n);
    await db.exec(`update ai_agents set config=null`);
    expect(await read()).toBe(2n);
    expect(
      (
        await db.query(
          "update ai_agents set config=$1 where id=1 and config_revision=0 returning id",
          ["{}"],
        )
      ).rows,
    ).toEqual([]);
    await db.exec(migration);
    expect((await db.query("select oid from pg_trigger where tgname='trg_ai_agent_config_revision'")).rows[0]).toEqual(triggerOid);
    expect(await read()).toBe(2n);
    expect(
      (
        await db.query(
          "select has_function_privilege('anon','fn_ai_agent_config_revision()','execute') as allowed",
        )
      ).rows[0],
    ).toEqual({ allowed: false });
    expect(
      (
        await db.query(
          "select has_function_privilege('authenticated','fn_ai_agent_config_revision()','execute') as allowed",
        )
      ).rows[0],
    ).toEqual({ allowed: false });
    // Revogar RPC não pode impedir a execução normal do trigger numa escrita autorizada.
    await db.exec('grant usage on schema public to authenticated; grant select,update on ai_agents to authenticated; set role authenticated');
    await db.exec("update ai_agents set config='{}'");
    expect(await read()).toBe(3n);
    await db.exec('reset role');
  } finally {
    await db.close();
  }
}, 30_000);
