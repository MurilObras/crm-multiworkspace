import { z } from 'zod';
export const replyDelaySchema=z.object({enabled:z.boolean(),min_seconds:z.number().int().min(0).max(600),max_seconds:z.number().int().min(0).max(600)})
 .refine(v=>v.max_seconds>=v.min_seconds,{message:'O máximo deve ser maior ou igual ao mínimo.'});
export const REPLY_DELAY_DEFAULT={enabled:false,min_seconds:20,max_seconds:30};
export function readReplyDelay(config: unknown){const parsed=replyDelaySchema.safeParse((config as {reply_delay?:unknown}|null)?.reply_delay);return parsed.success?parsed.data:REPLY_DELAY_DEFAULT;}
export function replyDeadline(anchor: Date, cfg: ReturnType<typeof readReplyDelay>, rng= Math.random){
 if(!cfg.enabled)return null;
 const ms=(cfg.min_seconds+Math.floor(rng()*(cfg.max_seconds-cfg.min_seconds+1)))*1000;
 return new Date(anchor.getTime()+ms);
}
