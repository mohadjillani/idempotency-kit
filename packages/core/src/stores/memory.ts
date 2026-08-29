import { randomUUID } from 'node:crypto';
import { ABSENT, acquire, complete, expire, release, type KeyState } from '../state.js';
import type { AcquireResult, AcquireTtl, IdempotencyRecord, IdempotencyStore } from '../types.js';

export interface MemoryStoreOptions {
  /** Clock used for TTLs. Defaults to `Date.now`; inject one in tests. */
  now?: () => number;
  /**
   * How often expired keys are swept out of the map, in milliseconds. Expiry
   * is also applied lazily on every read, so the sweep only bounds memory.
   * `0` disables the timer (then call `sweep()` yourself or accept growth).
   * Defaults to 60 seconds.
   */
  sweepIntervalMs?: number;
}

/**
 * In-process store: a `Map` driven by the pure transition functions. Atomic
 * because nothing inside `acquire` awaits, so no other request can interleave.
 * Suitable for a single process; a fleet needs the Redis or MongoDB store.
 */
export class MemoryStore<T = unknown> implements IdempotencyStore<T> {
  private readonly keys = new Map<string, KeyState<T>>();
  private readonly now: () => number;
  private readonly timer: NodeJS.Timeout | undefined;

  constructor(options: MemoryStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    const interval = options.sweepIntervalMs ?? 60_000;
    if (interval > 0) {
      this.timer = setInterval(() => {
        this.sweep();
      }, interval);
      this.timer.unref();
    }
  }

  acquire(key: string, fingerprint: string, ttl: AcquireTtl): Promise<AcquireResult<T>> {
    const now = this.now();
    const t = acquire(this.keys.get(key) ?? ABSENT, {
      key,
      fingerprint,
      token: randomUUID(),
      now,
      ...ttl,
    });
    this.keys.set(key, t.state);
    return Promise.resolve(t.result);
  }

  complete(key: string, token: string, response: T): Promise<boolean> {
    const t = complete(this.keys.get(key) ?? ABSENT, token, response, this.now());
    this.set(key, t.state);
    return Promise.resolve(t.result);
  }

  release(key: string, token: string): Promise<boolean> {
    const t = release(this.keys.get(key) ?? ABSENT, token, this.now());
    this.set(key, t.state);
    return Promise.resolve(t.result);
  }

  get(key: string): Promise<IdempotencyRecord<T> | undefined> {
    const state = expire(this.keys.get(key) ?? ABSENT, this.now());
    this.set(key, state);
    return Promise.resolve(state.status === 'absent' ? undefined : state);
  }

  /** Drop every expired key. Returns how many were removed. */
  sweep(): number {
    const now = this.now();
    let removed = 0;
    for (const [key, state] of this.keys) {
      if (expire(state, now).status === 'absent') {
        this.keys.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  /** Number of keys currently held, including ones that expired but were not swept. */
  get size(): number {
    return this.keys.size;
  }

  close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.keys.clear();
    return Promise.resolve();
  }

  private set(key: string, state: KeyState<T>): void {
    if (state.status === 'absent') this.keys.delete(key);
    else this.keys.set(key, state);
  }
}
