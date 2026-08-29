import { describe, expect, it, vi } from 'vitest';
import {
  createIdempotency,
  IdempotencyConfigError,
  MemoryStore,
} from '@mohadjillani/idempotency-kit';

function clock(start = 1_000) {
  let t = start;
  return { now: () => t, tick: (ms: number) => (t += ms) };
}

function setup(over: Partial<Parameters<typeof createIdempotency<string>>[0]> = {}) {
  const c = clock();
  const store = new MemoryStore<string>({ now: c.now, sweepIntervalMs: 0 });
  const idem = createIdempotency<string>({
    store,
    ttlMs: 10_000,
    lockTtlMs: 1_000,
    now: c.now,
    ...over,
  });
  return { c, store, idem };
}

describe('createIdempotency', () => {
  it('applies defaults', () => {
    const { options } = createIdempotency({ store: new MemoryStore({ sweepIntervalMs: 0 }) });
    expect(options.ttlMs).toBe(24 * 60 * 60 * 1000);
    expect(options.lockTtlMs).toBe(30_000);
    expect(options.onConflict).toBe('reject');
  });

  it('rejects a lock ttl that is not shorter than the key ttl', () => {
    const store = new MemoryStore({ sweepIntervalMs: 0 });
    expect(() => createIdempotency({ store, ttlMs: 1_000, lockTtlMs: 1_000 })).toThrow(
      IdempotencyConfigError,
    );
    expect(() => createIdempotency({ store, ttlMs: 0 })).toThrow(/ttlMs/);
    expect(() => createIdempotency({ store, lockTtlMs: -1 })).toThrow(/lockTtlMs/);
  });
});

describe('handle', () => {
  it('executes a fresh key and stores the response', async () => {
    const { idem, store } = setup();
    const execute = vi.fn(() => Promise.resolve('charged'));
    const out = await idem.handle('k', 'fp', execute);
    expect(out).toEqual({ outcome: 'executed', response: 'charged', stored: true });
    expect(execute).toHaveBeenCalledTimes(1);
    expect((await store.get('k'))?.status).toBe('completed');
  });

  it('replays a completed key without executing', async () => {
    const { idem } = setup();
    await idem.handle('k', 'fp', () => 'charged');
    const execute = vi.fn(() => 'again');
    const out = await idem.handle('k', 'fp', execute);
    expect(out).toMatchObject({ outcome: 'replayed', response: 'charged' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('reports a live in-flight key with a retry hint', async () => {
    const { idem, c } = setup();
    let finish!: (v: string) => void;
    const first = idem.handle('k', 'fp', () => new Promise<string>((r) => (finish = r)));
    c.tick(250);
    const second = await idem.handle('k', 'fp', () => 'never');
    expect(second).toMatchObject({ outcome: 'in-flight', retryAfterMs: 750 });
    finish('done');
    expect(await first).toMatchObject({ outcome: 'executed', response: 'done' });
  });

  it('reports a fingerprint mismatch for completed and in-flight keys', async () => {
    const { idem } = setup();
    let finish!: (v: string) => void;
    const first = idem.handle('k', 'fp-a', () => new Promise<string>((r) => (finish = r)));
    expect(await idem.handle('k', 'fp-b', () => 'x')).toMatchObject({ outcome: 'mismatch' });
    finish('done');
    await first;
    const out = await idem.handle('k', 'fp-b', () => 'x');
    expect(out).toMatchObject({ outcome: 'mismatch', record: { status: 'completed' } });
  });

  it('re-executes once the key ttl has passed', async () => {
    const { idem, c } = setup();
    await idem.handle('k', 'fp', () => 'one');
    c.tick(10_000);
    expect(await idem.handle('k', 'fp', () => 'two')).toMatchObject({
      outcome: 'executed',
      response: 'two',
    });
  });

  it('takes over an abandoned in-flight key after the lock ttl', async () => {
    const { idem, c } = setup();
    void idem.handle('k', 'fp', () => new Promise<string>(() => undefined));
    await Promise.resolve();
    c.tick(1_000);
    expect(await idem.handle('k', 'fp', () => 'second')).toMatchObject({
      outcome: 'executed',
      response: 'second',
    });
  });

  it('rejects an empty key', async () => {
    const { idem } = setup();
    await expect(idem.handle('', 'fp', () => 'x')).rejects.toThrow(TypeError);
  });
});

describe('handle with onConflict: wait', () => {
  it('waits for the owner and replays its response', async () => {
    const { idem } = setup({ onConflict: 'wait', wait: { pollIntervalMs: 5 } });
    let finish!: (v: string) => void;
    const first = idem.handle('k', 'fp', () => new Promise<string>((r) => (finish = r)));
    await Promise.resolve();
    const execute = vi.fn(() => 'never');
    const second = idem.handle('k', 'fp', execute);
    setTimeout(() => {
      finish('done');
    }, 20);
    expect(await second).toMatchObject({ outcome: 'replayed', response: 'done' });
    expect(await first).toMatchObject({ outcome: 'executed' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('gives up after the wait timeout and reports in-flight', async () => {
    const { idem } = setup({ onConflict: 'wait', wait: { timeoutMs: 30, pollIntervalMs: 5 } });
    void idem.handle('k', 'fp', () => new Promise<string>(() => undefined));
    await Promise.resolve();
    const acquire = vi.spyOn(idem.options.store, 'acquire');
    const out = await idem.handle('k', 'fp', () => 'never');
    expect(out.outcome).toBe('in-flight');
    expect(acquire.mock.calls.length).toBeGreaterThan(1);
  });

  it('takes over and executes when the owner abandons the key mid-wait', async () => {
    const { idem, c } = setup({ onConflict: 'wait', wait: { timeoutMs: 500, pollIntervalMs: 5 } });
    void idem.handle('k', 'fp', () => new Promise<string>(() => undefined));
    await Promise.resolve();
    setTimeout(() => c.tick(1_000), 10);
    expect(await idem.handle('k', 'fp', () => 'second')).toMatchObject({
      outcome: 'executed',
      response: 'second',
    });
  });

  it('does not wait on a fingerprint mismatch', async () => {
    const { idem } = setup({ onConflict: 'wait', wait: { timeoutMs: 5_000 } });
    void idem.handle('k', 'fp-a', () => new Promise<string>(() => undefined));
    await Promise.resolve();
    const started = Date.now();
    expect(await idem.handle('k', 'fp-b', () => 'x')).toMatchObject({ outcome: 'mismatch' });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('validates the wait bounds', () => {
    const store = new MemoryStore({ sweepIntervalMs: 0 });
    expect(() => createIdempotency({ store, wait: { pollIntervalMs: 0 } })).toThrow(
      IdempotencyConfigError,
    );
  });
});

describe('handle failure modes', () => {
  it('releases the key when the handler throws so a retry re-executes', async () => {
    const { idem, store } = setup();
    await expect(
      idem.handle('k', 'fp', () => {
        throw new Error('gateway down');
      }),
    ).rejects.toThrow('gateway down');
    expect(await store.get('k')).toBeUndefined();
    expect(await idem.handle('k', 'fp', () => 'ok')).toMatchObject({
      outcome: 'executed',
      response: 'ok',
    });
  });

  it('releases instead of storing when shouldStore says no', async () => {
    const { idem, store } = setup({ shouldStore: (r) => r !== 'transient' });
    expect(await idem.handle('k', 'fp', () => 'transient')).toEqual({
      outcome: 'executed',
      response: 'transient',
      stored: false,
    });
    expect(await store.get('k')).toBeUndefined();
    expect(await idem.handle('k', 'fp', () => 'final')).toMatchObject({ stored: true });
    expect(await idem.handle('k', 'fp', () => 'x')).toMatchObject({ outcome: 'replayed' });
  });

  it('fails closed when acquire throws', async () => {
    const onStoreError = vi.fn();
    const { idem, store } = setup({ onStoreError });
    const boom = new Error('ECONNREFUSED');
    vi.spyOn(store, 'acquire').mockRejectedValueOnce(boom);
    const execute = vi.fn(() => 'x');
    expect(await idem.handle('k', 'fp', execute)).toEqual({
      outcome: 'store-unavailable',
      error: boom,
    });
    expect(execute).not.toHaveBeenCalled();
    expect(onStoreError).toHaveBeenCalledWith(boom, { key: 'k', operation: 'acquire' });
  });

  it('runs unprotected when failOpen is set', async () => {
    const onStoreError = vi.fn();
    const { idem, store } = setup({ failOpen: true, onStoreError });
    vi.spyOn(store, 'acquire').mockRejectedValueOnce(new Error('ECONNREFUSED'));
    expect(await idem.handle('k', 'fp', () => 'x')).toEqual({
      outcome: 'executed',
      response: 'x',
      stored: false,
    });
    expect(onStoreError).toHaveBeenCalledTimes(1);
  });

  it('reports but does not fail when complete throws after the handler ran', async () => {
    const onStoreError = vi.fn();
    const { idem, store } = setup({ onStoreError });
    vi.spyOn(store, 'complete').mockRejectedValueOnce(new Error('timeout'));
    expect(await idem.handle('k', 'fp', () => 'x')).toEqual({
      outcome: 'executed',
      response: 'x',
      stored: false,
    });
    expect(onStoreError).toHaveBeenCalledWith(expect.any(Error), {
      key: 'k',
      operation: 'complete',
    });
  });

  it('still rethrows the handler error when release itself fails', async () => {
    const onStoreError = vi.fn();
    const { idem, store } = setup({ onStoreError });
    vi.spyOn(store, 'release').mockRejectedValueOnce(new Error('timeout'));
    await expect(
      idem.handle('k', 'fp', () => Promise.reject(new Error('handler'))),
    ).rejects.toThrow('handler');
    expect(onStoreError).toHaveBeenCalledWith(expect.any(Error), {
      key: 'k',
      operation: 'release',
    });
  });

  it('reports stored: false when a stale owner completes after a takeover', async () => {
    const { idem, c } = setup();
    let finish!: (v: string) => void;
    const first = idem.handle('k', 'fp', () => new Promise<string>((r) => (finish = r)));
    await Promise.resolve();
    c.tick(1_000);
    expect(await idem.handle('k', 'fp', () => 'second')).toMatchObject({ stored: true });
    finish('first');
    expect(await first).toEqual({ outcome: 'executed', response: 'first', stored: false });
    expect(await idem.handle('k', 'fp', () => 'x')).toMatchObject({
      outcome: 'replayed',
      response: 'second',
    });
  });
});
