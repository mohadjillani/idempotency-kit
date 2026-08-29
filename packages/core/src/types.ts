/**
 * Time-to-live pair handed to `acquire`. Both are milliseconds.
 *
 * - `keyTtlMs`: how long a key is remembered at all (in-flight or completed).
 * - `lockTtlMs`: how long an in-flight record blocks other callers before it is
 *   treated as abandoned and can be taken over. Must be shorter than `keyTtlMs`.
 */
export interface AcquireTtl {
  keyTtlMs: number;
  lockTtlMs: number;
}

interface RecordBase {
  key: string;
  /** Hash of the request that first claimed the key. */
  fingerprint: string;
  /** Epoch milliseconds of the first acquire. */
  createdAt: number;
  /** Epoch milliseconds after which the key is forgotten. */
  expiresAt: number;
  /**
   * Fencing token minted on acquire. `complete` and `release` only succeed for
   * the caller that holds the current token, so a caller whose lock expired
   * cannot overwrite the result of whoever took the key over.
   */
  token: string;
}

export interface InFlightRecord extends RecordBase {
  status: 'in-flight';
  /** Epoch milliseconds after which the in-flight lock may be taken over. */
  lockExpiresAt: number;
}

export interface CompletedRecord<T> extends RecordBase {
  status: 'completed';
  completedAt: number;
  response: T;
}

export type IdempotencyRecord<T> = InFlightRecord | CompletedRecord<T>;

/**
 * Result of the single atomic `acquire` operation.
 *
 * - `acquired`: the caller now owns the key and must `complete` or `release` it.
 * - `in-flight`: another caller owns it and its lock has not expired.
 * - `completed`: a response is stored; replay it (after checking the fingerprint).
 */
export type AcquireResult<T> =
  | { status: 'acquired'; record: InFlightRecord }
  | { status: 'in-flight'; record: InFlightRecord }
  | { status: 'completed'; record: CompletedRecord<T> };

/**
 * The store contract. Every operation must be atomic with respect to the key:
 * `acquire` in particular is one check-and-claim step, never a read followed by
 * a write, because the gap between those two calls is exactly where a double
 * execution happens.
 */
export interface IdempotencyStore<T = unknown> {
  /** Claim the key, or report who has it. Takes over expired in-flight locks. */
  acquire(key: string, fingerprint: string, ttl: AcquireTtl): Promise<AcquireResult<T>>;
  /**
   * Store the response for a key the caller acquired. Resolves `false` when the
   * caller no longer holds the key (its lock expired and someone else took over).
   */
  complete(key: string, token: string, response: T): Promise<boolean>;
  /** Forget an in-flight key the caller acquired so the next request re-executes. */
  release(key: string, token: string): Promise<boolean>;
  /** Read a key without changing it. `undefined` when absent or expired. */
  get(key: string): Promise<IdempotencyRecord<T> | undefined>;
  /** Release resources (connections, timers). Optional. */
  close?(): Promise<void>;
}
