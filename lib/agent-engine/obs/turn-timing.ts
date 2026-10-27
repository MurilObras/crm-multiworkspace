import { performance } from 'node:perf_hooks';
import type { Logger } from './logger';
import type { JobRow } from '../queue/queue';

export type TurnPhase = 'routing' | 'context' | 'stage_classifier' | 'jailbreak' | 'media_intent' | 'conversation' | 'checkpoint' | 'checkpoint_persist';

/** Paredes por fase/attempt; conversation INCLUI ferramentas e seus transportes. */
export async function measureTurnPhase<T>(log: Logger, job: JobRow, phase: TurnPhase, work: () => Promise<T>): Promise<T> {
  const started = performance.now();
  let outcome = 'error';
  try {
    const result = await work();
    outcome = 'ok';
    return result;
  } finally {
    log.info('turn_phase_timing', {
      organization_id: job.organization_id, job_id: job.id, attempt: job.attempts,
      phase, outcome, elapsed_ms: Math.round(performance.now() - started),
      includes_tools: phase === 'conversation',
    });
  }
}

/** run_after é desta tentativa: atrasos de retry não são debounce original. */
export function queueAttemptTiming(job: JobRow, now: number) {
  return {
    organization_id: job.organization_id, job_id: job.id, attempt: job.attempts,
    eligible_wait_ms: Math.max(0, now - new Date(job.run_after).getTime()),
    job_age_ms: Math.max(0, now - new Date(job.created_at).getTime()),
  };
}
