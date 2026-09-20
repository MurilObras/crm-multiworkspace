// Validação PostgreSQL nativo descartável. Não lê .env nem aceita URL remota.
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import pg from 'pg';

const root = process.cwd();
const bin = process.env.KIWIFY_TEST_PG_BIN;
const port = Number(process.env.KIWIFY_TEST_PG_PORT);
if (!bin || !Number.isInteger(port) || port < 1024 || port === 5432) throw new Error('Configure KIWIFY_TEST_PG_BIN/PORT de um cluster descartável');
const psql = join(bin, process.platform === 'win32' ? 'psql.exe' : 'psql');
const run = (db, sql) => execFileSync(psql, ['-X','-h','127.0.0.1','-p',String(port),'-U','postgres','-d',db,'-v','ON_ERROR_STOP=1','-q','-f','-'], { input: sql, encoding: 'utf8', stdio: ['pipe','pipe','pipe'], maxBuffer: 20 * 1024 * 1024 });
const official = readFileSync(resolve(root, 'scripts/test-db.sh'), 'utf8');
const prelude = official.split("psql_install <<'SQL'")[1]?.split('\nSQL')[0];
assert(prelude?.includes('create extension if not exists vector'), 'prelude oficial não encontrado');
const baseline = readFileSync(resolve(root,'supabase/baseline.sql'),'utf8');
const previous = execFileSync('git',['show','24a9a3b07d59048dfa254f6df340317334a88b95:supabase/baseline.sql'],{encoding:'utf8',maxBuffer:20*1024*1024});
const migration = readFileSync(resolve(root,'supabase/migrations/20260920120000_0220_kiwify_ingestion.sql'),'utf8');
const correction = readFileSync(resolve(root,'supabase/migrations/20260920220000_0221_kiwify_consent_privacy_actor.sql'),'utf8');

const catalog = `select jsonb_build_object(
  'tables',(select jsonb_agg(to_jsonb(x) order by table_name,ordinal_position) from (select table_name,column_name,ordinal_position,data_type,is_nullable,column_default from information_schema.columns where table_schema='public' and table_name like 'kiwify_%') x),
  'constraints',(select jsonb_agg(to_jsonb(x) order by relname,conname) from (select c.relname,k.conname,pg_get_constraintdef(k.oid) definition from pg_constraint k join pg_class c on c.oid=k.conrelid where c.relname like 'kiwify_%') x),
  'indexes',(select jsonb_agg(to_jsonb(x) order by indexname) from (select tablename,indexname,indexdef from pg_indexes where schemaname='public' and (tablename like 'kiwify_%' or indexname='catalog_products_org_id_key')) x),
  'policies',(select jsonb_agg(to_jsonb(x) order by tablename,policyname) from (select * from pg_policies where schemaname='public' and tablename like 'kiwify_%') x),
  'grants',(select jsonb_agg(to_jsonb(x) order by table_name,grantee,privilege_type) from (select table_name,grantee,privilege_type from information_schema.table_privileges where table_schema='public' and table_name like 'kiwify_%') x),
  'functions',(select jsonb_agg(to_jsonb(x) order by proname) from (select proname,prosecdef,proconfig,proacl::text,pg_get_functiondef(oid) definition from pg_proc where pronamespace='public'::regnamespace and proname in ('fn_ingest_kiwify','fn_configure_kiwify')) x)
) result`;
async function inspect(db) {
  const c = new pg.Client({host:'127.0.0.1',port,user:'postgres',database:db});
  await c.connect(); try { return (await c.query(catalog)).rows[0].result; } finally { await c.end(); }
}
try {
  for (const name of ['kiwify_fresh','kiwify_upgrade']) {
    run('template1',`drop database if exists ${name} with (force); create database ${name};`);
    run(name,prelude);
  }
  run('kiwify_fresh',baseline);
  console.info('PASS baseline INSTALL (ON_ERROR_STOP=1)');
  const fresh = await inspect('kiwify_fresh');
  run('kiwify_fresh',baseline);
  assert.deepEqual(await inspect('kiwify_fresh'),fresh);
  console.info('PASS baseline REAPPLY + catálogo invariável');
  run('kiwify_upgrade',previous);
  run('kiwify_upgrade',migration);
  run('kiwify_upgrade',correction);
  assert.deepEqual(await inspect('kiwify_upgrade'),fresh);
  run('kiwify_upgrade',migration);
  run('kiwify_upgrade',correction);
  assert.deepEqual(await inspect('kiwify_upgrade'),fresh);
  console.info('PASS base 24a9a3b0 + migrations 0220/0221 + REAPPLY: tabelas/constraints/índices/funções/grants/policies iguais');
  run('template1',"comment on database kiwify_fresh is 'kiwify-disposable-validation';");
  run('template1','drop database if exists kiwify_test with (force); create database kiwify_test template kiwify_fresh;');
  console.info('PASS kiwify_test preparado; sem consumidores de eventos');
} catch (e) {
  console.error(e.stderr || e.message);
  process.exitCode = 1;
}
