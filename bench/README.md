# Overhead benchmark

`bench/run.ts` measures what the Express middleware costs on a trivial `POST /charges` JSON endpoint with the memory store, using [autocannon](https://github.com/mcollina/autocannon). Three runs, each after a one-second warm-up:

- **baseline** — the endpoint with no middleware.
- **unique key per request** — every request acquires and completes a fresh key: fingerprint hashing, one `acquire`, response capture, one `complete`. This is the worst case.
- **replay of one key** — every request hits a key that is already completed and is served from the store without running the handler.

```sh
npm run bench                      # BENCH_DURATION=10 BENCH_CONNECTIONS=20
BENCH_DURATION=30 BENCH_CONNECTIONS=50 npm run bench
```

The `handler runs` column is counted inside the route; it is what proves the replay run never reached the handler.

## Last run

Machine: Apple M1, 8 GB, darwin 25.6.0, Node v23.4.0 (local run, laptop on battery)
Command: `BENCH_DURATION=10 BENCH_CONNECTIONS=20 npm run bench`

| Scenario                           | requests | handler runs | req/s | p50 ms | p99 ms | vs baseline | non-2xx | errors |
| ---------------------------------- | -------: | -----------: | ----: | -----: | -----: | ----------: | ------: | -----: |
| baseline (no middleware)           |   114660 |       114673 | 11466 |    1.0 |    2.0 |        100% |       0 |      0 |
| middleware, unique key per request |    91946 |        91960 |  9195 |    1.0 |    3.0 |         80% |       0 |      0 |
| middleware, replay of one key      |   128095 |            0 | 11645 |    1.0 |    2.0 |        102% |       0 |      0 |

Reading it: with the in-process store the middleware costs about a fifth of the throughput of an endpoint that does nothing else, which is the upper bound of its share — a real handler that talks to a database or a payment gateway dwarfs it. Replays are as cheap as the baseline because the handler and its body parsing are skipped. Redis and MongoDB stores add a network round trip per `acquire` and `complete` on top; measure those with the store you deploy, on the machine you deploy to. The requests-versus-handler-runs difference of a few units is the warm-up's in-flight requests completing after the counter reset.
