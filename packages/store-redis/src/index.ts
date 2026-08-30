import { createHash, randomUUID } from 'node:crypto';
import type {
  AcquireResult,
  AcquireTtl,
  IdempotencyRecord,
  IdempotencyStore,
} from '@mohadjillani/idempotency-kit';
import type { Redis } from 'ioredis';
import { ACQUIRE, COMPLETE, RELEASE } from './scripts.js';

export interface RedisStoreOptions {
  /** Prepended to every key. Default `idem:`. */
  prefix?: string;
  /** Clock for TTL arithmetic. Defaults to `Date.now`. */
  now?: () => number;
}

interface Script {
  source: string;
  sha: string;
}

const script = (source: string): Script => ({
  source,
  sha: createHash('sha1').update(source).digest('hex'),
});

const scripts = { acquire: script(ACQUIRE), complete: script(COMPLETE), release: script(RELEASE) };

/**
 * Redis-backed store. One hash per key, expired by Redis (`PEXPIRE`) and,
 * for the in-flight lock, by the timestamp inside the hash. All three
 * transitions are Lua scripts, so each is a single atomic step on the server.
 *
 * The client is passed in rather than created: connection lifecycle, TLS and
 * retry policy belong to the application. Single-node and Sentinel only; in
 * Cluster mode the scripts still work because every script touches one key,
 * but the package is not tested against it.
 */
export class RedisStore<T = unknown> implements IdempotencyStore<T> {
  private readonly prefix: string;
  private readonly now: () => number;

  constructor(
    private readonly redis: Redis,
    options: RedisStoreOptions = {},
  ) {
    this.prefix = options.prefix ?? 'idem:';
    this.now = options.now ?? Date.now;
  }

  async acquire(key: string, fingerprint: string, ttl: AcquireTtl): Promise<AcquireResult<T>> {
    const now = this.now();
    const raw = (await this.run(
      scripts.acquire,
      key,
      fingerprint,
      randomUUID(),
      String(now),
      String(now + ttl.keyTtlMs),
      String(now + ttl.lockTtlMs),
      String(ttl.keyTtlMs),
    )) as [string, string[]];
    const record = this.parse(key, raw[1]);
    if (raw[0] === 'acquired' || raw[0] === 'in-flight') {
      if (record.status !== 'in-flight')
        throw new Error('redis store returned an inconsistent record');
      return { status: raw[0], record };
    }
    if (record.status !== 'completed')
      throw new Error('redis store returned an inconsistent record');
    return { status: 'completed', record };
  }

  async complete(key: string, token: string, response: T): Promise<boolean> {
    const result = await this.run(
      scripts.complete,
      key,
      token,
      JSON.stringify(response),
      String(this.now()),
    );
    return result === 1;
  }

  async release(key: string, token: string): Promise<boolean> {
    return (await this.run(scripts.release, key, token)) === 1;
  }

  async get(key: string): Promise<IdempotencyRecord<T> | undefined> {
    const fields = await this.redis.hgetall(this.prefix + key);
    if (Object.keys(fields).length === 0) return undefined;
    const record = this.parse(key, Object.entries(fields).flat());
    return record.expiresAt <= this.now() ? undefined : record;
  }

  /** EVALSHA with a one-time EVAL fallback when Redis has not seen the script (restart, SCRIPT FLUSH). */
  private async run(s: Script, key: string, ...args: string[]): Promise<unknown> {
    const fullKey = this.prefix + key;
    try {
      return await this.redis.evalsha(s.sha, 1, fullKey, ...args);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('NOSCRIPT')) {
        return this.redis.eval(s.source, 1, fullKey, ...args);
      }
      throw error;
    }
  }

  private parse(key: string, flat: string[]): IdempotencyRecord<T> {
    const f: Record<string, string> = {};
    for (let i = 0; i + 1 < flat.length; i += 2) {
      const name = flat[i];
      const value = flat[i + 1];
      if (name !== undefined && value !== undefined) f[name] = value;
    }
    const base = {
      key,
      fingerprint: f.fingerprint ?? '',
      token: f.token ?? '',
      createdAt: Number(f.createdAt),
      expiresAt: Number(f.expiresAt),
    };
    if (f.status === 'completed') {
      return {
        ...base,
        status: 'completed',
        completedAt: Number(f.completedAt),
        response: JSON.parse(f.response ?? 'null') as T,
      };
    }
    return { ...base, status: 'in-flight', lockExpiresAt: Number(f.lockExpiresAt) };
  }
}
