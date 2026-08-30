# Security

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting on this repository (Security → Report a vulnerability) rather than a public issue. Reports are acknowledged within a few days.

## Keys

An idempotency key is chosen by the client and names a stored response. Anyone who can present the key within its TTL receives that response. Two things follow:

- **Keys must be unguessable.** Generate them with `crypto.randomUUID()` or equivalent (122 bits of entropy). Sequential or derived keys (`order-123`, a hash of the cart) let a caller replay someone else's response by guessing.
- **Keys must be scoped to the caller.** Use the `scope` option so the stored key is `${accountId}:${key}`. Without it a key is global to the endpoint: a second tenant presenting the same key would receive the first tenant's stored response (or a `422` that confirms the key exists). The middleware accepts up to 255 printable ASCII characters and rejects anything else with `400`.

## Fingerprints

Only a SHA-256 hash of the request identity is stored, never the request body. The default fingerprint covers method, URL and the parsed body; a custom `fingerprint` should include the caller's identity if `scope` is not used, and should leave out fields that legitimately vary between retries (client timestamps, trace ids), otherwise retries are answered `422`.

## What the store holds

Completed responses are stored verbatim: status, headers and body. If a response contains sensitive data, the store does too, for the whole TTL. Treat the Redis or MongoDB instance accordingly (network isolation, authentication, encryption at rest as for the primary database), keep TTLs as short as the client's retry window allows, and consider `shouldStore` to skip responses that must not be persisted.

`Set-Cookie` is never replayed: a session issued once is not re-issued to whoever presents the key. Hop-by-hop headers are dropped as well. `replayHeaders` can narrow the list further, for example to `Content-Type` only.

## Availability

By default the middleware fails closed: when the store is unreachable it answers `503` and does not run the handler. This is deliberate for anything that moves money or sends messages. Endpoints that opt into `failOpen: true` lose duplicate protection for the duration of the outage and should be chosen with that in mind.

## Supply chain

Releases are published from GitHub Actions with npm provenance, so each package page shows the commit and workflow that produced it. The core package has no runtime dependencies; the store packages depend only on their driver as a peer.
