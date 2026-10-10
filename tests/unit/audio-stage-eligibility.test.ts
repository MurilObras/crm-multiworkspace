// @vitest-environment node
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { outboundPostgres, ORG, CONTACT } from '../helpers/outbound-postgres';
import { eligibleAudiosForContact } from '@/lib/agent-engine/agent/audio-stage-eligibility';
import { readApprovedAudios } from '@/lib/ai/agents/approved-audios';

const PIPELINE = '10000000-0000-4000-8000-000000000071';
const STAGE = '10000000-0000-4000-8000-000000000072';
const OTHER = '10000000-0000-4000-8000-000000000073';
const LEAD = '10000000-0000-4000-8000-000000000074';
let db: Awaited<ReturnType<typeof outboundPostgres>>;
const audios = readApprovedAudios({ approved_audios: [[], [STAGE]].map((stage_ids, i) => ({
  id: `10000000-0000-4000-8000-00000000008${i}`, title: 'Orientação', use_when: 'Quando pedir orientação sobre o serviço',
  storage_path: 'private', mime: 'audio/ogg', size_bytes: 10, enabled: true, stage_ids,
})) });
beforeAll(async () => { db = await outboundPostgres(); }, 60_000);
afterAll(async () => db.close());
beforeEach(async () => {
  await db.seed();
  await db.pool.query('insert into crm_pipelines(id,organization_id) values($1,$2)', [PIPELINE, ORG]);
  await db.pool.query('insert into crm_stages(id,organization_id,pipeline_id) values($1,$2,$3),($4,$2,$3)', [STAGE, ORG, PIPELINE, OTHER]);
  await db.pool.query("insert into crm_leads(id,organization_id,contact_id,pipeline_id,stage_id,status,created_at) values($1,$2,$3,$4,$5,'open','2026-01-01')", [LEAD, ORG, CONTACT, PIPELINE, STAGE]);
});
it('libera áudio da etapa e mantém o genérico; mudar de etapa retira só o vinculado', async () => {
  expect(await eligibleAudiosForContact(db.pool, ORG, CONTACT, audios)).toHaveLength(2);
  await db.pool.query('update crm_leads set stage_id=$1', [OTHER]);
  expect(await eligibleAudiosForContact(db.pool, ORG, CONTACT, audios)).toEqual([audios[0]]);
});
it.each(['no_contact', 'no_lead', 'other_org', 'archived_stage', 'archived_pipeline', 'ambiguous'])('não libera vínculo com %s', async reason => {
  if (reason === 'no_lead') await db.pool.query('delete from crm_leads');
  if (reason === 'other_org') await db.pool.query('update crm_leads set organization_id=$1', [OTHER]);
  if (reason === 'archived_stage') await db.pool.query('update crm_stages set is_archived=true');
  if (reason === 'archived_pipeline') await db.pool.query('update crm_pipelines set is_archived=true');
  if (reason === 'ambiguous') await db.pool.query("insert into crm_leads(id,organization_id,contact_id,pipeline_id,stage_id,status,created_at) values($1,$2,$3,$4,$5,'open','2026-01-01')", [OTHER, ORG, CONTACT, PIPELINE, STAGE]);
  expect(await eligibleAudiosForContact(db.pool, ORG, reason === 'no_contact' ? null : CONTACT, audios)).toEqual([audios[0]]);
});
it('etapa de negócio ganho também é elegível quando é a última demanda sem aberto', async () => {
  await db.pool.query("update crm_leads set status='won'");
  expect(await eligibleAudiosForContact(db.pool, ORG, CONTACT, audios)).toHaveLength(2);
});
it('não usa negócio antigo no lugar do atual cuja etapa foi arquivada', async () => {
  await db.pool.query('update crm_stages set is_archived=true where id=$1', [OTHER]);
  await db.pool.query("insert into crm_leads(id,organization_id,contact_id,pipeline_id,stage_id,status,created_at) values($1,$2,$3,$4,$5,'open','2026-02-01')", [OTHER, ORG, CONTACT, PIPELINE, OTHER]);
  expect(await eligibleAudiosForContact(db.pool, ORG, CONTACT, audios)).toEqual([audios[0]]);
});
