import { z } from 'zod';
import type { ApprovedAudio } from '@/lib/ai/agents/approved-audios';
import type { JobRow, Queryable } from '../queue/queue';
import { OutboundLeaseLostError } from '@/lib/channels/delivery-error';

const planSchema = z.object({ agent_id: z.string().uuid(), audio_id: z.string().uuid(), delivery_phase: z.literal('after_response').optional() }).strict();
export type RequiredAudioPlan = z.infer<typeof planSchema>;

/** O plano persiste ANTES da rede. Retry mantém as intenções 1 e 2, mesmo se
 * outra gravação se tornar elegível ou o operador desativar a anterior. */
export async function requiredAudioPlan(
  db: Queryable, job: JobRow, worker: string, agent: string, audios: ApprovedAudio[], maxSends: number,
  deliveryPhase?: 'after_response',
): Promise<RequiredAudioPlan | null> {
  if (job.kind !== 'inbound_turn') return null;
  const existing = job.payload.required_audio_plan === undefined ? null : planSchema.parse(job.payload.required_audio_plan);
  const candidate = audios.find(a => a.enabled && a.required);
  if (!existing && (!candidate || maxSends < 2)) return null;
  const plan = existing ?? { agent_id: agent, audio_id: candidate!.id, ...(deliveryPhase ? { delivery_phase: deliveryPhase } : {}) };
  const { rows } = await db.query<{ plan: unknown }>(
    `update job_queue set payload=coalesce(payload,'{}'::jsonb) || jsonb_build_object(
        'required_audio_plan',coalesce(payload->'required_audio_plan',$5::jsonb))
      where id=$1 and organization_id=$2 and contact_id is not distinct from $3
        and status='running' and locked_by=$4
      returning payload->'required_audio_plan' as plan`,
    [job.id, job.organization_id, job.contact_id, worker, JSON.stringify(plan)],
  );
  if (!rows[0]) throw new OutboundLeaseLostError();
  return planSchema.parse(rows[0].plan);
}

const sendResult = z.object({ ok: z.boolean(), status: z.string().optional() }).passthrough();
export async function deliverRequiredAudio(args: {
  plan: RequiredAudioPlan; agent: string; audios: ApprovedAudio[];
  invoke: (input: { body: string; media?: { type: 'audio'; audio_id: string } }) => Promise<unknown>;
  reserve: () => void;
  discard: () => Promise<void>;
  contextAlreadySent?: boolean;
}): Promise<unknown> {
  try {
    const audio = args.audios.find(a => a.id === args.plan.audio_id && a.enabled && a.required);
    if (args.plan.agent_id !== args.agent || !audio) {
      await args.discard();
      return { status: 'dispensado', reason: 'audio_no_longer_required_or_eligible' };
    }
    if (!args.contextAlreadySent) {
      const context = await args.invoke({ body: 'Vou te enviar uma breve orientação em áudio.' });
      const parsed = sendResult.safeParse(context);
      if (!parsed.success || !parsed.data.ok || parsed.data.status !== 'enviada') return { status: 'contexto_pendente', context };
    }
    const result = await args.invoke({ body: audio.title, media: { type: 'audio', audio_id: audio.id } });
    return { audio_id: audio.id, title: audio.title, content_description: audio.use_when, result };
  } finally {
    // Se a aprovação/etapa mudou, não reutilizar a seq de uma intenção antiga
    // para outro texto. Teto conservador; nunca libera mais mensagens físicas.
    args.reserve();
  }
}
