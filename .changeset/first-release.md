---
'@mohadjillani/idempotency-kit': minor
'@mohadjillani/idempotency-kit-redis': minor
'@mohadjillani/idempotency-kit-mongodb': minor
---

First release. Core: `createIdempotency` with the absent → in-flight → completed state machine, atomic token-fenced store contract, `reject` and `wait` conflict policies, fingerprint mismatch detection, release on handler failure, and fail-closed store errors with a `failOpen` option; `MemoryStore`; the `./express` middleware with byte-for-byte response capture and replay. Redis store with single-script Lua transitions; MongoDB store with upsert acquire and a TTL index.
