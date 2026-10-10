import type { SupabaseClient } from '@supabase/supabase-js';
import type { AudioStageOption } from './approved-audios';

/** Uma lista serve a seleção e a validação; não aceitar IDs de outro workspace. */
export async function loadAudioStageOptions(db: SupabaseClient, org: string): Promise<AudioStageOption[]> {
  const [pipelines, stages] = await Promise.all([
    db.from('crm_pipelines').select('id,name').eq('organization_id', org).eq('is_archived', false).order('position'),
    db.from('crm_stages').select('id,name,pipeline_id').eq('organization_id', org).eq('is_archived', false).order('position'),
  ]);
  if (pipelines.error || stages.error) throw new Error('audio_stages_load_failed');
  return (pipelines.data ?? []).flatMap(p => (stages.data ?? [])
    .filter(s => s.pipeline_id === p.id)
    .map(s => ({ id: s.id, name: s.name, pipeline_id: p.id, pipeline_name: p.name })));
}
