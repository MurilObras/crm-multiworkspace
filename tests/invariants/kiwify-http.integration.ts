import { createHmac, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import pg from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { POST as KiwifyPost } from "@/app/api/v1/webhooks/kiwify/[token]/route";

// Suíte HTTP explícita em vitest.kiwify.config.ts (requer também PostgREST).
// Handler de produção, cliente Supabase e PostgREST REAIS. Só o transporte HTTP
// do Next é hospedado pelo harness; nenhuma query, RPC ou dependência é mockada.
if (process.env.KIWIFY_TEST_NATIVE !== "1" || !process.env.KIWIFY_TEST_POSTGREST) {
  throw new Error("Execute com vitest.kiwify.config.ts e KIWIFY_TEST_POSTGREST local");
}
const pool = new pg.Pool({ host: "127.0.0.1", port: Number(process.env.TEST_DB_PORT), user: "postgres", database: "kiwify_test" });
const secret = "synthetic-webhook-secret";
const jwtSecret = "synthetic-jwt-secret-only-for-isolated-validation";
const token = "b".repeat(64);
const org = randomUUID();
const actor = randomUUID();
let rest: ChildProcess | undefined, server: Server | undefined, endpoint: string;
let handler: typeof KiwifyPost;
let restPort: number;

async function listen(s: Server) {
  s.listen(0, "127.0.0.1"); await once(s, "listening");
  const a = s.address(); if (!a || typeof a === "string") throw new Error("invalid test listener");
  return a.port;
}
beforeAll(async () => {
  await pool.query("alter database kiwify_test set app.nuvemshop_oauth_key='synthetic-encryption-key-only-for-tests'");
  await pool.query("insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$1::text,'Synthetic','Synthetic')", [org]);
  await pool.query("insert into auth.users(id,email) values($1,'http-actor@example.invalid')", [actor]);
  await pool.query("insert into user_organizations(user_id,organization_id,role,accepted_at) values($1,$2,'manager',now())", [actor, org]);
  const p = (await pool.query("insert into crm_pipelines(organization_id,name,slug,position) values($1,'Test','test',1) returning id", [org])).rows[0].id;
  const s = (await pool.query("insert into crm_stages(organization_id,pipeline_id,name,slug,position) values($1,$2,'Test','test',1) returning id", [org,p])).rows[0].id;
  const product = (await pool.query("insert into catalog_products(organization_id,codigo,nome,preco_cents) values($1,'test','Synthetic',100) returning id", [org])).rows[0].id;
  const configClient = await pool.connect();
  try {
    await configClient.query("set role service_role; set app.nuvemshop_oauth_key='synthetic-encryption-key-only-for-tests'");
    await configClient.query("select fn_configure_kiwify($1,$2,$3,fn_encrypt_oauth($4),$5,$6)", [org,{ name: "Synthetic", store_id: "store-test", pipeline_id: p, stage_id: s, products: [{ external_product_id: "product-test", product_id: product }] },token,secret,randomUUID(),actor]);
  } finally { await configClient.query("reset role"); configClient.release(); }
  const probe = createServer(); restPort = await listen(probe); await new Promise<void>(resolve => probe.close(() => resolve()));
  rest = spawn(process.env.KIWIFY_TEST_POSTGREST!, [], {
    stdio: "ignore", windowsHide: true,
    env: { ...process.env, PGRST_DB_URI: `postgresql://postgres@127.0.0.1:${process.env.TEST_DB_PORT}/kiwify_test`, PGRST_DB_SCHEMAS: "public", PGRST_DB_ANON_ROLE: "anon", PGRST_JWT_SECRET: jwtSecret, PGRST_SERVER_HOST: "127.0.0.1", PGRST_SERVER_PORT: String(restPort), PGRST_LOG_LEVEL: "crit" },
  });
  await vi.waitFor(async () => { expect((await fetch(`http://127.0.0.1:${restPort}/`)).ok).toBe(true); }, { timeout: 15_000 });
  server = createServer(async (req,res) => {
    try {
      const body: Buffer[] = []; for await (const chunk of req) body.push(Buffer.from(chunk));
      const bytes = Buffer.concat(body);
      let response: Response;
      if (req.url?.startsWith("/rest/v1/")) {
        response = await fetch(`http://127.0.0.1:${restPort}${req.url.slice(8)}`, { method: req.method, headers: req.headers as Record<string,string>, ...(bytes.length ? { body: bytes } : {}) });
      } else {
        response = await handler(new Request(`http://127.0.0.1${req.url}`, { method: req.method, headers: req.headers as Record<string,string>, body: bytes }), { params: Promise.resolve({ token }) });
      }
      res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
    } catch { res.writeHead(500); res.end(); }
  });
  const port = await listen(server);
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const claims = Buffer.from(JSON.stringify({ role: "service_role", exp: Math.floor(Date.now()/1000)+3600 })).toString("base64url");
  const jwt = `${header}.${claims}.${createHmac("sha256",jwtSecret).update(`${header}.${claims}`).digest("base64url")}`;
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL",`http://127.0.0.1:${port}`);
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY",jwt);
  vi.stubEnv("UPSTASH_REDIS_REST_URL", ""); vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
  handler = (await import("@/app/api/v1/webhooks/kiwify/[token]/route")).POST;
  endpoint = `http://127.0.0.1:${port}/api/v1/webhooks/kiwify/${token}`;
});
afterAll(async () => {
  if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); }
  if (rest && rest.exitCode === null) { rest.kill(); await once(rest,"exit"); }
  await pool.end(); vi.unstubAllEnvs();
});
const payload = (overrides = {}) => ({ order_id: randomUUID(), store_id: "store-test", webhook_event_type: "order_approved", order_status: "paid", Product: { product_id: "product-test" }, Customer: { full_name: "Synthetic", mobile: "+12025550140" }, ...overrides });
async function send(p: ReturnType<typeof payload>, signature?: string) {
  const sig = signature ?? createHmac("sha1",secret).update(JSON.stringify(p)).digest("hex");
  const r = await fetch(`${endpoint}?signature=${sig}`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(p)});
  return { status: r.status, body: await r.json() };
}
it("HTTP assinado: oito concorrentes + retry → exatamente um lead/evento", async () => {
  const p = payload(); const results = await Promise.all(Array.from({length:8},()=>send(p)));
  expect(results.map(r=>r.status)).toEqual(Array(8).fill(200));
  expect(results.filter(r=>r.body.data.status === "accepted")).toHaveLength(1);
  expect(results.filter(r=>r.body.data.status === "duplicate")).toHaveLength(7);
  expect((await send(p)).body.data.status).toBe("duplicate");
  const row = (await pool.query("select id,lead_id,event_id from kiwify_receipts where order_id=$1",[p.order_id])).rows;
  expect(row).toHaveLength(1); expect(row[0].event_id).not.toBeNull();
  expect((await pool.query("select count(*)::int n from event_log where entity_id=$1 and event_type='lead.created'",[row[0].lead_id])).rows[0].n).toBe(1);
  expect((await pool.query("select count(*)::int n from webhook_lead_captures where lead_id=$1",[row[0].lead_id])).rows[0].n).toBe(1);
});
it("HTTP assinatura inválida não persiste receipt nem lead", async () => {
  const p = payload(); expect((await send(p,"0".repeat(40))).status).toBe(401);
  expect((await pool.query("select count(*)::int n from kiwify_receipts where order_id=$1",[p.order_id])).rows[0].n).toBe(0);
});
it.each([['pix_created','waiting_payment'],['order_refunded','refunded'],['order_approved','waiting_payment']])("HTTP %s/%s: ignored sem lead/evento", async (event,status) => {
  const p = payload({webhook_event_type:event,order_status:status}); const r = await send(p);
  expect(r.status).toBe(200); expect(r.body.data.status).toBe("ignored");
  expect((await pool.query("select lead_id,event_id from kiwify_receipts where order_id=$1",[p.order_id])).rows[0]).toEqual({lead_id:null,event_id:null});
});
