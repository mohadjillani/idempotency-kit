import { describe, expect, it } from 'vitest';
import { state } from '@mohadjillani/idempotency-kit';

const { ABSENT, acquire, complete, release, expire } = state;

const ttl = { keyTtlMs: 1_000, lockTtlMs: 100 };
const input = (over: Partial<state.AcquireInput> = {}): state.AcquireInput => ({
  key: 'k',
  fingerprint: 'fp',
  token: 't1',
  now: 0,
  ...ttl,
  ...over,
});

describe('state transitions', () => {
  it('claims an absent key', () => {
    const t = acquire(ABSENT, input());
    expect(t.result.status).toBe('acquired');
    expect(t.state).toMatchObject({
      status: 'in-flight',
      key: 'k',
      fingerprint: 'fp',
      token: 't1',
      createdAt: 0,
      expiresAt: 1_000,
      lockExpiresAt: 100,
    });
  });

  it('reports a live in-flight key without changing it', () => {
    const first = acquire(ABSENT, input());
    const second = acquire(first.state, input({ token: 't2', now: 50 }));
    expect(second.result.status).toBe('in-flight');
    expect(second.state).toBe(first.state);
    expect(second.result.record.token).toBe('t1');
  });

  it('takes over an in-flight key whose lock expired', () => {
    const first = acquire(ABSENT, input());
    const second = acquire(first.state, input({ token: 't2', now: 100 }));
    expect(second.result.status).toBe('acquired');
    expect(second.result.record.token).toBe('t2');
    expect(second.result.record.expiresAt).toBe(1_100);
  });

  it('completes only for the current owner', () => {
    const first = acquire(ABSENT, input());
    const stale = complete(first.state, 'other', 'resp', 10);
    expect(stale.result).toBe(false);
    expect(stale.state).toBe(first.state);

    const done = complete(first.state, 't1', 'resp', 10);
    expect(done.result).toBe(true);
    expect(done.state).toMatchObject({
      status: 'completed',
      response: 'resp',
      completedAt: 10,
      expiresAt: 1_000,
    });
  });

  it('replays a completed key regardless of token', () => {
    const done = complete(acquire(ABSENT, input()).state, 't1', 'resp', 10);
    const again = acquire(done.state, input({ token: 't9', now: 500 }));
    expect(again.result.status).toBe('completed');
    expect(again.state).toBe(done.state);
  });

  it('releases only an in-flight key owned by the token', () => {
    const first = acquire(ABSENT, input());
    expect(release(first.state, 'other', 5).result).toBe(false);
    expect(release(first.state, 't1', 5)).toEqual({ state: ABSENT, result: true });

    const done = complete(first.state, 't1', 'resp', 10);
    expect(release(done.state, 't1', 20).result).toBe(false);
  });

  it('forgets a key once its ttl passes', () => {
    const done = complete(acquire(ABSENT, input()).state, 't1', 'resp', 10);
    expect(expire(done.state, 999)).toBe(done.state);
    expect(expire(done.state, 1_000)).toBe(ABSENT);
    expect(acquire(done.state, input({ token: 't2', now: 1_000 })).result.status).toBe('acquired');
  });

  it('a stale owner cannot complete after a takeover', () => {
    const first = acquire(ABSENT, input());
    const taken = acquire(first.state, input({ token: 't2', now: 100 }));
    const stale = complete(taken.state, 't1', 'old', 110);
    expect(stale.result).toBe(false);
    expect(stale.state.status).toBe('in-flight');
    expect(complete(taken.state, 't2', 'new', 120).result).toBe(true);
  });
});
