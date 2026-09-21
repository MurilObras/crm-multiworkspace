// Só o cluster descartável, já marcado pelo harness da etapa 1. Não lê .env.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import pg from 'pg';
const port=Number(process.env.KIWIFY_TEST_PG_PORT);
const bin=process.env.KIWIFY_TEST_PG_BIN;
if (!bin || !Number.isInteger(port) || port<1024 || port===5432) throw new Error('Use cluster descartável');
const psql=join(bin,process.platform==='win32'?'psql.exe':'psql');
const run=(db,sql)=>execFileSync(psql,['-X','-h','127.0.0.1','-p',String(port),'-U','postgres','-d',db,'-v','ON_ERROR_STOP=1','-q','-f','-'],{input:sql,encoding:'utf8',stdio:['pipe','pipe','pipe'],maxBuffer:20*1024*1024});
const client=new pg.Client({host:'127.0.0.1',port,user:'postgres',database:'template1'});
await client.connect();
try {
  const marker=(await client.query("select shobj_description(oid,'pg_database') marker from pg_database where datname='kiwify_fresh'")).rows[0]?.marker;
  assert.equal(marker,'kiwify-disposable-validation');
} finally { await client.end(); }
const prelude=readFileSync('scripts/test-db.sh','utf8').split("psql_install <<'SQL'")[1]?.split('\nSQL')[0];
assert(prelude?.includes('create extension if not exists vector'));
const baseline=readFileSync('supabase/baseline.sql','utf8');
const base=execFileSync('git',['show','4d6d957d01766891a6eb9f4a88b4576a40b24440:supabase/baseline.sql'],{encoding:'utf8',maxBuffer:20*1024*1024});
const migration=['20260921010000_0222_automation_action_identity','20260921030000_0223_automation_event_plan','20260921120000_0224_automation_plan_redaction']
  .map(name=>readFileSync(`supabase/migrations/${name}.sql`,'utf8')).join('\n');
for (const name of ['kiwify_fresh','kiwify_upgrade']) {
  run('template1',`drop database if exists ${name} with (force);create database ${name};`);
  run(name,prelude);
}
run('kiwify_fresh',baseline);run('kiwify_fresh',baseline);
run('kiwify_upgrade',base);run('kiwify_upgrade',migration);run('kiwify_upgrade',migration);
const catalog=`select jsonb_build_object(
 'columns',(select jsonb_agg(to_jsonb(x) order by table_name,ordinal_position) from
  (select table_name,column_name,data_type,is_nullable,column_default,ordinal_position from information_schema.columns
   where table_schema='public' and table_name in ('automation_rule_runs','followup_enrollments','automation_event_plans')) x),
 'constraints',(select jsonb_agg(to_jsonb(x) order by conname) from
   (select conname,pg_get_constraintdef(oid) definition from pg_constraint where conrelid in ('automation_rule_runs'::regclass,'followup_enrollments'::regclass,'automation_event_plans'::regclass)) x),
  'functions',(select jsonb_agg(jsonb_build_object('name',proname,'definition',pg_get_functiondef(oid),'acl',proacl) order by proname)
    from pg_proc where pronamespace='public'::regnamespace and (proname like 'fn%automation%plan%' or proname like 'fn_automation_%'))
) result`;
async function inspect(database){const c=new pg.Client({host:'127.0.0.1',port,user:'postgres',database});await c.connect();try{return(await c.query(catalog)).rows[0].result;}finally{await c.end();}}
assert.deepEqual(await inspect('kiwify_fresh'),await inspect('kiwify_upgrade'));
run('template1',"comment on database kiwify_fresh is 'kiwify-disposable-validation';");
console.info('PASS: baseline install/reapply, main + 0222–0224/reapply, colunas/constraints/funções/ACL equivalentes');
