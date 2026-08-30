# 0002 — Atomic acquire as the store contract

**Status:** accepted · **Date:** 2026-08-29

## Context

The obvious store interface is `get(key)` and `set(key, record)`: read the key, and if it is absent, write an in-flight record and run the handler. Under concurrency that is exactly the bug the library exists to prevent. Two requests read "absent" in the same millisecond, both write, both run — the double charge, now with an idempotency key attached.

Any correct implementation needs a check-and-claim that cannot interleave. Where that lives decides how portable and how testable the rest of the library is.

## Decision

The store contract is a single `acquire(key, fingerprint, ttl)` that claims the key or reports who holds it, in one operation, plus `complete` and `release`. Each backend implements atomicity with its own primitive: the memory store never awaits inside `acquire`; Redis runs one Lua script; MongoDB uses a `findOneAndUpdate` upsert on `_id`. Lock takeover after the lock TTL is part of the same operation.

Every claim mints a token, and `complete` and `release` only succeed for the current token. A caller whose lock expired while it was still running cannot overwrite the result of the caller that took the key over.

## Consequences

- The core never reasons about races; it maps one atomic result to an outcome. The state machine is pure and property-tested, and the same contract suite runs against all three stores, so a backend cannot pass while being subtly non-atomic — the fifty-way concurrent acquire test is in the suite.
- Backends must implement the whole transition, not just storage, which makes a new store a few dozen lines of careful code rather than two trivial methods. The reference for that logic is `packages/core/src/state.ts`.
- A lock that expires under a slow handler still causes a second execution; the fencing token only decides whose response is kept. `lockTtlMs` therefore has to be longer than the slowest legitimate handler, and the README says so.
