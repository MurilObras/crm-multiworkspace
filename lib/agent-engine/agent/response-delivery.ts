import type pg from 'pg';
import { z } from 'zod';
import { withJobLease, type JobRow } from '../queue/queue';

const followingSendSchema = z.object({body:z.string().max(100000),media:z.unknown().optional()}).strict();

// Conteúdo privado: a migration remove este snapshot quando o contato é anonimizado.
export const deliverySnapshotSchema = z.object({
 version: z.literal(1), responseKey: z.uuid(), agentId: z.uuid().nullable(), agentVersionId: z.uuid().nullable(),
 firstSeq: z.number().int().positive(), body: z.string().max(100000), media: z.unknown().optional(),
 following: z.array(followingSendSchema).max(25).default([]),
 approvedBody: z.string().max(100000).optional(), bubbles: z.array(z.string().max(100000)).max(25), approved: z.boolean(), waitUntil: z.iso.datetime().nullable(),
}).strict().superRefine((value,ctx)=>{
 if(value.approved && (!value.approvedBody || value.bubbles.length===0))
  ctx.addIssue({code:'custom',message:'Plano aprovado exige corpo e partes persistidos.'});
 if(!value.approved && value.bubbles.length!==0)
  ctx.addIssue({code:'custom',message:'Plano ainda não aprovado não pode conter partes liberadas.'});
});
export type DeliverySnapshot = z.input<typeof deliverySnapshotSchema>;
export type FollowingSend = z.infer<typeof followingSendSchema>;
export function readDelivery(job: JobRow): DeliverySnapshot | null {
 if (!Object.hasOwn(job.payload,'response_delivery')) return null;
 const parsed=deliverySnapshotSchema.safeParse(job.payload.response_delivery);
 if (!parsed.success) throw new Error('response_delivery_invalid');
 return parsed.data;
}
export async function saveDelivery(pool: pg.Pool, job: JobRow, worker: string, value: DeliverySnapshot) {
 const checked=deliverySnapshotSchema.parse(value);
 await withJobLease(pool,job.id,worker,job.organization_id,async tx=>{
  const {rows}=await tx.query("update job_queue set payload=jsonb_set(payload,'{response_delivery}',$4::jsonb) where id=$1 and organization_id=$2 and contact_id=$3 and exists(select 1 from contacts c where c.organization_id=$2 and c.id=$3 and not c.is_anonymized) returning id",
    [job.id,job.organization_id,job.contact_id,JSON.stringify(checked)]);
  if(!rows.length)throw new Error('response_contact_unavailable');
 });
 job.payload.response_delivery=checked;
}
export class ReplyDelayPending extends Error {
 readonly until:Date;
 constructor(until:Date){super('reply_minimum_wait');this.name='ReplyDelayPending';this.until=until;}
}
