# @mohadjillani/idempotency-kit-redis

## 0.1.0

### Minor Changes

- bbab11f: First release. Core: `createIdempotency` with the absent → in-flight → completed state machine, atomic token-fenced store contract, `reject` and `wait` conflict policies, fingerprint mismatch detection, release on handler failure, and fail-closed store errors with a `failOpen` option; `MemoryStore`; the `./express` middleware with byte-for-byte response capture and replay. Redis store with single-script Lua transitions; MongoDB store with upsert acquire and a TTL index.
