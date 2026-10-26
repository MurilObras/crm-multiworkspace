import { ApiError } from '@/lib/api/types';
import { automaticRecipientReason, type currentAutomaticRecipient } from './current-recipient';
import type { Queryable } from '@/lib/agent-engine/queue/queue';
export interface AutomaticPreflight {
 current: Awaited<ReturnType<typeof currentAutomaticRecipient>>;
 latest: {contact_id:string;channel_session_id:string;last_inbound_at:string|null;bot_silenced_until:string|null;assignee_kind:string|null;status:string};
 channel: {status:string;archived_at:string|null};
 waiting: boolean;
}
/** Uma leitura consistente para o worker; as travas finais continuam no CAS de transporte. */
export async function automaticPreflight(db: Queryable, org:string, contact:string, conversation:string, session:string):Promise<AutomaticPreflight> {
 let rows:AutomaticPreflight[];
 try { ({rows}=await db.query<AutomaticPreflight>(
  `select jsonb_build_object('id',c.id,'phone_number',c.phone_number,'wa_identity',c.wa_identity,'wa_lid',c.wa_lid,
      'is_blocked',c.is_blocked,'is_anonymized',c.is_anonymized,'force_human',c.force_human,'consent',c.consent) as "current",
     jsonb_build_object('contact_id',v.contact_id,'channel_session_id',v.channel_session_id,'last_inbound_at',v.last_inbound_at,
      'bot_silenced_until',v.bot_silenced_until,'assignee_kind',v.assignee_kind,'status',v.status) as latest,
     jsonb_build_object('status',s.status,'archived_at',s.archived_at) as channel,
     public.fn_responsible_waiting($1,$2) as waiting
    from contacts c join conversations v on v.contact_id=c.id and v.organization_id=c.organization_id
    join channel_sessions s on s.id=v.channel_session_id and s.organization_id=v.organization_id
    where c.organization_id=$1 and c.id=$2 and v.id=$3 and s.id=$4`,[org,contact,conversation,session])); }
 catch {throw new ApiError(503,'internal_error',undefined,'automation','automation_preflight_unavailable');}
 const row=rows[0];if(!row)throw new ApiError(403,'forbidden',undefined,'automation','recipient_changed');
 const reason=automaticRecipientReason(row.current);if(reason)throw new ApiError(403,'forbidden',undefined,'automation',reason);
 return row;
}
