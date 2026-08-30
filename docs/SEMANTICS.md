# Semantics

The definitive outcome matrix. Every row is covered by a test in `packages/core/test`; the property tests in `state.property.test.ts` reject any transition not listed in the state table at the bottom.

## Terms

- **Key** — the client-chosen idempotency key, scoped by the binding if a `scope` is configured.
- **Fingerprint** — a hash of what makes two requests "the same" (by default in Express: method, URL, body). Stored with the key on first use.
- **Key TTL** (`ttlMs`, default 24 h) — how long the key is remembered at all.
- **Lock TTL** (`lockTtlMs`, default 30 s) — how long an in-flight key blocks others before it counts as abandoned. Always shorter than the key TTL.

## Outcome matrix

| Key state when the request arrives  | Fingerprint | `onConflict`                | `handle()` outcome                                                                    | Express response                                                |
| ----------------------------------- | ----------- | --------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| absent (never seen, or TTL expired) | —           | any                         | `executed` — handler runs, key becomes completed                                      | whatever the handler sends                                      |
| in-flight, lock live                | same        | `reject`                    | `in-flight` with `retryAfterMs`                                                       | `409` + `Retry-After` (seconds until the lock expires)          |
| in-flight, lock live                | same        | `wait`                      | owner finishes → `replayed`                                                           | original response + `Idempotent-Replayed: true`                 |
|                                     |             |                             | owner abandons (lock expires) → `executed` (waiter takes over)                        | whatever the handler sends                                      |
|                                     |             |                             | `wait.timeoutMs` passes → `in-flight`                                                 | `409` + `Retry-After`                                           |
| in-flight, lock live                | different   | any                         | `mismatch`                                                                            | `422`                                                           |
| in-flight, lock expired             | any         | any                         | `executed` — the new request takes the key over; its fingerprint replaces the old one | whatever the handler sends                                      |
| completed                           | same        | any                         | `replayed`                                                                            | original status, headers and body + `Idempotent-Replayed: true` |
| completed                           | different   | any                         | `mismatch`                                                                            | `422`                                                           |
| store unreachable on `acquire`      | —           | `failOpen: false` (default) | `store-unavailable` — handler does not run                                            | `503`                                                           |
| store unreachable on `acquire`      | —           | `failOpen: true`            | `executed` with `stored: false` — handler runs unprotected                            | whatever the handler sends                                      |

## What happens after the handler runs

| Event                                                          | Key afterwards                               | Result                                                                                                                                 |
| -------------------------------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| handler returns and `shouldStore(response)` is true (default)  | completed                                    | `executed`, `stored: true`; later requests replay                                                                                      |
| handler returns and `shouldStore(response)` is false           | released (absent)                            | `executed`, `stored: false`; the next request runs the handler again. Express default: `status >= 500`                                 |
| handler throws                                                 | released (absent)                            | `handle()` rethrows; the next request runs the handler again. In Express the error handler's response is sent and, being 5xx, not kept |
| client disconnects before the response ends (Express)          | released (absent)                            | nothing is sent; the retry runs the handler again                                                                                      |
| `store.complete` throws                                        | in-flight until the lock TTL, then claimable | `executed`, `stored: false`, `onStoreError` called. The effect happened; a retry inside the lock TTL gets `409`, after it re-executes  |
| `complete` from a caller whose lock expired and was taken over | unchanged (owned by the newer execution)     | `executed`, `stored: false`. The fencing token stops the stale result from overwriting the newer one                                   |

## Express request handling before any of the above

| Condition                                         | `required: false` (default)   | `required: true`              |
| ------------------------------------------------- | ----------------------------- | ----------------------------- |
| method not in `methods` (default `POST`, `PATCH`) | pass through, no protection   | pass through                  |
| header absent                                     | pass through, no protection   | `400 idempotency_key_missing` |
| header present but fails `validateKey`            | `400 idempotency_key_invalid` | same                          |

Problem responses are JSON `{ "error": "<code>", "message": "..." }` unless `render` is overridden. Codes: `idempotency_key_missing`, `idempotency_key_invalid`, `idempotency_key_in_flight`, `idempotency_key_reused`, `idempotency_store_unavailable`.

## Headers on a replay

Everything the original response set is sent again except `Connection`, `Keep-Alive`, `Transfer-Encoding`, `Content-Length` (recomputed), `Date` (current) and `Set-Cookie` (a session issued once must not be re-issued). `replayHeaders` changes the list. `Idempotent-Replayed: true` is added.

## State table

The states of one key and every legal transition, as enforced by `packages/core/src/state.ts`:

| From      | Event                   | To        | Result                                      |
| --------- | ----------------------- | --------- | ------------------------------------------- |
| absent    | acquire                 | in-flight | `acquired`                                  |
| absent    | complete / release      | absent    | `false`                                     |
| in-flight | acquire, lock live      | in-flight | `in-flight` (unchanged)                     |
| in-flight | acquire, lock expired   | in-flight | `acquired` (new owner, new token, new TTLs) |
| in-flight | complete, token matches | completed | `true`                                      |
| in-flight | complete, token differs | in-flight | `false`                                     |
| in-flight | release, token matches  | absent    | `true`                                      |
| in-flight | release, token differs  | in-flight | `false`                                     |
| completed | acquire                 | completed | `completed` (unchanged)                     |
| completed | complete / release      | completed | `false`                                     |
| any       | key TTL passes          | absent    | —                                           |

Expiry is applied before every event: a key past its TTL is indistinguishable from an absent one.
