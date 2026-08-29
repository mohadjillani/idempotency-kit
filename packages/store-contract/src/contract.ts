import { randomUUID } from 'node:crypto';
import type { IdempotencyStore } from '@mohadjillani/idempotency-kit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

export interface StoreContractOptions {
  /** Build a fresh store. Called once per suite. */
  create: () => Promise<IdempotencyStore> | IdempotencyStore;
  /** Tear the store down. Defaults to `store.close?.()`. */
  destroy?: (store: IdempotencyStore) => Promise<void> | void;
  /**
   * Slack allowed when comparing timestamps the store produced with the test's
   * own clock, in milliseconds. Raise it for stores that use a server clock.
   */
  clockToleranceMs?: number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const ttl = { keyTtlMs: 60_000, lockTtlMs: 5_000 };

/**
 * Behaviour every store must exhibit. The memory store passes it by
 * construction (it runs on the pure transition functions); the Redis and
 * MongoDB stores prove their in-database implementations agree.
 *
 * Every test uses a fresh random key so suites can run against a shared
 * backend without cleaning up.
 */
export function describeStoreContract(name: string, options: StoreContractOptions): void {
  describe(`store contract: ${name}`, () => {
    let store: IdempotencyStore;
    const tolerance = options.clockToleranceMs ?? 50;
    const key = () => `contract:${randomUUID()}`;

    beforeAll(async () => {
      store = await options.create();
    });

    afterAll(async () => {
      if (options.destroy) await options.destroy(store);
      else await store.close?.();
    });

    it('claims an absent key and returns the in-flight record', async () => {
      const k = key();
      const before = Date.now();
      const result = await store.acquire(k, 'fp', ttl);
      expect(result.status).toBe('acquired');
      const { record } = result;
      expect(record.status).toBe('in-flight');
      expect(record.key).toBe(k);
      expect(record.fingerprint).toBe('fp');
      expect(typeof record.token).toBe('string');
      expect(record.token.length).toBeGreaterThan(0);
      expect(record.createdAt).toBeGreaterThanOrEqual(before - tolerance);
      expect(record.createdAt).toBeLessThanOrEqual(Date.now() + tolerance);
      expect(record.expiresAt).toBe(record.createdAt + ttl.keyTtlMs);
      if (record.status === 'in-flight') {
        expect(record.lockExpiresAt).toBe(record.createdAt + ttl.lockTtlMs);
      }
    });

    it('reports a live in-flight key with the owner record, unchanged', async () => {
      const k = key();
      const first = await store.acquire(k, 'fp', ttl);
      const second = await store.acquire(k, 'fp', ttl);
      expect(second.status).toBe('in-flight');
      expect(second.record).toEqual(first.record);
      const third = await store.acquire(k, 'other-fingerprint', ttl);
      expect(third.status).toBe('in-flight');
      expect(third.record.fingerprint).toBe('fp');
    });

    it('completes for the owner and replays the response verbatim', async () => {
      const k = key();
      const response = {
        status: 201,
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          id: 'ch_1',
          amount: 1999,
          note: 'café ☕',
          nested: [1, { a: null }],
        }),
        n: 0,
        list: [],
      };
      const first = await store.acquire(k, 'fp', ttl);
      expect(await store.complete(k, first.record.token, response)).toBe(true);
      const again = await store.acquire(k, 'fp', ttl);
      expect(again.status).toBe('completed');
      if (again.status !== 'completed') return;
      expect(again.record.response).toEqual(response);
      expect(again.record.fingerprint).toBe('fp');
      expect(again.record.token).toBe(first.record.token);
      expect(again.record.createdAt).toBe(first.record.createdAt);
      expect(again.record.expiresAt).toBe(first.record.expiresAt);
      expect(again.record.completedAt).toBeGreaterThanOrEqual(first.record.createdAt - tolerance);
      expect(await store.get(k)).toEqual(again.record);
    });

    it('rejects complete from a caller that does not hold the token', async () => {
      const k = key();
      const first = await store.acquire(k, 'fp', ttl);
      expect(await store.complete(k, 'not-the-token', 'x')).toBe(false);
      expect((await store.get(k))?.status).toBe('in-flight');
      expect(await store.complete(k, first.record.token, 'x')).toBe(true);
      expect(await store.complete(k, first.record.token, 'y')).toBe(false);
      const replay = await store.acquire(k, 'fp', ttl);
      expect(replay.status === 'completed' && replay.record.response).toBe('x');
    });

    it('releases for the owner so the next acquire starts over', async () => {
      const k = key();
      const first = await store.acquire(k, 'fp', ttl);
      expect(await store.release(k, 'not-the-token')).toBe(false);
      expect(await store.release(k, first.record.token)).toBe(true);
      expect(await store.get(k)).toBeUndefined();
      const second = await store.acquire(k, 'fp2', ttl);
      expect(second.status).toBe('acquired');
      expect(second.record.token).not.toBe(first.record.token);
      expect(second.record.fingerprint).toBe('fp2');
    });

    it('never releases a completed key', async () => {
      const k = key();
      const first = await store.acquire(k, 'fp', ttl);
      await store.complete(k, first.record.token, 'done');
      expect(await store.release(k, first.record.token)).toBe(false);
      expect((await store.get(k))?.status).toBe('completed');
    });

    it('takes over an in-flight key whose lock expired and fences the old owner', async () => {
      const k = key();
      const short = { keyTtlMs: 60_000, lockTtlMs: 40 };
      const first = await store.acquire(k, 'fp', short);
      await sleep(60);
      const second = await store.acquire(k, 'fp-new', short);
      expect(second.status).toBe('acquired');
      expect(second.record.token).not.toBe(first.record.token);
      expect(second.record.fingerprint).toBe('fp-new');
      expect(await store.complete(k, first.record.token, 'stale')).toBe(false);
      expect(await store.release(k, first.record.token)).toBe(false);
      expect(await store.complete(k, second.record.token, 'fresh')).toBe(true);
      const replay = await store.get(k);
      expect(replay?.status === 'completed' && replay.response).toBe('fresh');
    });

    it('forgets a completed key once its ttl passes', async () => {
      const k = key();
      const short = { keyTtlMs: 60, lockTtlMs: 20 };
      const first = await store.acquire(k, 'fp', short);
      await store.complete(k, first.record.token, 'x');
      await sleep(90);
      expect(await store.get(k)).toBeUndefined();
      const second = await store.acquire(k, 'fp', short);
      expect(second.status).toBe('acquired');
      expect(second.record.token).not.toBe(first.record.token);
    });

    it('reads keys without changing them', async () => {
      const k = key();
      expect(await store.get(k)).toBeUndefined();
      const first = await store.acquire(k, 'fp', ttl);
      expect(await store.get(k)).toEqual(first.record);
      expect((await store.acquire(k, 'fp', ttl)).status).toBe('in-flight');
    });

    it('keeps keys independent', async () => {
      const a = key();
      const b = key();
      const first = await store.acquire(a, 'fp', ttl);
      expect((await store.acquire(b, 'fp', ttl)).status).toBe('acquired');
      await store.complete(a, first.record.token, 'a');
      expect((await store.get(b))?.status).toBe('in-flight');
    });

    it('round-trips a large response', async () => {
      const k = key();
      const body = 'x'.repeat(256 * 1024);
      const first = await store.acquire(k, 'fp', ttl);
      await store.complete(k, first.record.token, { body });
      const replay = await store.get(k);
      expect(replay?.status === 'completed' && replay.response).toEqual({ body });
    });

    it('hands the key to exactly one of many concurrent acquires', async () => {
      const k = key();
      const results = await Promise.all(
        Array.from({ length: 50 }, () => store.acquire(k, 'fp', ttl)),
      );
      const acquired = results.filter((r) => r.status === 'acquired');
      const inFlight = results.filter((r) => r.status === 'in-flight');
      expect(acquired).toHaveLength(1);
      expect(inFlight).toHaveLength(49);
      const winner = acquired[0]?.record.token;
      for (const r of inFlight) expect(r.record.token).toBe(winner);
    });
  });
}
