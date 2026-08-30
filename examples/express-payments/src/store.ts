import { MemoryStore } from '@mohadjillani/idempotency-kit';
import { RedisStore } from '@mohadjillani/idempotency-kit-redis';
import type { CapturedResponse } from '@mohadjillani/idempotency-kit/express';
import { Redis } from 'ioredis';

/** Redis when REDIS_URL is set (survives restarts, shared across replicas), memory otherwise. */
export async function createStore(): Promise<{
  name: string;
  store: MemoryStore<CapturedResponse> | RedisStore<CapturedResponse>;
  close: () => Promise<void>;
}> {
  const url = process.env.REDIS_URL;
  if (!url) {
    const store = new MemoryStore<CapturedResponse>();
    return { name: 'memory', store, close: () => store.close() };
  }
  const redis = new Redis(url, { lazyConnect: true });
  await redis.connect();
  const store = new RedisStore<CapturedResponse>(redis, { prefix: 'payments:idem:' });
  return {
    name: `redis (${url})`,
    store,
    close: async () => {
      await redis.quit();
    },
  };
}
