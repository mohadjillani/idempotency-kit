# Contributing

## Setup

```sh
git clone https://github.com/mohadjillani/idempotency-kit
cd idempotency-kit
npm ci
npm test
```

Node 20 or newer (`.nvmrc` pins the version CI publishes from). Tests and typechecking resolve the packages from source through workspace aliases, so no build is needed for development. The MongoDB suite starts `mongodb-memory-server` on a machine without `MONGODB_URL`, which downloads a `mongod` binary on first run.

## Layout

| Path                        | Contents                                                 |
| --------------------------- | -------------------------------------------------------- |
| `packages/core`             | State machine, `handle()`, memory store, Express binding |
| `packages/store-redis`      | Redis store (Lua scripts in `src/scripts.ts`)            |
| `packages/store-mongodb`    | MongoDB store                                            |
| `packages/store-contract`   | Private: the contract and race suites every store runs   |
| `examples/express-payments` | Runnable demo                                            |
| `bench`                     | Overhead benchmark                                       |
| `docs`                      | `SEMANTICS.md`, `API.md`, ADRs                           |

## Scripts

| Script                  | What it does                                                                           |
| ----------------------- | -------------------------------------------------------------------------------------- |
| `npm test`              | Every project with coverage; Redis and MongoDB suites read `REDIS_URL` / `MONGODB_URL` |
| `npm run lint`          | ESLint with type-aware rules across the workspace                                      |
| `npm run typecheck`     | `tsc --noEmit` across the workspace                                                    |
| `npm run format:check`  | Prettier                                                                               |
| `npm run build`         | tsup: ESM + CJS + declarations for the three published packages                        |
| `npm run check:exports` | Loads every built package through its exports map as ESM and CJS                       |
| `npm run demo`          | Builds, then runs the scripted double submit                                           |
| `npm run bench`         | Builds, then runs the autocannon benchmark                                             |

Local backends: `docker compose up -d`, then `REDIS_URL=redis://127.0.0.1:6379 MONGODB_URL=mongodb://127.0.0.1:27017 npm test`.

## Making a change

1. Branch from `main`.
2. Add or adjust tests with the change. A behaviour change must update the row in `docs/SEMANTICS.md`; a store change must keep the contract suite green on all three stores.
3. Run `npx changeset` when a published package changes and describe it from a user's point of view: `patch` for fixes, `minor` for new options, `major` for anything that changes an existing outcome.
4. Open a pull request. CI runs on Node 20, 22 and 24, plus an integration job with Redis and MongoDB.

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/) with a package scope where it helps: `feat(core):`, `fix(redis):`, `docs:`, `test:`, `ci:`, `chore:`.

## Adding a store

Implement `IdempotencyStore` (see `docs/API.md`), reuse the transition logic in `packages/core/src/state.ts` as the reference for what each operation must do atomically, and add a test that calls `describeStoreContract` and `describeRaceSuite` from `idempotency-kit-store-contract`. The suites are the definition of done.

## Releasing

Merging a pull request with a changeset makes the release workflow open (or update) a "Version Packages" pull request. Merging that publishes the changed packages to npm with provenance.
