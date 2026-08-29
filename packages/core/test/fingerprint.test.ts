import { describe, expect, it } from 'vitest';
import { canonicalize, fingerprint } from '@mohadjillani/idempotency-kit';

describe('canonicalize', () => {
  it('sorts object keys at every depth', () => {
    expect(canonicalize({ b: 1, a: { d: 2, c: [{ z: 1, y: 2 }] } })).toBe(
      '{"a":{"c":[{"y":2,"z":1}],"d":2},"b":1}',
    );
  });

  it('drops undefined values and keeps null', () => {
    expect(canonicalize({ a: undefined, b: null })).toBe('{"b":null}');
  });

  it('renders dates and buffers deterministically', () => {
    expect(canonicalize({ at: new Date(0), raw: Buffer.from('hi') })).toBe(
      '{"at":"1970-01-01T00:00:00.000Z","raw":"aGk="}',
    );
  });
});

describe('fingerprint', () => {
  it('is stable across key order', () => {
    expect(fingerprint({ amount: 100, currency: 'usd' })).toBe(
      fingerprint({ currency: 'usd', amount: 100 }),
    );
  });

  it('changes when any part changes', () => {
    const base = fingerprint({ method: 'POST', path: '/charges', body: { amount: 100 } });
    expect(fingerprint({ method: 'POST', path: '/charges', body: { amount: 101 } })).not.toBe(base);
    expect(fingerprint({ method: 'PUT', path: '/charges', body: { amount: 100 } })).not.toBe(base);
  });

  it('is a 64-character hex digest', () => {
    expect(fingerprint('x')).toMatch(/^[0-9a-f]{64}$/);
  });
});
