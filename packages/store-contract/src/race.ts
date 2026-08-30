import { createServer } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { IdempotencyStore } from '@mohadjillani/idempotency-kit';
import { idempotency, type CapturedResponse } from '@mohadjillani/idempotency-kit/express';

export interface RaceSuiteOptions {
  create: () => Promise<IdempotencyStore<CapturedResponse>> | IdempotencyStore<CapturedResponse>;
  destroy?: (store: IdempotencyStore<CapturedResponse>) => Promise<void> | void;
  /** Simultaneous requests per run. Default 50. */
  concurrency?: number;
}

export interface RaceResult {
  policy: 'reject' | 'wait';
  executions: number;
  statuses: Record<string, number>;
  replayed: number;
  distinctBodies: number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Fire N identical requests at once (same key, same body) at an Express app
 * protected by the middleware and count what came back.
 */
export async function runRace(
  store: IdempotencyStore<CapturedResponse>,
  policy: 'reject' | 'wait',
  concurrency: number,
): Promise<RaceResult> {
  let executions = 0;
  const app = express();
  app.use(express.json());
  app.use(
    idempotency({
      store,
      onConflict: policy,
      ttlMs: 60_000,
      lockTtlMs: 10_000,
      wait: { timeoutMs: 10_000, pollIntervalMs: 10 },
    }),
  );
  app.post('/charges', (req, res) => {
    executions += 1;
    const n = executions;
    void sleep(100).then(() => {
      res.status(201).json({ id: `ch_${String(n)}`, ...(req.body as object) });
    });
  });

  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const key = `race-${policy}-${String(Date.now())}-${String(Math.random()).slice(2)}`;

  try {
    const responses = await Promise.all(
      Array.from({ length: concurrency }, async () => {
        const res = await fetch(`http://127.0.0.1:${String(port)}/charges`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'idempotency-key': key },
          body: JSON.stringify({ amount: 1999, currency: 'usd' }),
        });
        return {
          status: res.status,
          replayed: res.headers.get('idempotent-replayed') === 'true',
          body: await res.text(),
        };
      }),
    );
    const statuses: Record<string, number> = {};
    for (const r of responses) statuses[r.status] = (statuses[r.status] ?? 0) + 1;
    return {
      policy,
      executions,
      statuses,
      replayed: responses.filter((r) => r.replayed).length,
      distinctBodies: new Set(responses.filter((r) => r.status === 201).map((r) => r.body)).size,
    };
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    server.closeAllConnections();
  }
}

export function formatRace(name: string, r: RaceResult): string {
  const statuses = Object.entries(r.statuses)
    .sort()
    .map(([s, n]) => `${String(n)}x${s}`)
    .join(' ');
  return `race[${name}][${r.policy}]: ${String(r.executions)} execution, ${statuses}, ${String(r.replayed)} replayed`;
}

/**
 * The headline test: N concurrent requests with one key against a real HTTP
 * server, on a given store, execute the handler exactly once. With the reject
 * policy the other N-1 get 409; with the wait policy they get the replay.
 */
export function describeRaceSuite(name: string, options: RaceSuiteOptions): void {
  const concurrency = options.concurrency ?? 50;
  describe(`race: ${name}`, () => {
    let store: IdempotencyStore<CapturedResponse>;

    beforeAll(async () => {
      store = await options.create();
    });

    afterAll(async () => {
      if (options.destroy) await options.destroy(store);
      else await store.close?.();
    });

    it(`${String(concurrency)} concurrent same-key requests: one execution, the rest 409 (reject)`, async () => {
      const r = await runRace(store, 'reject', concurrency);
      console.log(formatRace(name, r));
      expect(r.executions).toBe(1);
      expect(r.statuses).toEqual({ '201': 1, '409': concurrency - 1 });
      expect(r.replayed).toBe(0);
    });

    it(`${String(concurrency)} concurrent same-key requests: one execution, the rest replayed (wait)`, async () => {
      const r = await runRace(store, 'wait', concurrency);
      console.log(formatRace(name, r));
      expect(r.executions).toBe(1);
      expect(r.statuses).toEqual({ '201': concurrency });
      expect(r.replayed).toBe(concurrency - 1);
      expect(r.distinctBodies).toBe(1);
    });
  });
}
