import { IdempotencyConfigError } from './errors.js';
import type { CompletedRecord, IdempotencyStore, InFlightRecord } from './types.js';

export interface IdempotencyOptions<T> {
  store: IdempotencyStore<T>;
  /** How long a key is remembered, in milliseconds. Default 24 hours. */
  ttlMs?: number;
  /**
   * How long an in-flight key blocks other callers before it is treated as
   * abandoned (the process died mid-handler) and can be taken over. Must be
   * shorter than `ttlMs`. Default 30 seconds.
   */
  lockTtlMs?: number;
  /**
   * What to do when the same key arrives while the first request is still
   * running. `reject` (default) reports it immediately with a retry hint;
   * `wait` polls until the first request completes, then replays.
   */
  onConflict?: 'reject' | 'wait';
  /** Clock used for retry hints. Defaults to `Date.now`. */
  now?: () => number;
}

export type Outcome<T> =
  /** The handler ran. `stored` is false when the response was not kept. */
  | { outcome: 'executed'; response: T; stored: boolean }
  /** A previous execution's response, returned without running the handler. */
  | { outcome: 'replayed'; response: T; record: CompletedRecord<T> }
  /** Another request holds the key. `retryAfterMs` is until its lock expires. */
  | { outcome: 'in-flight'; retryAfterMs: number; record: InFlightRecord }
  /** The key exists but was first used for a different request. */
  | { outcome: 'mismatch'; record: InFlightRecord | CompletedRecord<T> };

export interface Idempotency<T> {
  /**
   * Run `execute` at most once per key. Returns what happened so the caller
   * (an HTTP binding, a queue consumer) can turn it into a response.
   */
  handle(key: string, fingerprint: string, execute: () => Promise<T> | T): Promise<Outcome<T>>;
  readonly options: Required<Omit<IdempotencyOptions<T>, 'store'>> & { store: IdempotencyStore<T> };
}

const HOUR = 60 * 60 * 1000;

export function createIdempotency<T>(options: IdempotencyOptions<T>): Idempotency<T> {
  const resolved = {
    store: options.store,
    ttlMs: options.ttlMs ?? 24 * HOUR,
    lockTtlMs: options.lockTtlMs ?? 30_000,
    onConflict: options.onConflict ?? 'reject',
    now: options.now ?? Date.now,
  } as const;

  if (!(resolved.ttlMs > 0)) {
    throw new IdempotencyConfigError('ttlMs must be a positive number of milliseconds');
  }
  if (!(resolved.lockTtlMs > 0) || resolved.lockTtlMs >= resolved.ttlMs) {
    throw new IdempotencyConfigError(
      `lockTtlMs (${String(resolved.lockTtlMs)}) must be positive and shorter than ttlMs (${String(resolved.ttlMs)})`,
    );
  }

  const ttl = { keyTtlMs: resolved.ttlMs, lockTtlMs: resolved.lockTtlMs };

  async function handle(
    key: string,
    fingerprint: string,
    execute: () => Promise<T> | T,
  ): Promise<Outcome<T>> {
    if (typeof key !== 'string' || key.length === 0) {
      throw new TypeError('idempotency key must be a non-empty string');
    }

    const acquired = await resolved.store.acquire(key, fingerprint, ttl);

    if (acquired.record.fingerprint !== fingerprint) {
      return { outcome: 'mismatch', record: acquired.record };
    }
    if (acquired.status === 'completed') {
      return { outcome: 'replayed', response: acquired.record.response, record: acquired.record };
    }
    if (acquired.status === 'in-flight') {
      return {
        outcome: 'in-flight',
        retryAfterMs: Math.max(0, acquired.record.lockExpiresAt - resolved.now()),
        record: acquired.record,
      };
    }

    const response = await execute();
    const stored = await resolved.store.complete(key, acquired.record.token, response);
    return { outcome: 'executed', response, stored };
  }

  return { handle, options: resolved };
}
