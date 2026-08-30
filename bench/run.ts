import { createServer, type Server } from 'node:http';
import os from 'node:os';
import autocannon, { type Request } from 'autocannon';
import express from 'express';
import { MemoryStore } from '@mohadjillani/idempotency-kit';
import { idempotency } from '@mohadjillani/idempotency-kit/express';

/**
 * Overhead of the middleware on a trivial JSON endpoint with the memory store.
 * Three runs of BENCH_DURATION seconds each:
 *   baseline     no middleware
 *   unique keys  every request acquires and completes a fresh key (worst case)
 *   replay       every request hits one completed key and is replayed
 *
 *   npm run bench            (BENCH_DURATION=10 BENCH_CONNECTIONS=20 by default)
 */
const duration = Number(process.env.BENCH_DURATION ?? 10);
const connections = Number(process.env.BENCH_CONNECTIONS ?? 20);
const body = JSON.stringify({ amount: 1999, currency: 'usd', source: 'tok_visa' });

interface Counters {
  executions: number;
}

function build(withMiddleware: boolean, counters: Counters): Server {
  const app = express();
  app.use(express.json());
  if (withMiddleware) app.use(idempotency({ store: new MemoryStore(), lockTtlMs: 10_000 }));
  app.post('/charges', (req, res) => {
    counters.executions += 1;
    res.status(201).json({ id: 'ch_bench', ...(req.body as object) });
  });
  return createServer(app);
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return `http://127.0.0.1:${String(typeof address === 'object' && address ? address.port : 0)}/charges`;
}

interface Row {
  name: string;
  requests: number;
  executions: number;
  rps: number;
  p50: number;
  p99: number;
  non2xx: number;
  errors: number;
}

async function run(
  name: string,
  withMiddleware: boolean,
  key: (n: number) => string | undefined,
): Promise<Row> {
  const counters: Counters = { executions: 0 };
  const server = build(withMiddleware, counters);
  const url = await listen(server);
  let counter = 0;
  const setupRequest = (req: Request): Request => {
    const k = key((counter += 1));
    return k === undefined ? req : { ...req, headers: { ...req.headers, 'idempotency-key': k } };
  };
  const requests = [
    {
      method: 'POST' as const,
      headers: { 'content-type': 'application/json' },
      body,
      setupRequest,
    },
  ];
  // Warm up the JIT (and, for the replay run, complete the shared key first).
  await autocannon({ url, connections: 5, duration: 1, requests });
  counters.executions = 0;
  const result = await autocannon({ url, connections, duration, requests });
  server.closeAllConnections();
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  return {
    name,
    requests: result.requests.total,
    executions: counters.executions,
    rps: result.requests.average,
    p50: result.latency.p50,
    p99: result.latency.p99,
    non2xx: result.non2xx,
    errors: result.errors,
  };
}

const rows: Row[] = [];
rows.push(await run('baseline (no middleware)', false, () => undefined));
rows.push(await run('middleware, unique key per request', true, (n) => `bench-${String(n)}`));
rows.push(await run('middleware, replay of one key', true, () => 'bench-replay'));

const baseline = rows[0]?.rps ?? 1;
console.log(
  `\nMachine: ${os.cpus()[0]?.model ?? 'unknown cpu'}, ${String(Math.round(os.totalmem() / 2 ** 30))} GB, ${os.platform()} ${os.release()}, Node ${process.version}`,
);
console.log(
  `Command: BENCH_DURATION=${String(duration)} BENCH_CONNECTIONS=${String(connections)} npm run bench\n`,
);
console.log(
  '| Scenario | requests | handler runs | req/s | p50 ms | p99 ms | vs baseline | non-2xx | errors |',
);
console.log('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
for (const r of rows) {
  const ratio = `${((r.rps / baseline) * 100).toFixed(0)}%`;
  console.log(
    `| ${r.name} | ${String(r.requests)} | ${String(r.executions)} | ${r.rps.toFixed(0)} | ${r.p50.toFixed(1)} | ${r.p99.toFixed(1)} | ${ratio} | ${String(r.non2xx)} | ${String(r.errors)} |`,
  );
}
