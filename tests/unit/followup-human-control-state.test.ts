// @vitest-environment node
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import type pg from "pg";
import { pgComoSupabase } from "@/tests/pg-como-supabase";
import { pausarIaPorAtendimentoManual } from "@/lib/escalacao/atendimento-manual";
import { completeTurnForEnrollment, createPgAdminClient } from "@/lib/followup/turn-bridge";
import { createSupabaseSilenceSweepDb } from "@/lib/followup/silence-sweep";
import { runFollowupTick } from "@/lib/followup/engine";
import { followupJobGate } from "@/lib/agent-engine/edge/crm/followup-job-gate";

const ORG = "10000000-0000-4000-8000-000000000001";
const OTHER = "20000000-0000-4000-8000-000000000001";
const CONTACT = "10000000-0000-4000-8000-000000000002";
const CONV = "10000000-0000-4000-8000-000000000003";
const SESSION = "10000000-0000-4000-8000-000000000004";
const POINTER = "10000000-0000-4000-8000-000000000005";
const VERSION = "10000000-0000-4000-8000-000000000006";
const ENROLLMENT = "10000000-0000-4000-8000-000000000007";
const JOB = "10000000-0000-4000-8000-000000000008";
const sql = new PGlite();
const pool = { query: async (text: string, values?: unknown[]) => {
  const r = await sql.query(text, values);
  return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
} } as unknown as pg.Pool;
const db = createPgAdminClient(pool);
const admin = pgComoSupabase(pool);
const graph = { nodes: [
  { id: "action", type: "action", label: "Retorno", position: { x: 0, y: 0 }, config: { mode: "text", body: "Olá" } },
  { id: "end", type: "end", label: "Fim", position: { x: 0, y: 100 }, config: { outcome: "exhausted" } },
], edges: [{ id: "edge", source: "action", target: "end", priority: 0, condition: { type: "always" } }] };

beforeAll(async () => {
  // Esquema mínimo para executar as funções/requisições REAIS da migration.
  // O baseline completo, RLS e locks entre conexões são cobertos pelo test:db.
  await sql.exec(`
    create role anon; create role authenticated; create role service_role;
    create table contacts(id uuid primary key,organization_id uuid,tags text[] default '{}',
      is_blocked boolean default false,is_anonymized boolean default false,force_human boolean default false);
    create table channel_sessions(id uuid primary key,organization_id uuid,provider text);
    create table conversations(id uuid primary key,organization_id uuid,contact_id uuid,status text default 'open',
      last_inbound_at timestamptz,bot_silenced_until timestamptz,assignee_kind text,
      last_handoff_at timestamptz,last_handoff_reason text);
    create table followup_flow_versions(id uuid primary key,organization_id uuid,graph jsonb);
    create table followup_flow_pointers(id uuid primary key,organization_id uuid,active_version_id uuid,
      status text default 'active',trigger_config jsonb);
    create table followup_enrollments(id uuid primary key default gen_random_uuid(),organization_id uuid,
      pointer_id uuid,version_id uuid,contact_id uuid,conversation_id uuid,current_node_id text,status text default 'active',
      next_eval_at timestamptz,claimed_until timestamptz,attempts integer default 0,max_attempts integer default 5,
      last_error text,steps_taken integer default 0,outcome text,cancel_reason text,started_at timestamptz default now(),
      completed_at timestamptz,updated_at timestamptz default now(),timing_plan jsonb,agent_id uuid);
    create unique index one_live on followup_enrollments(organization_id,contact_id)
      where status in ('active','waiting_reply','paused_manual','paused_handoff');
    create table followup_enrollment_events(id uuid default gen_random_uuid(),organization_id uuid,enrollment_id uuid,
      node_id text,event_type text,payload jsonb default '{}',idempotency_key text,created_at timestamptz default now());
    create unique index event_key on followup_enrollment_events(enrollment_id,idempotency_key) where idempotency_key is not null;
    create table job_queue(id uuid primary key,organization_id uuid,contact_id uuid,kind text,payload jsonb,status text default 'running',locked_by text default 'owner',
      created_at timestamptz default now()-interval '1 hour');
    create table send_ledger(id uuid primary key default gen_random_uuid(),organization_id uuid,contact_id uuid,job_id uuid,
      status text default 'requested');
    create table messages(id uuid primary key default gen_random_uuid(),organization_id uuid,conversation_id uuid,
      channel_session_id uuid,contact_id uuid,type text default 'text',direction text,status text default 'sent',
      external_id text,sent_via text,metadata jsonb default '{}',body text,sent_at timestamptz default now(),
      created_at timestamptz default now(),unique(organization_id,external_id));
  `);
  for (const file of ["20261021160000_0234_followup_human_control.sql", "20261021160100_0235_waha_echo_identity.sql", "20261021200000_0236_followup_silence_resume.sql"])
    await sql.exec(readFileSync(`supabase/migrations/${file}`, "utf8"));
}, 30_000);
afterAll(() => sql.close());
beforeEach(async () => {
  await sql.exec("truncate contacts,channel_sessions,conversations,followup_flow_versions,followup_flow_pointers,followup_enrollments,followup_enrollment_events,job_queue,messages,send_ledger");
  await sql.query("insert into contacts(id,organization_id) values($1,$2)", [CONTACT, ORG]);
  await sql.query("insert into channel_sessions values($1,$2,'waha')", [SESSION, ORG]);
  await sql.query("insert into conversations(id,organization_id,contact_id,last_inbound_at) values($1,$2,$3,now()-interval '3 hours')", [CONV, ORG, CONTACT]);
  await sql.query("insert into followup_flow_versions values($1,$2,$3)", [VERSION, ORG, JSON.stringify(graph)]);
  await sql.query(`insert into followup_flow_pointers(id,organization_id,active_version_id,trigger_config) values($1,$2,$3,
    '{"kind":"silence","params":{"threshold_minutes":120},"cancel_on_reply":true}')`, [POINTER, ORG, VERSION]);
  await sql.query(`insert into followup_enrollments(id,organization_id,pointer_id,version_id,contact_id,conversation_id,
    current_node_id,next_eval_at,started_at) values($1,$2,$3,$4,$5,$6,'action',now()-interval '1 minute',now()-interval '1 day')`,
  [ENROLLMENT, ORG, POINTER, VERSION, CONTACT, CONV]);
  await sql.query("insert into job_queue(id,organization_id,contact_id,kind,payload) values($1,$2,$3,'followup_turn',$4)", [JOB, ORG, CONTACT,
    JSON.stringify({ followup_enrollment_id: ENROLLMENT, node_id: "action", node_epoch: 0 })]);
});
async function enrollment() {
  return (await sql.query<{ status: string; current_node_id: string; steps_taken: number }>("select * from followup_enrollments where id=$1", [ENROLLMENT])).rows[0]!;
}
async function message(direction = "inbound", extra: Record<string, unknown> = {}) {
  const data = { organization_id: ORG, conversation_id: CONV, channel_session_id: SESSION, contact_id: CONTACT,
    direction, ...extra };
  const cols = Object.keys(data);
  return (await sql.query<{ id: string }>(`insert into messages(${cols.join(",")}) values(${cols.map((_, i) => `$${i + 1}`).join(",")}) returning id`, Object.values(data))).rows[0]!.id;
}
async function live() {
  return (await sql.query<{ allowed: boolean }>("select fn_followup_job_live($1,$2,$3) as allowed", [ORG, JOB, CONTACT])).rows[0]!.allowed;
}

describe("cancelamento e barreira do trabalho antigo", () => {
  it.each(["active", "waiting_reply", "paused_handoff", "paused_manual"])("resposta cancela %s antes do drain", async (status) => {
    await sql.query("update followup_enrollments set status=$1", [status]);
    await message();
    expect((await enrollment()).status).toBe("cancelled");
    expect(await live()).toBe(false);
  });
  it("preserva o fluxo que foi configurado para consumir respostas", async () => {
    await sql.exec(`update followup_flow_pointers set trigger_config=jsonb_set(trigger_config,'{cancel_on_reply}','false')`);
    await message();
    expect((await enrollment()).status).toBe("active");
    expect(await live()).toBe(true);
  });
  it.each(["paused_manual", "paused_handoff", "cancelled", "completed", "dead"])("barreira recusa %s", async (status) => {
    expect(await live()).toBe(true);
    await sql.query("update followup_enrollments set status=$1", [status]);
    expect(await live()).toBe(false);
  });
  it("barreira recusa nó antigo e outra organização", async () => {
    await sql.exec("update followup_enrollments set current_node_id='outro'");
    expect(await live()).toBe(false);
    expect((await sql.query<{ ok: boolean }>("select fn_followup_job_live($1,$2,$3) as ok", [OTHER, JOB, CONTACT])).rows[0]!.ok).toBe(false);
  });
  it("voltar ao mesmo nome de nó não autoriza o job da passagem anterior", async () => {
    expect(await live()).toBe(true);
    await sql.exec("update followup_enrollments set current_node_id='outro'; update followup_enrollments set current_node_id='action'");
    expect(await live()).toBe(false);
  });
  it("pausa preserva a intenção e retomada respeita seu prazo, sem renovar a grace em cada recheck", async () => {
    await sql.exec("update followup_enrollments set status='paused_manual'");
    expect((await followupJobGate(pool, ORG, JOB, CONTACT)).retryAt).not.toBeNull();
    await sql.exec(`update followup_enrollments set status='active',next_eval_at=now()+interval '1 hour';
      insert into followup_enrollment_events(organization_id,enrollment_id,node_id,event_type,payload)
      select organization_id,id,current_node_id,'resumed_manual',jsonb_build_object('next_eval_at',now()+interval '30 minutes') from followup_enrollments`);
    expect((await followupJobGate(pool, ORG, JOB, CONTACT)).retryAt).not.toBeNull();
    await sql.exec(`update followup_enrollment_events set payload=jsonb_build_object('next_eval_at',now()-interval '1 minute')`);
    expect((await followupJobGate(pool, ORG, JOB, CONTACT)).retryAt).toBeNull();
  });
  it.each([60, -1])("última remarcação humana vence a anterior, inclusive depois de vencer (%s min)", async (minutes) => {
    const latest = new Date(Date.now() + minutes * 60_000).toISOString();
    const older = new Date(Date.now() + 7 * 86_400_000).toISOString();
    await sql.query("update followup_enrollments set next_eval_at=$1", [latest]);
    await sql.query(`insert into followup_enrollment_events(organization_id,enrollment_id,node_id,event_type,payload,created_at)
      values($1,$2,'action','snoozed_manual',$3,now()+interval '1 second'),
        ($1,$2,'action','snoozed_manual',$4,now()+interval '2 seconds')`,
    [ORG, ENROLLMENT, JSON.stringify({ next_eval_at: older }), JSON.stringify({ next_eval_at: latest })]);
    const gate = await followupJobGate(pool, ORG, JOB, CONTACT);
    expect(gate.retryAt?.toISOString() ?? null).toBe(minutes > 0 ? latest : null);
  });
});

describe("conclusão atômica sem desfazer a pausa", () => {
  it.each([60, -1])("conclusão em voo preserva a última remarcação sem herdar prazo antigo (%s min)", async (minutes) => {
    const now = new Date();
    const deadline = new Date(now.getTime() + minutes * 60_000).toISOString();
    const older = new Date(now.getTime() + 7 * 86_400_000).toISOString();
    await sql.query("update followup_enrollments set steps_taken=1,next_eval_at=$1", [deadline]);
    await sql.query(`insert into followup_enrollment_events(organization_id,enrollment_id,node_id,event_type,payload,idempotency_key,created_at)
      values($1,$2,'action','turn_enqueued','{}','action:0',now()-interval '3 seconds'),
        ($1,$2,'action','snoozed_manual',$3,null,now()-interval '2 seconds'),
        ($1,$2,'action','snoozed_manual',$4,null,now()-interval '1 second')`,
    [ORG, ENROLLMENT, JSON.stringify({ next_eval_at: older }), JSON.stringify({ next_eval_at: deadline })]);
    await completeTurnForEnrollment(db, ORG, ENROLLMENT, 'action', { kind: 'sent' }, () => now,
      { key: 'action:0', nodeEpoch: 0 });
    expect(await enrollment()).toMatchObject({ current_node_id: 'end', steps_taken: 2 });
    const { rows } = await sql.query<{ next_eval_at: Date }>('select next_eval_at from followup_enrollments where id=$1', [ENROLLMENT]);
    expect(rows[0]!.next_eval_at.toISOString()).toBe(minutes > 0 ? deadline : now.toISOString());
  });
  it("avança uma vez no controle positivo", async () => {
    await completeTurnForEnrollment(db, ORG, ENROLLMENT, "action", { kind: "sent" });
    await completeTurnForEnrollment(db, ORG, ENROLLMENT, "action", { kind: "sent" });
    expect(await enrollment()).toMatchObject({ current_node_id: "end", steps_taken: 1 });
    expect((await sql.query("select * from followup_enrollment_events")).rows).toHaveLength(1);
  });
  it("pausa entre a leitura e conclusão vence e conserva a prova do envio", async () => {
    const racing = { ...db, loadFlowGraph: async (org: string, version: string) => {
      await sql.exec("update followup_enrollments set status='paused_manual',next_eval_at=null,updated_at=clock_timestamp()");
      return db.loadFlowGraph(org, version);
    } };
    await completeTurnForEnrollment(racing, ORG, ENROLLMENT, "action", { kind: "sent" });
    expect(await enrollment()).toMatchObject({ status: "paused_manual", current_node_id: "action", steps_taken: 0 });
    expect((await sql.query<{ event_type: string }>("select event_type from followup_enrollment_events")).rows).toEqual([{ event_type: "action_sent" }]);
  });
  it("recheck concorrente não perde a prova física nem força avanço tardio", async () => {
    const snap = await db.loadEnrollmentById(ORG, ENROLLMENT);
    await sql.exec("update followup_enrollments set steps_taken=1,updated_at=clock_timestamp()");
    expect(await db.completeStep(snap!, { node_id: "action", event_type: "action_sent", payload: {}, idempotency_key: "action:0" },
      { current_node_id: "end", status: "active", steps_taken: 1 })).toBe(false);
    expect((await enrollment()).current_node_id).toBe("action");
    expect((await sql.query("select * from followup_enrollment_events where event_type='action_sent'")).rows).toHaveLength(1);
  });
  it("recheck que reservou a chave antes do UPDATE também conserva a confirmação", async () => {
    const snap = await db.loadEnrollmentById(ORG, ENROLLMENT);
    await db.insertEnrollmentEvent({ organization_id: ORG, enrollment_id: ENROLLMENT, node_id: "action",
      event_type: "action_recheck", payload: {}, idempotency_key: "action:0" });
    expect(await db.completeStep(snap!, { node_id: "action", event_type: "action_sent", payload: {}, idempotency_key: "action:0" },
      { current_node_id: "end", status: "active", steps_taken: 1 })).toBe(false);
    expect((await sql.query("select * from followup_enrollment_events where event_type='action_sent'")).rows).toHaveLength(1);
  });
});

describe("pausa manual atômica e relógio", () => {
  it("grava o prazo no controle positivo e isola a organização", async () => {
    const now = new Date();
    expect(await pausarIaPorAtendimentoManual(admin, { organizationId: ORG, conversationId: CONV, agora: now })).toBe(true);
    const result = await sql.query<{ until: string }>("select bot_silenced_until::text as until from conversations");
    expect(new Date(result.rows[0]!.until).getTime()).toBe(now.getTime() + 3_600_000);
    expect(await pausarIaPorAtendimentoManual(admin, { organizationId: OTHER, conversationId: CONV, agora: now })).toBe(false);
  });
  it("infinity gravado após a leitura não pode ser encurtado", async () => {
    let race = true;
    const racingPool = { query: async (text: string, values?: unknown[]) => {
      if (race && text.startsWith('update public."conversations"')) {
        race = false;
        await sql.exec("update conversations set bot_silenced_until='infinity',last_handoff_reason='Assumido pelo humano'");
      }
      return pool.query(text, values);
    } } as unknown as pg.Pool;
    expect(await pausarIaPorAtendimentoManual(pgComoSupabase(racingPool), { organizationId: ORG, conversationId: CONV })).toBe(false);
    expect((await sql.query<{ until: string; reason: string }>("select bot_silenced_until::text as until,last_handoff_reason as reason from conversations")).rows[0])
      .toEqual({ until: "infinity", reason: "Assumido pelo humano" });
  });
  it("o relógio do motor não consome rechecks durante atendimento humano", async () => {
    await sql.exec("update conversations set bot_silenced_until='infinity'");
    expect((await db.claimDueEnrollments(10, 60))).toHaveLength(0);
    await sql.exec("update conversations set bot_silenced_until=null");
    expect((await db.claimDueEnrollments(10, 60))).toHaveLength(1);
  });
});

describe("rearmamento por novo episódio silencioso", () => {
  const input = { organization_id: ORG, pointer_id: POINTER, version_id: VERSION, contact_id: CONTACT,
    current_node_id: "action", next_eval_at: new Date().toISOString(), agent_id: null };
  it("terminar não reinicia a mesma sequência na varredura seguinte", async () => {
    await sql.exec("update followup_enrollments set status='completed',completed_at=now()-interval '1 hour'");
    expect(await createSupabaseSilenceSweepDb(admin).insertEnrollment(input)).toEqual({ inserted: false });
  });
  it("uma sequência esgotada não ganha outro orçamento só porque voltou a conversar", async () => {
    await sql.exec("update followup_enrollments set status='completed',outcome='exhausted',completed_at=now()-interval '5 hours'");
    expect(await createSupabaseSilenceSweepDb(admin).insertEnrollment(input)).toEqual({ inserted: false });
  });
  it("primeira entrada segue automática e única", async () => {
    await sql.exec("delete from followup_enrollments");
    expect(await createSupabaseSilenceSweepDb(admin).insertEnrollment(input)).toEqual({ inserted: true });
    expect(await createSupabaseSilenceSweepDb(admin).insertEnrollment(input)).toEqual({ inserted: false });
  });
  async function reply(hours = 3) {
    const at = new Date(Date.now() - hours * 3_600_000).toISOString();
    await message("inbound", { sent_at: at });
    await sql.query("update conversations set last_inbound_at=$1", [at]);
    await sql.exec("update job_queue set status='done'");
    return at;
  }
  const resume = () => createSupabaseSilenceSweepDb(admin).insertEnrollment(input);
  it("a própria resposta que interrompeu libera continuação, sem outra mensagem/etiqueta", async () => {
    const at = await reply();
    expect((await enrollment()).status).toBe("cancelled");
    expect(await resume()).toEqual({ inserted: true });
    const row = await enrollment();
    expect(row).toMatchObject({ id: ENROLLMENT, status: "active", current_node_id: "action", steps_taken: 0, node_epoch: 1 });
    expect((await sql.query<{ at: Date }>("select silence_anchor_at as at from followup_enrollments")).rows[0]!.at.toISOString()).toBe(at);
    expect(await resume()).toEqual({ inserted: false });
    expect((await sql.query("select * from followup_enrollments")).rows).toHaveLength(1);
  });
  it("duas horas contam da resposta mais recente, não da primeira nem do encerramento", async () => {
    await reply();
    await reply(1);
    expect(await resume()).toEqual({ inserted: false });
  });
  it("conserva etapa, versão, histórico, contadores e um intervalo maior já previsto", async () => {
    const due = new Date(Date.now() + 7 * 3_600_000).toISOString();
    await sql.query("update followup_enrollments set steps_taken=17,attempts=2,next_eval_at=$1", [due]);
    await reply();
    expect(await resume()).toEqual({ inserted: true });
    expect(await enrollment()).toMatchObject({ steps_taken: 17, attempts: 2, version_id: VERSION });
    expect((await sql.query<{ due: Date }>("select next_eval_at as due from followup_enrollments")).rows[0]!.due.toISOString()).toBe(due);
    expect((await sql.query("select * from followup_enrollment_events")).rows).toHaveLength(2);
  });
  it("inscrição antiga recupera o prazo maior da timeline sem adiantar a mensagem", async () => {
    await reply();
    const due = new Date(Date.now()+8*3_600_000).toISOString();
    await sql.exec("update followup_enrollment_events set payload='{}',created_at=now()-interval '1 hour'; update followup_enrollments set completed_at=now()");
    await sql.query(`insert into followup_enrollment_events(organization_id,enrollment_id,node_id,event_type,payload,created_at)
      values($1,$2,'action','resumed_manual',$3,now()-interval '2 hours')`, [ORG,ENROLLMENT,JSON.stringify({ next_eval_at:due })]);
    expect(await resume()).toEqual({ inserted:true });
    expect((await sql.query<{ due:Date }>("select next_eval_at as due from followup_enrollments")).rows[0]!.due.toISOString()).toBe(due);
  });
  it("inscrição antiga conserva pausa humana registrada antes da correção", async () => {
    await reply();
    await sql.exec("update followup_enrollment_events set payload='{}',created_at=now()-interval '1 hour'; update followup_enrollments set completed_at=now()");
    await sql.query(`insert into followup_enrollment_events(organization_id,enrollment_id,node_id,event_type,created_at)
      values($1,$2,'action','paused_manual',now()-interval '2 hours')`, [ORG,ENROLLMENT]);
    expect(await resume()).toEqual({ inserted:false });
  });
  it("não desbloqueia jobs antigos ao reativar a mesma etapa", async () => {
    await reply();
    await resume();
    await sql.exec("update job_queue set status='running'");
    expect(await live()).toBe(false);
    await sql.exec("update job_queue set payload=jsonb_set(payload,'{node_epoch}','1')");
    expect(await live()).toBe(true);
  });
  it("job legado sem ocupação não recupera permissão na mesma etapa retomada", async () => {
    await reply(); await resume();
    await sql.exec("update job_queue set status='running',payload=payload-'node_epoch'");
    expect(await live()).toBe(false);
  });
  it("a reaplicação do saneamento anterior não cancela novamente a sequência retomada", async () => {
    await reply(); await resume();
    const baseline = readFileSync('supabase/baseline.sql','utf8');
    const start = baseline.indexOf('-- Corrige inscrições antigas que ignoraram uma resposta');
    const end = baseline.indexOf('-- Uma varredura por silêncio',start);
    expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
    await sql.exec(baseline.slice(start,end));
    expect((await enrollment()).status).toBe('active');
  });
  it("nova resposta interrompe também a continuação", async () => {
    await reply(); await resume();
    await message();
    expect((await enrollment()).status).toBe("cancelled");
    expect(await live()).toBe(false);
  });
  it.each(["paused_manual", "paused_handoff"])("resposta durante %s não cancela a decisão humana", async (status) => {
    await sql.query("update followup_enrollments set status=$1", [status]);
    await reply();
    expect(await resume()).toEqual({ inserted: false });
  });
  it.each(["is_blocked", "force_human", "is_anonymized"])("não continua com %s", async (flag) => {
    await reply();
    await sql.exec(`update contacts set ${flag}=true`);
    expect(await resume()).toEqual({ inserted: false });
  });
  it("atendente humano e conversa encerrada impedem a continuação", async () => {
    await reply();
    await sql.exec("update conversations set assignee_kind='user'");
    expect(await resume()).toEqual({ inserted: false });
    await sql.exec("update conversations set assignee_kind=null,status='closed'");
    expect(await resume()).toEqual({ inserted: false });
  });
  it("cancelamento humano não é interpretado como uma resposta", async () => {
    await sql.exec("update followup_enrollments set status='cancelled',outcome='replied',cancel_reason='cancelled_manual'");
    expect(await resume()).toEqual({ inserted: false });
  });
  it("fluxo desativado e segmento removido impedem retomada", async () => {
    await reply();
    await sql.exec("update followup_flow_pointers set status='disabled'");
    expect(await resume()).toEqual({ inserted: false });
    await sql.exec(`update followup_flow_pointers set status='active',trigger_config=jsonb_set(trigger_config,'{params,segments}','["comercial"]')`);
    expect(await resume()).toEqual({ inserted: false });
  });
  it("aguarda efeito em execução ou transporte incerto", async () => {
    await reply();
    await sql.exec("update job_queue set status='running'");
    expect(await resume()).toEqual({ inserted: false });
    await sql.exec("update job_queue set status='done'");
    const ledger = (await sql.query<{ id: string }>("insert into send_ledger(organization_id,contact_id,job_id,status) values($1,$2,$3,'failed') returning id", [ORG,CONTACT,JOB])).rows[0]!.id;
    await message("outbound", { status: "failed", metadata: { idempotency_key: ledger, outbound_attempt: { phase: "uncertain" } } });
    expect(await resume()).toEqual({ inserted: false });
  });
  it("callback confirmado depois da resposta conserva prova e não desfaz o cancelamento", async () => {
    await reply();
    await completeTurnForEnrollment(db, ORG, ENROLLMENT, 'action', { kind: 'sent' }, () => new Date(), { nodeEpoch: 0 });
    expect((await enrollment()).status).toBe('cancelled');
    expect((await sql.query("select * from followup_enrollment_events where event_type='action_sent'")).rows).toHaveLength(1);
    await resume();
    const enqueued: unknown[] = [];
    await runFollowupTick({ db: { ...db, loadLeadFacts: async () => ({ lead_stage: null, tags: [] }) },
      clock: () => new Date(), enqueueJob: async (job) => { enqueued.push(job); } });
    expect((await enrollment()).current_node_id).toBe('end');
    expect(enqueued).toHaveLength(0);
  });
  it("confirmação física sem callback também impede repetir a etapa", async () => {
    await reply();
    const ledger = (await sql.query<{ id:string }>("insert into send_ledger(organization_id,contact_id,job_id,status) values($1,$2,$3,'accepted') returning id", [ORG,CONTACT,JOB])).rows[0]!.id;
    await message("outbound", { status:"sent",external_id:"REAL-ACK",metadata:{ idempotency_key:ledger } });
    await resume();
    const enqueued:unknown[] = [];
    await runFollowupTick({ db:{ ...db,loadLeadFacts:async()=>({ lead_stage:null,tags:[] }) },clock:()=>new Date(),enqueueJob:async(job)=>{ enqueued.push(job); } });
    expect((await enrollment()).current_node_id).toBe("end");
    expect(enqueued).toHaveLength(0);
  });
  it("legado sem prova de transporte não autoriza refazer um envio", async () => {
    await reply();
    await sql.query("insert into send_ledger(organization_id,contact_id,job_id,status) values($1,$2,$3,'failed')", [ORG,CONTACT,JOB]);
    expect(await resume()).toEqual({ inserted:false });
  });
  it("retoma ação sem transporte com outra chave, preservando o histórico do job vetado", async () => {
    await sql.exec(`update followup_enrollments set steps_taken=1;
      insert into followup_enrollment_events(organization_id,enrollment_id,node_id,event_type,idempotency_key)
      select organization_id,id,current_node_id,'turn_enqueued','action:0' from followup_enrollments`);
    await reply(); await resume();
    const enqueued: Array<{ payload: { enrollment_action_key?: string; node_epoch?: number } }> = [];
    await runFollowupTick({ db: { ...db, loadLeadFacts: async () => ({ lead_stage: null, tags: [] }) },
      clock: () => new Date(), enqueueJob: async (job) => { enqueued.push(job); } });
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.payload).toMatchObject({ enrollment_action_key: 'action:1', node_epoch: 1 });
    expect((await enrollment()).steps_taken).toBe(2);
  });

});

describe("identidade confirmada do eco WAHA", () => {
  it("confirmação posterior arquiva o eco sem apagar a referência", async () => {
    const original = await message("outbound", { sent_via: "ai", external_id: null, status: "sending" });
    const echo = await message("outbound", { sent_via: "external_device", external_id: "true_chat@lid_TRANSPORT-ID" });
    await sql.query("update messages set external_id='TRANSPORT-ID',status='sent' where id=$1", [original]);
    const r = await sql.query<{ external_id: string | null; metadata: { reconciled_into_message_id?: string } }>("select external_id,metadata from messages where id=$1", [echo]);
    expect(r.rows[0]).toMatchObject({ external_id: null, metadata: { reconciled_into_message_id: original } });
    expect((await sql.query("select * from messages")).rows).toHaveLength(2);
  });
  it("confirmação anterior não aceita outro registro com o ID composto", async () => {
    await message("outbound", { sent_via: "ai", external_id: "TRANSPORT-ID" });
    await expect(message("outbound", { sent_via: "external_device", external_id: "true_chat@lid_TRANSPORT-ID" })).rejects.toMatchObject({ code: "23505" });
  });
  it("mensagem manual com o mesmo texto e outro ID permanece", async () => {
    await message("outbound", { sent_via: "ai", external_id: "FIRST-ID", body: "Olá" });
    const human = await message("outbound", { sent_via: "external_device", external_id: "true_chat@lid_OTHER-ID", body: "Olá" });
    expect((await sql.query<{ external_id: string }>("select external_id from messages where id=$1", [human])).rows[0]!.external_id).toBe("OTHER-ID");
  });
});
