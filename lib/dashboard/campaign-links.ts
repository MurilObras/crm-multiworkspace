import { z } from 'zod';

export const campaignLinkSchema=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('whatsapp'),account_id:z.string().regex(/^act_\d+$/),campaign_id:z.string().regex(/^\d+$/),
    phone:z.string().regex(/^[1-9]\d{7,14}$/),message:z.string().trim().min(1).max(500)}).strict(),
  z.object({kind:z.literal('website'),account_id:z.string().regex(/^act_\d+$/),campaign_id:z.string().regex(/^\d+$/),url:z.url().max(1800)}).strict(),
]);
export function campaignDestination(input:z.infer<typeof campaignLinkSchema>,code:string):string {
  const url=input.kind==='whatsapp'?new URL(`https://wa.me/${input.phone}`):new URL(input.url);
  if(url.protocol!=='https:'||url.username||url.password||url.port&&url.port!=='443')throw new Error('invalid_destination');
  if(input.kind==='whatsapp')url.searchParams.set('text',`${input.message} [ref:${code}]`);
  else url.searchParams.set('crm_ref',code);
  return url.toString();
}
