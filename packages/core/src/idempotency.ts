import { IdempotencyConfigError } from './errors.js';
import type { AcquireResult, CompletedRecord, IdempotencyStore, InFlightRecord } from './types.js';

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
  /** Bounds for `onConflict: 'wait'`. */
  wait?: {
    /** Give up waiting after this long and report `in-flight`. Default 5000. */
    timeoutMs?: number;
    /** How often to re-check the key while waiting. Default 25. */
    pollIntervalMs?: number;
  };
  /**
   * Decide whether a response the handler produced is worth replaying. When it
   * returns false the key is released so the next request re-executes. The
   * Express binding defaults this to "status below 500"; the core keeps every
   * response.
   */
  shouldStore?: (response: T) => boolean;
  /**
   * What to do when the store itself fails (connection refused, timeout).
   * `false` (default) reports `store-unavailable` and the handler does not
   * run: the library exists to prevent double effects, and running without
   * protection would break that silently. `true` runs the handler unprotected
   * and reports `stored: false`; use it for endpoints where availability
   * matters more than exactly-once.
   */
  failOpen?: boolean;
  /** Called with every store error, whichever way `failOpen` is set. */
  onStoreError?: (error: unknown, context: { key: string; operation: StoreOperation }) => void;
  /** Clock used for retry hints; TTLs themselves are the store's business. Defaults to `Date.now`. */
  now?: () => number;
}

export type StoreOperation = 'acquire' | 'complete' | 'release';

export type Outcome<T> =
  /** The handler ran. `stored` is false when the response was not kept. */
  | { outcome: 'executed'; response: T; stored: boolean }
  /** A previous execution's response, returned without running the handler. */
  | { outcome: 'replayed'; response: T; record: CompletedRecord<T> }
  /** Another request holds the key. `retryAfterMs` is until its lock expires. */
  | { outcome: 'in-flight'; retryAfterMs: number; record: InFlightRecord }
  /** The key exists but was first used for a different request. */
  | { outcome: 'mismatch'; record: InFlightRecord | CompletedRecord<T> }
  /** The store failed and `failOpen` is off, so nothing ran. */
  | { outcome: 'store-unavailable'; error: unknown };

export interface Idempotency<T> {
  /**
   * Run `execute` at most once per key. Returns what happened so the caller
   * (an HTTP binding, a queue consumer) can turn it into a response.
   */
  handle(key: string, fingerprint: string, execute: () => Promise<T> | T): Promise<Outcome<T>>;
  readonly options: ResolvedOptions<T>;
}

export interface ResolvedOptions<T> {
  store: IdempotencyStore<T>;
  ttlMs: number;
  lockTtlMs: number;
  onConflict: 'reject' | 'wait';
  wait: { timeoutMs: number; pollIntervalMs: number };
  shouldStore: (response: T) => boolean;
  failOpen: boolean;
  onStoreError: (error: unknown, context: { key: string; operation: StoreOperation }) => void;
  now: () => number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const HOUR = 60 * 60 * 1000;

export function createIdempotency<T>(options: IdempotencyOptions<T>): Idempotency<T> {
  const resolved: ResolvedOptions<T> = {
    store: options.store,
    ttlMs: options.ttlMs ?? 24 * HOUR,
    lockTtlMs: options.lockTtlMs ?? 30_000,
    onConflict: options.onConflict ?? 'reject',
    wait: {
      timeoutMs: options.wait?.timeoutMs ?? 5_000,
      pollIntervalMs: options.wait?.pollIntervalMs ?? 25,
    },
    shouldStore: options.shouldStore ?? (() => true),
    failOpen: options.failOpen ?? false,
    onStoreError: options.onStoreError ?? (() => undefined),
    now: options.now ?? Date.now,
  };

  if (!(resolved.ttlMs > 0)) {
    throw new IdempotencyConfigError('ttlMs must be a positive number of milliseconds');
  }
  if (!(resolved.lockTtlMs > 0) || resolved.lockTtlMs >= resolved.ttlMs) {
    throw new IdempotencyConfigError(
      `lockTtlMs (${String(resolved.lockTtlMs)}) must be positive and shorter than ttlMs (${String(resolved.ttlMs)})`,
    );
  }

  if (!(resolved.wait.timeoutMs >= 0) || !(resolved.wait.pollIntervalMs > 0)) {
    throw new IdempotencyConfigError('wait.timeoutMs must be >= 0 and wait.pollIntervalMs > 0');
  }

  const ttl = { keyTtlMs: resolved.ttlMs, lockTtlMs: resolved.lockTtlMs };

  /**
   * Poll acquire until the owner completes (replay), abandons the key (we take
   * it over and execute), or the wait budget runs out (report in-flight).
   */
  async function waitForOwner(key: string, fingerprint: string, first: AcquireResult<T>) {
    // Elapsed wall-clock time, not the injectable `now`: the budget is about how
    // long this caller is prepared to hold its connection open.
    const deadline = performance.now() + resolved.wait.timeoutMs;
    let latest = first;
    while (latest.status === 'in-flight' && performance.now() < deadline) {
      await sleep(
        Math.min(resolved.wait.pollIntervalMs, Math.max(1, deadline - performance.now())),
      );
      latest = await resolved.store.acquire(key, fingerprint, ttl);
    }
    return latest;
  }

  async function handle(
    key: string,
    fingerprint: string,
    execute: () => Promise<T> | T,
  ): Promise<Outcome<T>> {
    if (typeof key !== 'string' || key.length === 0) {
      throw new TypeError('idempotency key must be a non-empty string');
    }

    let acquired: AcquireResult<T>;
    try {
      acquired = await resolved.store.acquire(key, fingerprint, ttl);
    } catch (error) {
      resolved.onStoreError(error, { key, operation: 'acquire' });
      if (!resolved.failOpen) return { outcome: 'store-unavailable', error };
      return { outcome: 'executed', response: await execute(), stored: false };
    }

    if (
      acquired.status === 'in-flight' &&
      acquired.record.fingerprint === fingerprint &&
      resolved.onConflict === 'wait'
    ) {
      acquired = await waitForOwner(key, fingerprint, acquired);
    }

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

    const { token } = acquired.record;
    let response: T;
    try {
      response = await execute();
    } catch (error) {
      // The handler failed: forget the key so the client's retry re-executes
      // instead of replaying a failure for the rest of the TTL.
      await release(key, token);
      throw error;
    }

    if (!resolved.shouldStore(response)) {
      await release(key, token);
      return { outcome: 'executed', response, stored: false };
    }

    let stored = false;
    try {
      stored = await resolved.store.complete(key, token, response);
    } catch (error) {
      // The effect already happened; the most we can do is report it. The
      // in-flight record expires with its lock, after which a retry re-executes.
      resolved.onStoreError(error, { key, operation: 'complete' });
    }
    return { outcome: 'executed', response, stored };
  }

  async function release(key: string, token: string): Promise<void> {
    try {
      await resolved.store.release(key, token);
    } catch (error) {
      resolved.onStoreError(error, { key, operation: 'release' });
    }
  }

  return { handle, options: resolved };
}
