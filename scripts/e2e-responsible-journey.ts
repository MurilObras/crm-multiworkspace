/** Driver só para banco/Supabase LOCAIS. Transporte HTTP real para receiver local,
 * sem mensagens a pessoas e sem chamadas de modelo. Chamado pelo Playwright. */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import pg from "pg";
import { createClient } from "@supabase/supabase-js";
import { openCase } from "@/lib/agent-engine/agent/human-cases";
import { createResponsibleReplyHandler } from "@/lib/responsibles/reply";
import { createResponsibleDeliveryHandler, ResponsibleJobSettledError } from "@/lib/responsibles/delivery";
import { claimJobs, completeJob } from "@/lib/agent-engine/queue/queue";
import { dispatchWahaEvent } from "@/lib/waha/ingest";
import { persistMessageMedia } from "@/workers/media-persist-worker";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { performHumanHandoff } from "@/lib/agent-engine/agent/human-handoff";
import { createLogger } from "@/lib/agent-engine/obs/logger";

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const dbUrl = process.env.SUPABASE_DB_URL ?? "";
  for (const raw of [url, dbUrl]) if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(raw).hostname)) throw new Error("Somente ambiente local isolado.");
  const pool = new pg.Pool({ connectionString: dbUrl, max: 4 });
  const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const [mode, serialized] = process.argv.slice(2);
  const input = JSON.parse(serialized ?? "{}");
  const voice = readFileSync("tests/fixtures/responsible-voice.wav");
  const captures: { type: string; body?: string; sha256?: string }[] = [];
  const receiver = createServer(async (req, res) => {
    try {
      if (req.url === "/voice.wav") { res.writeHead(200, { "Content-Type": "audio/wav" }); res.end(voice); return; }
      const chunks: Buffer[] = []; for await (const c of req) chunks.push(Buffer.from(c));
      const raw = Buffer.concat(chunks).toString(); const body = raw ? JSON.parse(raw) : {};
      res.setHeader("Content-Type", "application/json");
      if (req.url?.includes("check-exists")) {
        const phone = new URL(req.url, "http://localhost").searchParams.get("phone") ?? "5511999999900";
        res.end(JSON.stringify({ numberExists: true, chatId: `${phone.replace(/\D/g, "")}@c.us` })); return;
      }
      const type = req.url?.includes("sendVoice") ? "audio" : "text";
      if (body.file?.url) {
        const media = await fetch(body.file.url); if (!media.ok) throw new Error("Receiver não conseguiu baixar a mídia assinada.");
        captures.push({ type, sha256: createHash("sha256").update(Buffer.from(await media.arrayBuffer())).digest("hex") });
      } else if (req.url?.includes("sendText")) captures.push({ type, body: body.text });
      if (input.fail_transport && req.url?.includes("sendText")) { res.statusCode = 500; res.end('{"error":"synthetic_failure"}'); return; }
      res.end(JSON.stringify({ id: { _serialized: `true_${body.chatId ?? "synthetic@c.us"}_${randomUUID().replaceAll("-", "")}` } }));
    } catch { res.statusCode = 500; res.end('{"error":"receiver_failed"}'); }
  });
  await new Promise<void>(resolve => receiver.listen(0, "127.0.0.1", resolve));
  const address = receiver.address(); if (!address || typeof address === "string") throw new Error("Receiver sem porta.");
  process.env.WAHA_API_BASE_URL = `http://127.0.0.1:${address.port}`; process.env.WAHA_API_KEY = "synthetic-test-key";
  let result: Record<string, unknown> = {};
  try {
    if (mode === "cleanup") {
      const fixtures=input.fixtures as {agent:string;session:string}[];
      if(!Array.isArray(fixtures) || !fixtures.length) throw new Error("Sem fixtures para limpar.");
      const ids=fixtures.map(f=>f.agent),sessions=fixtures.map(f=>f.session),org=String(input.org);
      const db=await pool.connect();
      try {
        await db.query("begin");
        const owned=await db.query(`select a.id from ai_agents a where a.organization_id=$1 and a.id=any($2::uuid[])
          and a.name='Agente de consulta sintético '||a.id::text`,[org,ids]);
        const channels=await db.query("select id from channel_sessions where organization_id=$1 and id=any($2::uuid[]) and waha_session_name='responsible-'||id::text",[org,sessions]);
        if(owned.rows.length!==ids.length || channels.rows.length!==sessions.length) throw new Error("Cleanup recusou fixture não sintética.");
        const contacts=(await db.query("select distinct contact_id as id from conversations where organization_id=$1 and channel_session_id=any($2::uuid[])",[org,sessions])).rows.map(r=>r.id);
        const names=ids.map(id=>`Responsável sintético ${id.slice(0,8)}`);
        await db.query(`delete from job_queue where organization_id=$1 and (id in (
          select d.job_id from agent_responsible_deliveries d join agent_responsible_requests r on r.organization_id=d.organization_id and r.id=d.request_id
          where r.organization_id=$1 and r.agent_id=any($2::uuid[])) or (kind='responsible_reply' and source_event_id in (
          select id from messages where organization_id=$1 and channel_session_id=any($3::uuid[]))))`,[org,ids,sessions]);
        await db.query("delete from agent_cases where organization_id=$1 and agent_id=any($2::uuid[])",[org,ids]);
        await db.query("delete from conversations where organization_id=$1 and channel_session_id=any($2::uuid[])",[org,sessions]);
        await db.query("delete from agent_inbox_items where organization_id=$1 and ref_kind='contact' and ref_id=any($2::uuid[])",[org,contacts]);
        await db.query("update ai_agents set published_version_id=null where organization_id=$1 and id=any($2::uuid[])",[org,ids]);
        await db.query("delete from ai_agents where organization_id=$1 and id=any($2::uuid[])",[org,ids]);
        await db.query("delete from channel_sessions where organization_id=$1 and id=any($2::uuid[])",[org,sessions]);
        await db.query(`delete from agent_responsibles r where organization_id=$1 and name=any($2::text[])
          and not exists(select 1 from agent_responsible_bindings b where b.organization_id=r.organization_id and b.responsible_id=r.id)`,[org,names]);
        await db.query(`delete from contacts c where organization_id=$1 and id=any($2::uuid[])
          and not exists(select 1 from conversations v where v.organization_id=c.organization_id and v.contact_id=c.id)`,[org,contacts]);
        await db.query("commit"); result={cleaned:true};
      } catch(error) { await db.query("rollback"); throw error; } finally { db.release(); }
    } else if (mode === "init") {
      const org = String(input.org); const session = randomUUID(); const agent = randomUUID(); const version = randomUUID();
      const db=await pool.connect();
      try {
        // As duas jornadas coexistem no mesmo workspace. O nome também é único
        // e uma falha de preparação não deixa um canal órfão nos próximos specs.
        await db.query("begin");
        await db.query("insert into channel_sessions(id,organization_id,waha_session_name,status,webhook_secret_encrypted) values($1,$2,$3,'WORKING','\\x00')", [session, org, `responsible-${session}`]);
        await db.query("insert into ai_agents(id,organization_id,name,system_prompt,kind) values($1,$2,$3,'Atenda usando somente informações aprovadas.','mcp_agent')", [agent, org, `Agente de consulta sintético ${agent}`]);
        await db.query(`insert into ai_agent_versions(id,organization_id,agent_id,version_number,system_prompt,provider,model,channel_session_id,status)
          values($1,$2,$3,1,'Atenda usando somente informações aprovadas.','openai','gpt-4.1-mini',$4,'published')`, [version, org, agent, session]);
        await db.query("update ai_agents set published_version_id=$3 where organization_id=$1 and id=$2", [org, agent, version]);
        const contact = (await db.query("insert into contacts(organization_id,name,phone_number) values($1,'Cliente comercial sintético',$2) returning id", [org, `+55119${String(Date.now()).slice(-8)}`])).rows[0]!.id;
        const conv = (await db.query("insert into conversations(organization_id,contact_id,channel_session_id,status) values($1,$2,$3,'ai_handling') returning id", [org, contact, session])).rows[0]!.id;
        await db.query("commit");
        result = { org, agent, session, contact, conv };
      } catch(error) { await db.query("rollback"); throw error; } finally { db.release(); }
    } else if (mode === "open") {
      if (input.handoff) {
        await performHumanHandoff(pool,{tenantId:input.org,leadId:input.contact,conversationId:input.conv},
          {reason:"requested_human",conversationSummary:"Cliente sintético pediu uma pessoa.",log:createLogger()});
        const request=(await pool.query("select id,case_id from agent_responsible_requests where organization_id=$1 and conversation_id=$2 order by created_at desc limit 1",[input.org,input.conv])).rows[0];
        result={request:request?.id,case_id:request?.case_id};
      } else {
        const opened = await openCase(pool, { tenantId: input.org, conversationId: input.conv, agentId: input.agent },
          { title: "Condição comercial para confirmar", summary: "Cliente sintético quer confirmar uma condição comercial.", blocker: "A condição está aprovada?" });
        if (!opened.ok) throw new Error(opened.error.code);
        result = { case_id: opened.caseId, request: (await pool.query("select id from agent_responsible_requests where organization_id=$1 and case_id=$2", [input.org, opened.caseId])).rows[0]?.id };
      }
    } else if (mode === "drive" || mode === "answer") {
      if (input.disconnected || input.reconnect) await pool.query("update channel_sessions set status=$3 where organization_id=$1 and id=$2",[input.org,input.session,input.disconnected ? "STOPPED" : "WORKING"]);
      if (input.reconnect) await pool.query(`update job_queue j set run_after=now() from agent_responsible_deliveries d
        where d.organization_id=$1 and d.request_id=$2 and j.organization_id=d.organization_id and j.id=d.job_id and j.status='pending'`,[input.org,input.request]);
      if (mode === "answer") {
        const notification = (await pool.query(`select d.*,m.external_id,c.phone_number from agent_responsible_deliveries d
          join messages m on m.organization_id=d.organization_id and m.id=d.message_id
          join contacts c on c.organization_id=d.organization_id and c.id=d.target_contact_id
          where d.organization_id=$1 and d.request_id=$2 and d.purpose='notification' order by d.created_at limit 1`, [input.org, input.request])).rows[0];
        if (!notification) throw new Error("Aviso ainda não enviado.");
        const external = input.external_id ?? randomUUID();
        const payload = { id: external, from: `${notification.phone_number.slice(1)}@c.us`, fromMe: false,
          type: input.audio ? "ptt" : "chat", body: input.audio ? "" : input.text,
          replyTo: { id: notification.external_id }, ...(input.audio ? { hasMedia: true, media: { url: `${process.env.WAHA_API_BASE_URL}/voice.wav`, mimetype: "audio/wav" } } : {}) };
        await dispatchWahaEvent(admin, { id: input.session, organization_id: input.org }, { event: "message", payload }, randomUUID());
        const source = (await pool.query("select id from messages where organization_id=$1 and external_id=$2", [input.org, external])).rows[0]?.id;
        if (!source) throw new Error("Resposta não ingerida.");
        if (input.audio) {
          const persisted = await persistMessageMedia({ id: randomUUID(), organization_id: input.org, event_type: "media.persist_requested",
            entity_kind: "message", entity_id: source, payload: { message_id: source }, metadata: {}, consumed_by: [], attempts: 0 });
          if (persisted.status !== "ok") throw new Error("Não persistiu o áudio sintético.");
        }
        result.source = source; result.external_id = external;
      }
      const worker = `responsible-proof:${randomUUID()}`;
      const replyHandler = createResponsibleReplyHandler(admin);
      const handler = createResponsibleDeliveryHandler({ crmCfg: { supabase: admin }, knobs: { queuedRetryDelayMs: 30_000 } });
      for (let round = 0; round < 12; round++) {
        const ids = (await pool.query("select job_id from agent_responsible_deliveries where organization_id=$1 and request_id=$2", [input.org, input.request])).rows.map(x => x.job_id as string);
        if (result.source) {
          const inbound = await pool.query("select id from job_queue where organization_id=$1 and kind='responsible_reply' and payload->>'message_id'=$2", [input.org,result.source]);
          ids.push(...inbound.rows.map(r=>r.id as string));
        }
        const jobs = await claimJobs(pool, { workerId: worker, maxConcurrency: 1000, batchSize: 4, jobIds: ids });
        if (!jobs.length) break;
        for (const job of jobs) {
          try { if (job.kind === "responsible_reply") await replyHandler(job,pool); else await handler(job, pool, { workerId: worker }); await completeJob(pool, job.id, worker); }
          catch(error) { if (!(error instanceof ResponsibleJobSettledError)) throw error; }
        }
      }
      result = { ...result, captures, voice_sha256: createHash("sha256").update(voice).digest("hex"),
        request_status: (await pool.query("select status from agent_responsible_requests where organization_id=$1 and id=$2", [input.org, input.request])).rows[0]?.status,
        deliveries: (await pool.query("select purpose,status from agent_responsible_deliveries where organization_id=$1 and request_id=$2", [input.org, input.request])).rows,
        automatic_paused: (await pool.query(`select (public.fn_responsible_waiting($1,c.id) or c.force_human or
          coalesce(v.assignee_kind='user',false) or coalesce(v.bot_silenced_until>now(),false)) as paused from contacts c join conversations v
          on v.organization_id=c.organization_id and v.contact_id=c.id where c.organization_id=$1 and c.id=$2 and v.id=$3`, [input.org, input.contact,input.conv])).rows[0]?.paused };
    } else throw new Error("Modo de prova inválido.");
    process.stdout.write(`RESULT:${JSON.stringify(result)}\n`);
  } finally {
    await pool.end(); await getRequestPool().end(); await new Promise<void>(resolve => receiver.close(() => resolve()));
  }
}
main().catch((error: unknown) => {
  // Só fixtures sintéticas. Não despejar env/client HTTP: as chaves do Supabase
  // local também não pertencem aos artefatos públicos da execução.
  const frames=error instanceof Error ? error.stack?.split("\n").slice(1,5).join("\n") ?? "" : "";
  const code=typeof error === "object" && error !== null && "code" in error ? String(error.code).slice(0,80) : "driver_failed";
  process.stderr.write(`Falha no driver isolado de consulta ao responsável (${code}).\n${frames}\n`);
  process.exitCode = 1;
});
