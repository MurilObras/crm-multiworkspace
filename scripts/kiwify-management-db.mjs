// PostgreSQL descartável: mesma prelude oficial e baseline da instalação.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import pg from 'pg';
const port = Number(process.env.KIWIFY_TEST_PG_PORT);
const bin = process.env.KIWIFY_TEST_PG_BIN;
if (!bin || !Number.isInteger(port) || port < 1024 || port === 5432) throw new Error('Use cluster descartável');
const psql = join(bin, process.platform === 'win32' ? 'psql.exe' : 'psql');
const run = (db, sql) => execFileSync(psql, ['-X', '-h', '127.0.0.1', '-p', String(port), '-U', 'postgres', '-d', db, '-v', 'ON_ERROR_STOP=1', '-q', '-f', '-'], { input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 20 * 1024 * 1024 });
const prelude = readFileSync('scripts/test-db.sh', 'utf8').split("psql_install <<'SQL'")[1]?.split('\nSQL')[0];
assert(prelude?.includes('create extension if not exists vector'));
const baseline = readFileSync('supabase/baseline.sql', 'utf8');
const migration = readFileSync('supabase/migrations/20260924120000_0227_kiwify_management.sql', 'utf8');
assert(baseline.includes(migration.trim()), 'Migration deve estar inteira no baseline');
const reply = readFileSync('supabase/migrations/20260924130000_0228_kiwify_followup_reply.sql', 'utf8');
assert(baseline.includes(reply.trim()), 'Migration de follow-up deve estar inteira no baseline');
try {
  const client = new pg.Client({ host: '127.0.0.1', port, user: 'postgres', database: 'template1' });
  await client.connect();
  let exists;
  try {
    const { rows } = await client.query("select shobj_description(oid,'pg_database') marker from pg_database where datname='kiwify_fresh'");
    exists = rows.length > 0;
    if (exists) assert.equal(rows[0].marker, 'kiwify-disposable-validation');
  } finally { await client.end(); }
  if (!exists) { run('template1', 'create database kiwify_fresh;'); run('kiwify_fresh', prelude); }
  run('kiwify_fresh', baseline);
  run('kiwify_fresh', baseline);
  run('kiwify_fresh', migration);
  run('kiwify_fresh', reply);
  run('template1', "comment on database kiwify_fresh is 'kiwify-disposable-validation';");
  console.info('PASS baseline install/reapply e migration reapply');
} catch (error) {
  console.error(error.stderr || error.message);
  process.exitCode = 1;
}
