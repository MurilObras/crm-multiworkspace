import pg from "pg";
const port = Number(process.env.TEST_DB_PORT);
if (!Number.isInteger(port) || port < 1024 || port === 5432) throw new Error("Porta descartável obrigatória");
const client = new pg.Client({ host: "127.0.0.1", port, user: "postgres", database: "template1" });
await client.connect();
try {
  const { rows } = await client.query("select shobj_description(oid,'pg_database') marker from pg_database where datname='kiwify_fresh'");
  if (rows[0]?.marker !== "kiwify-disposable-validation") throw new Error("Cluster não foi preparado pelo harness Kiwify");
  await client.query("drop database if exists kiwify_test with (force)");
  await client.query("create database kiwify_test template kiwify_fresh");
} finally { await client.end(); }
