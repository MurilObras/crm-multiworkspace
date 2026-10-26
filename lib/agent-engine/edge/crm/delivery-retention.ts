import type pg from 'pg';
import {logger} from '@/lib/logger';
import type {Queryable} from '../../queue/queue';
import type {SendMessageInput} from './send-message';
import {emitVetoActivity} from '@/lib/leads/veto-activity';
/** Falha de entrega também precisa aparecer no Inbox, mesmo se os gates passaram. */
export async function recordDeliveryRetention(db:Queryable,input:SendMessageInput){
 if(!input.responseKey)return;
 try{
 const {rows}=await db.query<{id:string;code:string}>(
  `with affected as (
   select m.channel_session_id,case when m.status='sending' or m.metadata->'outbound_attempt'->>'phase' in('started','uncertain')
     then 'outbound_delivery_uncertain' else coalesce(m.error_code,'outbound_pending') end code
   from messages m join send_ledger l on l.organization_id=m.organization_id and l.crm_message_id=m.id and l.contact_id=m.contact_id
   where m.organization_id=$1 and m.contact_id=$2 and m.conversation_id=$3 and l.job_id=$4 and l.seq=$5
     and m.metadata->>'response_key'=$6::text
  ) insert into before_send_traces(organization_id,contact_id,conversation_id,channel_session_id,job_id,response_key,trace,vetoed_gate,vetoed_code)
   select $1,$2,$3,channel_session_id,$4,$6::uuid,'[]'::jsonb,'delivery',code from affected returning id,vetoed_code code`,
   [input.tenantId,input.leadId,input.conversationId,input.jobId,input.seq,input.responseKey]);
 for(const row of rows)await emitVetoActivity({pool:db as pg.Pool,organizationId:input.tenantId,contactId:input.leadId!,traceId:row.id,gate:'delivery',code:row.code});
 }catch(error){const code=(error as {code?:unknown})?.code;logger.warn('delivery_retention_unavailable',{job_id:input.jobId,...(typeof code==='string'&&/^[0-9A-Z]{5}$/.test(code)?{error_code:code}:{})});}
}
