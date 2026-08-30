# API

Packages: `@mohadjillani/idempotency-kit` (core + `./express`), `@mohadjillani/idempotency-kit-redis`, `@mohadjillani/idempotency-kit-mongodb`. All are ESM and CommonJS with type declarations. Node 20 or newer.

## Core: `@mohadjillani/idempotency-kit`

### `createIdempotency<T>(options): Idempotency<T>`

`T` is whatever a handler produces and the store keeps (the Express binding uses `CapturedResponse`).

| Option                | Type                                  | Default      | Notes                                                                                                                                 |
| --------------------- | ------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `store`               | `IdempotencyStore<T>`                 | —            | Required.                                                                                                                             |
| `ttlMs`               | `number`                              | `86_400_000` | How long a key is remembered. Must be positive.                                                                                       |
| `lockTtlMs`           | `number`                              | `30_000`     | How long an in-flight key blocks others before it can be taken over. Must be shorter than `ttlMs`. Set it above your slowest handler. |
| `onConflict`          | `'reject' \| 'wait'`                  | `'reject'`   | Same key while the first request runs: report it, or wait for the result.                                                             |
| `wait.timeoutMs`      | `number`                              | `5_000`      | Give up waiting and report `in-flight`. Wall-clock time.                                                                              |
| `wait.pollIntervalMs` | `number`                              | `25`         | How often a waiter re-checks the store.                                                                                               |
| `shouldStore`         | `(response: T) => boolean`            | `() => true` | `false` releases the key instead of storing the response.                                                                             |
| `failOpen`            | `boolean`                             | `false`      | When `acquire` throws: `false` reports `store-unavailable`, `true` runs the handler unprotected.                                      |
| `onStoreError`        | `(error, { key, operation }) => void` | no-op        | Called for every store failure (`acquire`, `complete`, `release`) whichever way `failOpen` is set.                                    |
| `now`                 | `() => number`                        | `Date.now`   | Only used for the `retryAfterMs` hint; stores keep their own clocks.                                                                  |

Throws `IdempotencyConfigError` for TTLs or wait bounds that cannot work.

### `idempotency.handle(key, fingerprint, execute): Promise<Outcome<T>>`

Runs `execute` at most once per key and returns what happened:

```ts
type Outcome<T> =
  | { outcome: 'executed'; response: T; stored: boolean }
  | { outcome: 'replayed'; response: T; record: CompletedRecord<T> }
  | { outcome: 'in-flight'; retryAfterMs: number; record: InFlightRecord }
  | { outcome: 'mismatch'; record: InFlightRecord | CompletedRecord<T> }
  | { outcome: 'store-unavailable'; error: unknown };
```

If `execute` throws, the key is released and the error is rethrown. `key` must be a non-empty string (`TypeError` otherwise); the caller decides what a valid key looks like. See [SEMANTICS.md](SEMANTICS.md) for every row.

`idempotency.options` exposes the resolved options, including the store.

### `MemoryStore<T>`

```ts
new MemoryStore({ now?: () => number; sweepIntervalMs?: number });
```

A `Map` driven by the pure transition functions; atomic within one process. `sweepIntervalMs` (default 60 s, `0` to disable) bounds memory by dropping expired keys on a timer that does not hold the process open; expiry is also applied on every read. `sweep()` runs it by hand, `size` reports held keys, `close()` stops the timer and clears the map.

### `fingerprint(parts: unknown): string` and `canonicalize(value): string`

SHA-256 hex of the canonical JSON of `parts` — object keys sorted at every depth, `undefined` dropped, `Date` as ISO, `Buffer` as base64. Pick the parts deliberately: include the caller's identity when keys are shared across tenants; leave out volatile fields (client timestamps, trace ids).

### `state`

The transition functions (`acquire`, `complete`, `release`, `expire`, `isLockExpired`) and `ABSENT`, exported as a namespace for stores and tests that want to reuse the exact semantics.

### The store contract

```ts
interface IdempotencyStore<T> {
  acquire(key, fingerprint, { keyTtlMs, lockTtlMs }): Promise<AcquireResult<T>>;
  complete(key, token, response: T): Promise<boolean>;
  release(key, token): Promise<boolean>;
  get(key): Promise<IdempotencyRecord<T> | undefined>;
  close?(): Promise<void>;
}

type AcquireResult<T> =
  | { status: 'acquired'; record: InFlightRecord }
  | { status: 'in-flight'; record: InFlightRecord }
  | { status: 'completed'; record: CompletedRecord<T> };
```

`acquire` is one atomic step: claim an absent key (or one whose key or lock TTL has passed) and return `acquired`, or return the current record without touching it. Every record carries the `fingerprint` stored on first claim and a `token` minted per claim; `complete` and `release` succeed only for the caller holding the current token and return `false` otherwise. Implement a new backend by making `packages/store-contract` pass — it is the same suite the memory, Redis and MongoDB stores run.

Records:

```ts
interface InFlightRecord {
  status: 'in-flight';
  key;
  fingerprint;
  token;
  createdAt;
  expiresAt;
  lockExpiresAt;
}
interface CompletedRecord<T> {
  status: 'completed';
  key;
  fingerprint;
  token;
  createdAt;
  expiresAt;
  completedAt;
  response: T;
}
```

Timestamps are epoch milliseconds.

## Express: `@mohadjillani/idempotency-kit/express`

Requires `express@^5` (optional peer dependency). Mount after the body parser and before the handlers it protects.

### `idempotency(options): RequestHandler`

Every core option above, plus:

| Option          | Type                                      | Default                                              | Notes                                                                                          |
| --------------- | ----------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `header`        | `string`                                  | `'Idempotency-Key'`                                  |                                                                                                |
| `required`      | `boolean`                                 | `false`                                              | `true` answers `400` when the header is missing; `false` lets the request through unprotected. |
| `methods`       | `string[]`                                | `['POST', 'PATCH']`                                  | Other methods pass through untouched.                                                          |
| `validateKey`   | `(key: string) => boolean`                | 1–255 printable ASCII, no spaces                     | Rejected keys get `400`.                                                                       |
| `scope`         | `(req) => string \| undefined`            | unscoped                                             | Namespace, usually the authenticated caller. Stored key becomes `${scope}:${key}`.             |
| `fingerprint`   | `(req) => string`                         | `defaultFingerprint` (method, `originalUrl`, `body`) |                                                                                                |
| `shouldStore`   | `(response: CapturedResponse) => boolean` | `status < 500`                                       | `false` releases the key so the client's retry runs the handler again.                         |
| `replayHeaders` | `(name: string) => boolean`               | `defaultReplayHeaders`                               | Drops `Connection`, `Keep-Alive`, `Transfer-Encoding`, `Content-Length`, `Date`, `Set-Cookie`. |
| `render`        | `(problem, req, res) => void`             | `defaultRender`                                      | JSON `{ error, message }` plus `Retry-After` when the problem carries one.                     |

`defaultValidateKey`, `defaultFingerprint`, `defaultReplayHeaders` and `defaultRender` are exported so an override can wrap the default rather than replace it.

### `CapturedResponse`

```ts
{
  status: number;
  headers: Record<string, string>;
  body: string;
  encoding: 'utf8' | 'base64';
}
```

Everything written through `res.write`/`res.end` is captured, including streamed writes; bodies that are not valid UTF-8 are stored base64-encoded. The whole body is buffered, so this is not for streaming or very large responses.

### `IdempotencyProblem`

```ts
{ status: 400 | 409 | 422 | 503; code: ProblemCode; message: string; retryAfterSeconds?: number }
```

## Redis: `@mohadjillani/idempotency-kit-redis`

```ts
import { Redis } from 'ioredis';
import { RedisStore } from '@mohadjillani/idempotency-kit-redis';

const store = new RedisStore(new Redis(process.env.REDIS_URL), { prefix: 'idem:' });
```

Peer dependencies: `ioredis@^5 || ^6`. The client is yours: connection lifecycle, TLS, reconnection and `quit()` stay in the application. One hash per key under `prefix`, expired by Redis (`PEXPIRE`) with the lock expiry stored inside the hash. `acquire`, `complete` and `release` are Lua scripts loaded with `EVALSHA` and an `EVAL` fallback after a restart or `SCRIPT FLUSH`. Timestamps are taken from the client's clock. Options: `prefix` (default `idem:`), `now`.

## MongoDB: `@mohadjillani/idempotency-kit-mongodb`

```ts
import { MongoClient } from 'mongodb';
import { MongoStore } from '@mohadjillani/idempotency-kit-mongodb';

const client = await MongoClient.connect(process.env.MONGODB_URL);
const store = new MongoStore(client.db('app').collection('idempotency_keys'));
await store.ensureIndexes(); // optional; also runs lazily on first acquire
```

Peer dependencies: `mongodb@^6 || ^7`. One document per key with `_id` as the key, so uniqueness is the collection's own index. `acquire` is a `findOneAndUpdate` upsert followed, only when the existing document's key or lock TTL has passed, by a takeover update conditioned on the old token. `ensureIndexes()` creates a TTL index on `expiresAt`; because that index runs about once a minute, expiry is also checked on every read. Options: `now`.
