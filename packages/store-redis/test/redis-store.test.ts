import { Redis } from 'ioredis';
import { describe, it } from 'vitest';
import { RedisStore } from '@mohadjillani/idempotency-kit-redis';
import { describeRaceSuite, describeStoreContract } from 'idempotency-kit-store-contract';
import type { CapturedResponse } from '@mohadjillani/idempotency-kit/express';

const url = process.env.REDIS_URL;

if (!url) {
  describe.skip('redis store (set REDIS_URL to run against a live server)', () => {
    it('skipped: REDIS_URL is not set', () => undefined);
  });
} else {
  const prefix = `idem-test:${String(process.pid)}:`;
  const connect = () => new Redis(url, { lazyConnect: true });

  describeStoreContract('redis', {
    create: async () => {
      const redis = connect();
      await redis.connect();
      const store = new RedisStore(redis, { prefix });
      return Object.assign(store, { close: () => redis.quit().then(() => undefined) });
    },
  });

  describeRaceSuite('redis', {
    create: async () => {
      const redis = connect();
      await redis.connect();
      const store = new RedisStore<CapturedResponse>(redis, { prefix });
      return Object.assign(store, { close: () => redis.quit().then(() => undefined) });
    },
  });

  describe('redis store specifics', () => {
    it('falls back to EVAL when the script cache is flushed', async () => {
      const redis = connect();
      await redis.connect();
      try {
        const store = new RedisStore(redis, { prefix });
        await redis.script('FLUSH');
        const first = await store.acquire('flushed', 'fp', { keyTtlMs: 5_000, lockTtlMs: 1_000 });
        await redis.script('FLUSH');
        const done = await store.complete('flushed', first.record.token, { ok: true });
        if (!done) throw new Error('complete should succeed after a script flush');
        const ttl = await redis.pttl(`${prefix}flushed`);
        if (ttl <= 0 || ttl > 5_000) throw new Error(`unexpected pttl ${String(ttl)}`);
      } finally {
        await redis.del(`${prefix}flushed`);
        await redis.quit();
      }
    });
  });
}
