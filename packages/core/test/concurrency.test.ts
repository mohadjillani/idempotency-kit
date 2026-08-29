import { describe, expect, it } from 'vitest';
import { createIdempotency, MemoryStore } from '@mohadjillani/idempotency-kit';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function counted(delayMs: number) {
  let executions = 0;
  return {
    execute: async () => {
      executions += 1;
      await sleep(delayMs);
      return `charge-${String(executions)}`;
    },
    get executions() {
      return executions;
    },
  };
}

describe('concurrent same-key calls', () => {
  it('executes exactly once and rejects the rest with onConflict: reject', async () => {
    const idem = createIdempotency<string>({ store: new MemoryStore({ sweepIntervalMs: 0 }) });
    const handler = counted(30);
    const outcomes = await Promise.all(
      Array.from({ length: 50 }, () => idem.handle('same-key', 'fp', handler.execute)),
    );
    expect(handler.executions).toBe(1);
    expect(outcomes.filter((o) => o.outcome === 'executed')).toHaveLength(1);
    expect(outcomes.filter((o) => o.outcome === 'in-flight')).toHaveLength(49);
  });

  it('executes exactly once and replays the rest with onConflict: wait', async () => {
    const idem = createIdempotency<string>({
      store: new MemoryStore({ sweepIntervalMs: 0 }),
      onConflict: 'wait',
      wait: { pollIntervalMs: 5 },
    });
    const handler = counted(30);
    const outcomes = await Promise.all(
      Array.from({ length: 50 }, () => idem.handle('same-key', 'fp', handler.execute)),
    );
    expect(handler.executions).toBe(1);
    expect(outcomes.filter((o) => o.outcome === 'executed')).toHaveLength(1);
    const replays = outcomes.filter((o) => o.outcome === 'replayed');
    expect(replays).toHaveLength(49);
    for (const r of replays) expect(r.response).toBe('charge-1');
  });

  it('keeps distinct keys independent under load', async () => {
    const idem = createIdempotency<string>({ store: new MemoryStore({ sweepIntervalMs: 0 }) });
    const handler = counted(5);
    const outcomes = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        idem.handle(`key-${String(i % 10)}`, 'fp', handler.execute),
      ),
    );
    expect(handler.executions).toBe(10);
    expect(outcomes.filter((o) => o.outcome === 'executed')).toHaveLength(10);
    expect(outcomes.filter((o) => o.outcome === 'in-flight')).toHaveLength(40);
  });
});
