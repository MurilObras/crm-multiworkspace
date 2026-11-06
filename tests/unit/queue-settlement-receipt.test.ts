// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type pg from 'pg';
import { cancelJob, completeJob, rescheduleJob, withJobExecution, type Queryable } from '@/lib/agent-engine/queue/queue';

const db = (found: boolean) => ({ query: async () => ({ rows: found ? [{ id: 'job' }] : [], rowCount: found ? 1 : 0 }) }) as unknown as Queryable;

describe('recibo do próprio lease', () => {
  it('reagendamento confirmado se distingue de perda real do lease', async () => {
    const owned = db(true);
    await withJobExecution('job', 'owner', owned, async execution => {
      await rescheduleJob(owned, 'job', 'owner', { delayMs: 60000, reason: 'human_in_control' });
      expect(execution.settled).toBe('pending');
    });
    const lost = db(false);
    await withJobExecution('job', 'owner', lost, async execution => {
      expect(await rescheduleJob(lost, 'job', 'owner', { delayMs: 60000, reason: 'human_in_control' })).toBeNull();
      expect(execution.settled).toBeNull();
    });
  });
  it('não aceita transição de outro job, owner ou cliente transacional como recibo', async () => {
    const pool = db(true);
    await withJobExecution('job', 'owner', pool, async execution => {
      await cancelJob(pool, 'other-job', 'owner', 'cancelled');
      await cancelJob(pool, 'job', 'other-owner', 'cancelled');
      await cancelJob(db(true), 'job', 'owner', 'inside-uncommitted-transaction');
      expect(execution.settled).toBeNull();
      await cancelJob(pool, 'job', 'owner', 'cancelled');
      expect(execution.settled).toBe('failed');
    });
  });
  it('commit que falha não produz recibo de conclusão', async () => {
    const client = { query: async (q: string) => {
      if (q === 'commit') throw new Error('connection-lost');
      return { rows: [], rowCount: 1 };
    }, release: () => {} };
    const pool = { connect: async () => client } as unknown as pg.Pool;
    await withJobExecution('job', 'owner', pool, async execution => {
      await expect(completeJob(pool, 'job', 'owner')).rejects.toThrow('connection-lost');
      expect(execution.settled).toBeNull();
    });
  });
});
