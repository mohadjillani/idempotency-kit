# 0001 — Reject by default for concurrent same-key requests

**Status:** accepted · **Date:** 2026-08-29

## Context

Two requests with the same idempotency key can arrive while the first is still running: a double click, a mobile client retrying on a timeout it set too low, a load balancer retrying a request the upstream had actually received. Whatever the cause, only one of them may execute. The question is what the second one gets.

Two reasonable answers exist. Make it wait for the first and hand it the same response, so the client never sees a difference. Or answer immediately with a conflict and a hint about when to retry.

## Decision

`onConflict: 'reject'` is the default. The second request gets `409` with `Retry-After` set to the seconds left on the first request's lock. `onConflict: 'wait'` exists and is bounded by `wait.timeoutMs`; when the budget runs out it produces the same `409`.

## Consequences

- A concurrent duplicate is a client bug or a retry policy that is too aggressive. `409` makes it visible in the client's logs and in the server's metrics; silently waiting would hide it.
- Waiting holds a connection and a worker slot for as long as the first request takes, and a burst of duplicates becomes a burst of pollers against the store. Rejecting costs one store call.
- `409` plus `Retry-After` is what the major payment APIs do for this case, so client libraries already know how to handle it.
- The wait policy is there for clients that genuinely cannot retry (a browser form submit, a webhook sender that treats non-2xx as failure). Its polling loop also covers the abandoned-lock case: if the first request's process dies, the waiter takes the key over and executes instead of waiting for nothing.
