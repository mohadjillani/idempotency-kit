import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { state, type AcquireResult } from '@mohadjillani/idempotency-kit';

const { ABSENT, acquire, complete, release, expire } = state;

type Event =
  | { type: 'acquire'; fingerprint: string; delta: number; keyTtlMs: number; lockTtlMs: number }
  | { type: 'complete'; owner: 'current' | 'stale'; delta: number; response: number }
  | { type: 'release'; owner: 'current' | 'stale'; delta: number };

const delta = fc.integer({ min: 0, max: 150 });
const owner = fc.constantFrom<'current' | 'stale'>('current', 'current', 'stale');

const event: fc.Arbitrary<Event> = fc.oneof(
  fc.record({
    type: fc.constant<'acquire'>('acquire'),
    fingerprint: fc.constantFrom('fp-a', 'fp-b'),
    delta,
    keyTtlMs: fc.integer({ min: 200, max: 1_000 }),
    lockTtlMs: fc.integer({ min: 1, max: 199 }),
  }),
  fc.record({ type: fc.constant<'complete'>('complete'), owner, delta, response: fc.nat() }),
  fc.record({ type: fc.constant<'release'>('release'), owner, delta }),
);

/**
 * Replay a sequence of events against one key, recording every transition.
 * Tokens are minted per acquire; "current" means the token the last acquire
 * handed out, "stale" means one from an earlier acquire (or a made-up one).
 */
function run(events: readonly Event[]) {
  let current: state.KeyState<number> = ABSENT;
  let now = 0;
  let tokens = 0;
  let lastToken = 'none';
  const steps: {
    before: state.KeyState<number>;
    event: Event;
    now: number;
    after: state.KeyState<number>;
    result: unknown;
  }[] = [];

  for (const ev of events) {
    now += ev.delta;
    const before = current;
    let result: unknown;
    if (ev.type === 'acquire') {
      tokens += 1;
      const token = `t${String(tokens)}`;
      const t: state.Transition<number, AcquireResult<number>> = acquire<number>(current, {
        key: 'k',
        fingerprint: ev.fingerprint,
        token,
        now,
        keyTtlMs: ev.keyTtlMs,
        lockTtlMs: ev.lockTtlMs,
      });
      current = t.state;
      result = t.result;
      if (t.result.status === 'acquired') lastToken = token;
    } else {
      const token = ev.owner === 'current' ? lastToken : 'stale-token';
      const t: state.Transition<number, boolean> =
        ev.type === 'complete'
          ? complete<number>(current, token, ev.response, now)
          : release<number>(current, token, now);
      current = t.state;
      result = t.result;
    }
    steps.push({ before, event: ev, now, after: current, result });
  }
  return steps;
}

const isAcquireResult = (r: unknown): r is { status: string; record: { status: string } } =>
  typeof r === 'object' && r !== null && 'status' in r;

describe('state machine properties', () => {
  it('only claims a key that is absent, expired, or whose lock has expired', () => {
    fc.assert(
      fc.property(fc.array(event, { maxLength: 40 }), (events) => {
        for (const step of run(events)) {
          if (step.event.type !== 'acquire') continue;
          const result = step.result as { status: string };
          if (result.status !== 'acquired') continue;
          const visible = expire(step.before, step.now);
          const claimable =
            visible.status === 'absent' ||
            (visible.status === 'in-flight' && visible.lockExpiresAt <= step.now);
          expect(claimable).toBe(true);
        }
      }),
    );
  });

  it('a live in-flight or completed key is never changed by acquire', () => {
    fc.assert(
      fc.property(fc.array(event, { maxLength: 40 }), (events) => {
        for (const step of run(events)) {
          if (step.event.type !== 'acquire') continue;
          const result = step.result as { status: string };
          if (result.status === 'acquired') continue;
          expect(step.after).toBe(expire(step.before, step.now));
        }
      }),
    );
  });

  it('a completed key replays the same response until it expires', () => {
    fc.assert(
      fc.property(fc.array(event, { maxLength: 40 }), (events) => {
        for (const step of run(events)) {
          if (step.before.status !== 'completed' || step.before.expiresAt <= step.now) continue;
          if (step.event.type === 'acquire') {
            expect(step.result).toEqual({ status: 'completed', record: step.before });
          }
          expect(step.after).toBe(step.before);
        }
      }),
    );
  });

  it('only the current owner can complete or release', () => {
    fc.assert(
      fc.property(fc.array(event, { maxLength: 40 }), (events) => {
        for (const step of run(events)) {
          if (step.event.type === 'acquire') continue;
          const visible = expire(step.before, step.now);
          if (step.event.owner === 'stale' || visible.status !== 'in-flight') {
            expect(step.result).toBe(false);
            expect(step.after).toBe(visible);
          } else {
            expect(step.result).toBe(true);
            expect(step.after.status).toBe(step.event.type === 'complete' ? 'completed' : 'absent');
          }
        }
      }),
    );
  });

  it('every transition is one the semantics table lists', () => {
    const allowed = new Set([
      'absent:acquire:in-flight',
      'absent:complete:absent',
      'absent:release:absent',
      'in-flight:acquire:in-flight',
      'in-flight:complete:completed',
      'in-flight:complete:in-flight',
      'in-flight:release:absent',
      'in-flight:release:in-flight',
      'completed:acquire:completed',
      'completed:complete:completed',
      'completed:release:completed',
    ]);
    fc.assert(
      fc.property(fc.array(event, { maxLength: 40 }), (events) => {
        for (const step of run(events)) {
          const from = expire(step.before, step.now).status;
          const edge = `${from}:${step.event.type}:${step.after.status}`;
          expect(allowed.has(edge), edge).toBe(true);
        }
      }),
    );
  });

  it('completing preserves the key ttl set at acquire', () => {
    fc.assert(
      fc.property(fc.array(event, { maxLength: 40 }), (events) => {
        for (const step of run(events)) {
          if (step.before.status === 'in-flight' && step.after.status === 'completed') {
            expect(step.after.expiresAt).toBe(step.before.expiresAt);
            expect(step.after.fingerprint).toBe(step.before.fingerprint);
          }
        }
      }),
    );
  });

  it('acquire results are self-consistent', () => {
    fc.assert(
      fc.property(fc.array(event, { maxLength: 40 }), (events) => {
        for (const step of run(events)) {
          if (!isAcquireResult(step.result)) continue;
          const r = step.result;
          expect(r.record.status).toBe(r.status === 'completed' ? 'completed' : 'in-flight');
          expect(step.after).toBe(r.record);
        }
      }),
    );
  });
});
