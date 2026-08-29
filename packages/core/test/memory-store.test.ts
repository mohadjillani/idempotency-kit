import { describe, expect, it } from 'vitest';
import { MemoryStore } from '@mohadjillani/idempotency-kit';

const ttl = { keyTtlMs: 1_000, lockTtlMs: 100 };

function clock(start = 0) {
  let t = start;
  return { now: () => t, tick: (ms: number) => (t += ms) };
}

describe('MemoryStore', () => {
  it('acquires, completes and replays', async () => {
    const store = new MemoryStore<string>({ sweepIntervalMs: 0 });
    const first = await store.acquire('k', 'fp', ttl);
    expect(first.status).toBe('acquired');
    expect(await store.complete('k', first.record.token, 'body')).toBe(true);
    const second = await store.acquire('k', 'fp', ttl);
    expect(second.status).toBe('completed');
    if (second.status === 'completed') expect(second.record.response).toBe('body');
  });

  it('mints a distinct token per acquire', async () => {
    const c = clock();
    const store = new MemoryStore({ now: c.now, sweepIntervalMs: 0 });
    const a = await store.acquire('k', 'fp', ttl);
    c.tick(ttl.lockTtlMs);
    const b = await store.acquire('k', 'fp', ttl);
    expect(b.status).toBe('acquired');
    expect(b.record.token).not.toBe(a.record.token);
  });

  it('release forgets the key so the next acquire re-executes', async () => {
    const store = new MemoryStore({ sweepIntervalMs: 0 });
    const a = await store.acquire('k', 'fp', ttl);
    expect(await store.release('k', a.record.token)).toBe(true);
    expect(await store.get('k')).toBeUndefined();
    expect((await store.acquire('k', 'fp', ttl)).status).toBe('acquired');
  });

  it('sweeps expired keys and reports size', async () => {
    const c = clock();
    const store = new MemoryStore({ now: c.now, sweepIntervalMs: 0 });
    await store.acquire('a', 'fp', ttl);
    await store.acquire('b', 'fp', ttl);
    expect(store.size).toBe(2);
    c.tick(ttl.keyTtlMs);
    expect(store.sweep()).toBe(2);
    expect(store.size).toBe(0);
  });

  it('expires lazily on get', async () => {
    const c = clock();
    const store = new MemoryStore({ now: c.now, sweepIntervalMs: 0 });
    await store.acquire('a', 'fp', ttl);
    c.tick(ttl.keyTtlMs);
    expect(await store.get('a')).toBeUndefined();
    expect(store.size).toBe(0);
  });

  it('runs the sweep timer without holding the process open', async () => {
    const c = clock();
    const store = new MemoryStore({ now: c.now, sweepIntervalMs: 5 });
    await store.acquire('a', 'fp', ttl);
    c.tick(ttl.keyTtlMs);
    await new Promise((r) => setTimeout(r, 20));
    expect(store.size).toBe(0);
    await store.close();
  });
});
