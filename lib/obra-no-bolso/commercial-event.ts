import { z } from 'zod';
import { normalizePhoneBR } from '@/lib/webhooks/inbound';
import { phoneLookupVariants } from '@/lib/channels/phone-variants';
const identity={version:z.literal(3),event_id:z.uuid(),product_user_id:z.uuid(),occurred_at:z.iso.datetime({offset:true}),
  user_created_at:z.iso.datetime({offset:true}),name:z.string().trim().min(1).max(200),email:z.email().max(254),
  phone:z.string().trim().min(1).max(40),crm_ref:z.string().regex(/^[a-f0-9]{24}$/).nullable(),has_trial:z.boolean()};
export const commercialEventSchema=z.discriminatedUnion('event_type',[
  z.object({...identity,event_type:z.literal('lead_registered')}).strict(),
  z.object({...identity,event_type:z.literal('first_payment_received'),payment_id:z.uuid(),amount_cents:z.number().int().positive().max(2_147_483_647),
    currency:z.string().regex(/^[A-Z]{3}$/),paid_at:z.iso.datetime({offset:true})}).strict(),
]);
export function validateCommercialEvent(input:unknown,now=Date.now()) {
  const p=commercialEventSchema.safeParse(input);
  if(!p.success)return {ok:false as const};
  const event=p.data;
  if(Date.parse(event.user_created_at)>Date.parse(event.occurred_at)||Date.parse(event.occurred_at)>now+300_000
    ||event.event_type==='first_payment_received'&&(Date.parse(event.paid_at)>Date.parse(event.occurred_at)||Date.parse(event.paid_at)<Date.parse(event.user_created_at)))return {ok:false as const};
  const phone=normalizePhoneBR(event.phone);
  if(!phone||!/^\+[1-9]\d{7,14}$/.test(phone))return {ok:false as const};
  return {ok:true as const,event:{...event,phone,email:event.email.toLowerCase()},phoneVariants:phoneLookupVariants(phone)};
}
