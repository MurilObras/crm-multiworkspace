import {describe,it,expect} from 'vitest';
import {replyDeadline,readReplyDelay,replyDelaySchema} from './reply-delay';
describe('tempo mínimo total',()=>{
 it('permanece desligado para agentes anteriores',()=>{expect(replyDeadline(new Date(),readReplyDelay({}))).toBeNull();});
 it('escolhe o piso entre 20 e 30 desde a inbound, não desde o fim do modelo',()=>{
 const anchor=new Date('2026-10-26T10:00:00Z'),cfg={enabled:true,min_seconds:20,max_seconds:30};
 expect(replyDeadline(anchor,cfg,()=>0)?.toISOString()).toBe('2026-10-26T10:00:20.000Z');
 expect(replyDeadline(anchor,cfg,()=>0.999)?.toISOString()).toBe('2026-10-26T10:00:30.000Z');
 const deadline=replyDeadline(anchor,cfg,()=>0)!;
 expect(Math.max(0,deadline.getTime()-(anchor.getTime()+40000))).toBe(0);
 });
 it('recusa intervalo invertido, números fracionados e valores fora do limite',()=>{
 for(const cfg of [{enabled:true,min_seconds:30,max_seconds:20},{enabled:true,min_seconds:0.5,max_seconds:30},{enabled:true,min_seconds:20,max_seconds:601}])expect(replyDelaySchema.safeParse(cfg).success).toBe(false);
 });
});
