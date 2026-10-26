import {describe,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {readDelivery,deliverySnapshotSchema} from './response-delivery';
it('marcador corrompido falha fechado em vez de reconstruir o atendimento',()=>{
 expect(()=>readDelivery({payload:{response_delivery:{}}} as never)).toThrow('response_delivery_invalid');
 expect(readDelivery({payload:{}} as never)).toBeNull();
});
describe('plano fixo de envio',()=>{
 const base={version:1,responseKey:randomUUID(),agentId:null,agentVersionId:null,firstSeq:1,body:'A. B.',waitUntil:null};
 it('exige as partes aprovadas e o corpo de origem',()=>{
 expect(deliverySnapshotSchema.safeParse({...base,bubbles:[],approved:true}).success).toBe(false);
 expect(deliverySnapshotSchema.safeParse({...base,bubbles:['A.','B.'],approved:true,approvedBody:'A. B.'}).success).toBe(true);
 });
 it('um plano ainda não aprovado não libera partes para transporte',()=>{
 expect(deliverySnapshotSchema.safeParse({...base,bubbles:['A.'],approved:false}).success).toBe(false);
 });
});
