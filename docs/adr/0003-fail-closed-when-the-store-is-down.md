# 0003 — Fail closed when the store is down

**Status:** accepted · **Date:** 2026-08-29

## Context

Redis restarts, a MongoDB primary steps down, a security group changes. For a few seconds `acquire` throws. The middleware has to do something with the request in its hand: run the handler without protection, or refuse.

Availability instinct says run it. The library's one promise says otherwise: it exists so that a retry never produces a second charge, and a retry is most likely exactly when infrastructure is misbehaving.

## Decision

By default a store error on `acquire` produces `store-unavailable` (`503` in Express) and the handler does not run. `failOpen: true` opts an endpoint into running unprotected, with `stored: false` so the caller can tell. `onStoreError` is called either way so the failure is never silent.

Errors on `complete` after the handler has run are reported and tolerated: the effect already happened, refusing the response would only make the client retry. Errors on `release` are logged; the lock TTL eventually clears the key.

## Consequences

- During a store outage, protected endpoints return `503` instead of double-executing. Clients that already handle `Retry-After` on `409` handle this the same way.
- `failOpen` is the right choice for endpoints where a duplicate is cheap and a refusal is expensive — an analytics event, a cache warm-up — and the wrong choice for anything that moves money or sends email. The README says which is which.
- The store becomes a hard dependency of protected endpoints, which is an honest description: an idempotency layer that degrades to nothing under load is not one.
