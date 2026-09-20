// Smoke do ARTEFATO Next real. Reusa o cluster/moldes; não roda migrations/suítes.
import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { existsSync, appendFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";

const root = process.cwd();
const bin = process.env.KIWIFY_TEST_PG_BIN;
const restExe = process.env.KIWIFY_TEST_POSTGREST;
const port = Number(process.env.KIWIFY_TEST_PG_PORT);
const artifact = resolve(".next/standalone/server.js");
assert(bin && restExe && existsSync(artifact), "Build standalone e binários locais obrigatórios");
assert(Number.isInteger(port) && port > 1024 && port !== 5432, "Porta de cluster descartável obrigatória");
const dbName = `kiwify_next_${Date.now()}`;
const db = new pg.Client({ host: "127.0.0.1", port, user: "postgres", database: "template1" });
let pool, rest, next, gateway;
const secret = randomBytes(32).toString("hex"), token = randomBytes(32).toString("hex");
const jwtSecret = randomBytes(32).toString("hex");
const log = process.env.KIWIFY_NEXT_LOG;
function sanitized(chunk) {
  let text = chunk.toString();
  for (const value of [secret, token, jwtSecret]) text = text.replaceAll(value, "[REDACTED]");
  return text.replace(/signature=[^\s&"']+/gi,"signature=[REDACTED]")
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,"[JWT]");
}
const safeEnv = {};
for (const key of ["SystemRoot","SYSTEMROOT","WINDIR","ComSpec","COMSPEC","TEMP","TMP","APPDATA","LOCALAPPDATA","USERPROFILE","HOME","PATHEXT","PATH","Path"]) {
  if (process.env[key]) safeEnv[key] = process.env[key];
}
safeEnv.PATH = `${bin};${safeEnv.PATH || safeEnv.Path || ""}`; delete safeEnv.Path;
async function listener(server) {
  server.listen(0,"127.0.0.1"); await once(server,"listening");
  return server.address().port;
}
async function unusedPort() { const s=createServer(); const p=await listener(s); await new Promise(r=>s.close(r)); return p; }
async function ready(url, child, method = "GET") {
  const deadline=Date.now()+60_000;
  while(Date.now()<deadline) {
    if(child.exitCode !== null) throw new Error(`local_server_exited_${child.exitCode}`);
    try { if((await fetch(url,{method,signal:AbortSignal.timeout(1000)})).ok) return; } catch {}
    await new Promise(r=>setTimeout(r,200));
  }
  throw new Error("local_server_not_ready");
}
async function stop(child) {
  if (child && child.exitCode === null) { const exited=once(child,"exit"); child.kill(); await exited; }
}
try {
  await db.connect();
  const marker=(await db.query("select shobj_description(oid,'pg_database') marker from pg_database where datname='kiwify_fresh'")).rows[0]?.marker;
  assert.equal(marker,"kiwify-disposable-validation");
  await db.query(`create database ${dbName} template kiwify_fresh`);
  await db.query(`alter database ${dbName} set app.nuvemshop_oauth_key='synthetic-next-encryption-key-only-for-isolated-tests'`);
  pool=new pg.Pool({host:"127.0.0.1",port,user:"postgres",database:dbName});
  const org=randomUUID();
  await pool.query("insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$1::text,'Synthetic','Synthetic')",[org]);
  const pipeline=(await pool.query("insert into crm_pipelines(organization_id,name,slug,position) values($1,'Test','test',1) returning id",[org])).rows[0].id;
  const stage=(await pool.query("insert into crm_stages(organization_id,pipeline_id,name,slug,position) values($1,$2,'Test','test',1) returning id",[org,pipeline])).rows[0].id;
  const product=(await pool.query("insert into catalog_products(organization_id,codigo,nome,preco_cents) values($1,'test','Synthetic',100) returning id",[org])).rows[0].id;
  await pool.query("select fn_configure_kiwify($1,$2,$3,fn_encrypt_oauth($4),$5)",[org,{name:"Next smoke",store_id:"test-store",pipeline_id:pipeline,stage_id:stage,products:[{external_product_id:"test-product",product_id:product}]},token,secret,randomUUID()]);
  const restPort=await unusedPort();
  rest=spawn(restExe,[],{windowsHide:true,stdio:"ignore",env:{...safeEnv,PGRST_DB_URI:`postgresql://postgres@127.0.0.1:${port}/${dbName}`,PGRST_DB_SCHEMAS:"public",PGRST_DB_ANON_ROLE:"anon",PGRST_JWT_SECRET:jwtSecret,PGRST_SERVER_HOST:"127.0.0.1",PGRST_SERVER_PORT:String(restPort),PGRST_LOG_LEVEL:"crit"}});
  await ready(`http://127.0.0.1:${restPort}/`,rest);
  // Apenas o prefixo do gateway Supabase; a rota Kiwify é servida pelo Next.
  gateway=createServer(async(req,res)=>{
    try {
      if(!req.url.startsWith("/rest/v1/")){res.writeHead(404);res.end();return;}
      const chunks=[];for await(const c of req) chunks.push(c);const body=Buffer.concat(chunks);
      const r=await fetch(`http://127.0.0.1:${restPort}${req.url.slice(8)}`,{method:req.method,headers:req.headers,...(body.length?{body}:{})});
      res.writeHead(r.status,Object.fromEntries(r.headers));res.end(Buffer.from(await r.arrayBuffer()));
    }catch{res.writeHead(503);res.end();}
  });
  const gatewayPort=await listener(gateway), nextPort=await unusedPort();
  const h=Buffer.from(JSON.stringify({alg:"HS256",typ:"JWT"})).toString("base64url");
  const p=Buffer.from(JSON.stringify({role:"service_role",exp:Math.floor(Date.now()/1000)+3600})).toString("base64url");
  const jwt=`${h}.${p}.${createHmac("sha256",jwtSecret).update(`${h}.${p}`).digest("base64url")}`;
  const preload=pathToFileURL(join(root,"tests/setup/kiwify-next-isolated.mjs")).href;
  const env={...safeEnv,NODE_ENV:"production",PORT:String(nextPort),HOSTNAME:"127.0.0.1",SENTRY_DSN:"off",NEXT_TELEMETRY_DISABLED:"1",NODE_OPTIONS:`--import="${preload}"`,KIWIFY_LOCAL_PORTS:String(gatewayPort),NEXT_PUBLIC_SUPABASE_URL:`http://127.0.0.1:${gatewayPort}`,NEXT_PUBLIC_SUPABASE_ANON_KEY:"synthetic-anon",SUPABASE_SERVICE_ROLE_KEY:jwt,SUPABASE_DB_URL:`postgresql://postgres@127.0.0.1:${port}/${dbName}`,INTERNAL_SECRET:"synthetic-internal",CPF_ENCRYPTION_KEY:"synthetic",WAHA_BYO_ENCRYPTION_KEY:"synthetic",AI_CRED_AES_KEY:Buffer.alloc(32,1).toString("base64"),WAHA_API_BASE_URL:"http://127.0.0.1:1",WAHA_API_KEY:"synthetic",WAHA_WEBHOOK_BASE_URL:"http://127.0.0.1:1",UPSTASH_REDIS_REST_URL:"disabled-for-isolated-test",UPSTASH_REDIS_REST_TOKEN:"synthetic"};
  next=spawn(process.execPath,[artifact],{cwd:resolve(".next/standalone"),env,windowsHide:true,stdio:["ignore","pipe","pipe"]});
  for(const stream of [next.stdout,next.stderr])stream.on("data",chunk=>{if(log)appendFileSync(log,sanitized(chunk));});
  const endpoint=`http://127.0.0.1:${nextPort}/api/v1/webhooks/kiwify/${token}`;
  await ready(endpoint,next,"HEAD");
  console.info("PASS servidor Next standalone pronto (produção), com proxy real");
  const payload={order_id:randomUUID(),store_id:"test-store",webhook_event_type:"order_approved",order_status:"paid",Product:{product_id:"test-product"},Customer:{full_name:"Synthetic",mobile:"+12025550160"}};
  async function send(body, signature) {
    const sig=signature ?? createHmac("sha1",secret).update(JSON.stringify(body)).digest("hex");
    const response=await fetch(`${endpoint}?signature=${sig}`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
    assert(response.headers.get("x-request-id"));
    return {status:response.status,result:await response.json()};
  }
  const first=await send(payload);assert.equal(first.status,200);assert.equal(first.result.data.status,"accepted");
  const retry=await send(payload);assert.equal(retry.status,200);assert.equal(retry.result.data.status,"duplicate");
  console.info("PASS assinatura válida/evento permitido e retry duplicate pelo Next");
  const invalid={...payload,order_id:randomUUID()};assert.equal((await send(invalid,"0".repeat(40))).status,401);
  assert.equal((await pool.query("select count(*)::int n from kiwify_receipts where order_id=$1",[invalid.order_id])).rows[0].n,0);
  console.info("PASS assinatura inválida → 401, sem receipt");
  for(const [event,status] of [["order_refunded","refunded"],["order_approved","waiting_payment"]]){
    const ignored={...payload,order_id:randomUUID(),webhook_event_type:event,order_status:status};
    const r=await send(ignored);assert.equal(r.status,200);assert.equal(r.result.data.status,"ignored");
    assert.deepEqual((await pool.query("select lead_id,event_id from kiwify_receipts where order_id=$1",[ignored.order_id])).rows[0],{lead_id:null,event_id:null});
  }
  console.info("PASS evento/status ignorados, sem lead/evento");
  const counts=(await pool.query("select (select count(*)::int from crm_leads where organization_id=$1) leads,(select count(*)::int from event_log where organization_id=$1 and event_type='lead.created') events,(select count(*)::int from messages where organization_id=$1) messages,(select count(*)::int from automation_rule_runs where organization_id=$1) runs",[org])).rows[0];
  assert.deepEqual(counts,{leads:1,events:1,messages:0,runs:0});
  console.info("PASS contagens finais: 1 lead, 1 lead.created, 0 mensagens, 0 execuções de automação");
  console.info(`Banco sintético preservado: ${dbName}`);
} catch(error) { console.error(sanitized(error.message));process.exitCode=1; }
finally {
  await stop(next);await stop(rest);
  if(gateway){gateway.closeAllConnections();await new Promise(r=>gateway.close(r));}
  if(pool)await pool.end();await db.end();
}
