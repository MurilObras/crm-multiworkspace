import { expect, it, vi } from 'vitest';
import { measureTurnPhase, queueAttemptTiming } from './turn-timing';
import type { JobRow } from '../queue/queue';

const job = { organization_id: 'workspace', id: 'job', attempts: 2, run_after: new Date(100), created_at: new Date(20), payload: { secret: 'never-log' } } as unknown as JobRow;
it('separa idade do job de espera elegível da tentativa; nunca chama isso de debounce', () => {
  expect(queueAttemptTiming(job, 150)).toEqual({ organization_id: 'workspace', job_id: 'job', attempt: 2, eligible_wait_ms: 50, job_age_ms: 130 });
  expect(queueAttemptTiming(job, 50).eligible_wait_ms).toBe(0);
});
it('mede sucesso e falha, marca inclusão de ferramentas e não registra conteúdo', async () => {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  expect(await measureTurnPhase(log, job, 'conversation', async () => 42)).toBe(42);
  await expect(measureTurnPhase(log, job, 'checkpoint', async () => { throw Error('conteúdo secreto'); })).rejects.toThrow();
  expect(log.info.mock.calls[0]?.[1]).toMatchObject({ phase: 'conversation', includes_tools: true, outcome: 'ok', attempt: 2 });
  expect(log.info.mock.calls[1]?.[1]).toMatchObject({ phase: 'checkpoint', includes_tools: false, outcome: 'error' });
  expect(JSON.stringify(log.info.mock.calls)).not.toMatch(/secret|conteúdo/);
});
