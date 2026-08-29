import type { AcquireResult, AcquireTtl, CompletedRecord, InFlightRecord } from './types.js';

/**
 * Pure state machine for one idempotency key.
 *
 * The memory store runs on these functions directly; the Redis and MongoDB
 * stores re-implement the same transitions inside the database so they are
 * atomic there. The property tests in `test/state.property.test.ts` check the
 * invariants against this module, and the store contract suite checks that the
 * other stores agree with it.
 */
export type KeyState<T> = { status: 'absent' } | InFlightRecord | CompletedRecord<T>;

export const ABSENT: { status: 'absent' } = { status: 'absent' };

export interface AcquireInput extends AcquireTtl {
  key: string;
  fingerprint: string;
  token: string;
  now: number;
}

export interface Transition<T, R> {
  state: KeyState<T>;
  result: R;
}

/** Apply expiry: a key past `expiresAt` is indistinguishable from an absent one. */
export function expire<T>(state: KeyState<T>, now: number): KeyState<T> {
  if (state.status === 'absent') return state;
  return state.expiresAt <= now ? ABSENT : state;
}

/** A lock that has run past `lockExpiresAt` belongs to an abandoned execution. */
export function isLockExpired(record: InFlightRecord, now: number): boolean {
  return record.lockExpiresAt <= now;
}

function claim(input: AcquireInput): InFlightRecord {
  return {
    status: 'in-flight',
    key: input.key,
    fingerprint: input.fingerprint,
    token: input.token,
    createdAt: input.now,
    expiresAt: input.now + input.keyTtlMs,
    lockExpiresAt: input.now + input.lockTtlMs,
  };
}

/**
 * absent → in-flight (acquired)
 * in-flight, lock expired → in-flight with a new owner (acquired)
 * in-flight, lock live → unchanged (in-flight)
 * completed → unchanged (completed)
 */
export function acquire<T>(
  current: KeyState<T>,
  input: AcquireInput,
): Transition<T, AcquireResult<T>> {
  const state = expire(current, input.now);
  if (state.status === 'absent') {
    const record = claim(input);
    return { state: record, result: { status: 'acquired', record } };
  }
  if (state.status === 'in-flight') {
    if (isLockExpired(state, input.now)) {
      const record = claim(input);
      return { state: record, result: { status: 'acquired', record } };
    }
    return { state, result: { status: 'in-flight', record: state } };
  }
  return { state, result: { status: 'completed', record: state } };
}

/**
 * in-flight (owned by `token`) → completed. Any other state is left untouched
 * and reported as `false`: a stale owner must not overwrite a newer execution.
 */
export function complete<T>(
  current: KeyState<T>,
  token: string,
  response: T,
  now: number,
): Transition<T, boolean> {
  const state = expire(current, now);
  if (state.status !== 'in-flight' || state.token !== token) {
    return { state, result: false };
  }
  const record: CompletedRecord<T> = {
    status: 'completed',
    key: state.key,
    fingerprint: state.fingerprint,
    token: state.token,
    createdAt: state.createdAt,
    expiresAt: state.expiresAt,
    completedAt: now,
    response,
  };
  return { state: record, result: true };
}

/** in-flight (owned by `token`) → absent. Completed keys are never released. */
export function release<T>(
  current: KeyState<T>,
  token: string,
  now: number,
): Transition<T, boolean> {
  const state = expire(current, now);
  if (state.status !== 'in-flight' || state.token !== token) {
    return { state, result: false };
  }
  return { state: ABSENT, result: true };
}
