import { randomUUID } from 'node:crypto';
import { createApp } from './app.js';
import { createStore } from './store.js';

/**
 * Scripted double submit against an in-process server. Prints one line per
 * request so the outcome matrix can be read off the terminal.
 */
const { name, store, close } = await createStore();
const { app, ledger } = createApp({ store, gatewayLatencyMs: 150 });
const server = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));
const address = server.address();
const base = `http://127.0.0.1:${String(typeof address === 'object' && address ? address.port : 0)}`;

interface Row {
  scenario: string;
  status: number;
  replayed: boolean;
  retryAfter: string | null;
  body: string;
}

async function charge(scenario: string, key: string, body: object): Promise<Row> {
  const res = await fetch(`${base}/charges`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as Record<string, unknown>;
  return {
    scenario,
    status: res.status,
    replayed: res.headers.get('idempotent-replayed') === 'true',
    retryAfter: res.headers.get('retry-after'),
    body: typeof json.id === 'string' ? json.id : String(json.error),
  };
}

const rows: Row[] = [];
const order = { amount: 1999, currency: 'usd', source: 'tok_visa' };

console.log(`store: ${name}\n`);

const k1 = randomUUID();
rows.push(await charge('first submit', k1, order));
rows.push(await charge('retry after response (replay)', k1, order));
rows.push(await charge('same key, different amount', k1, { ...order, amount: 2999 }));

const k2 = randomUUID();
const [a, b] = await Promise.all([
  charge('double click, request 1', k2, order),
  charge('double click, request 2', k2, order),
]);
rows.push(a, b);

const k3 = randomUUID();
rows.push(await charge('gateway down (not kept)', k3, { ...order, source: 'tok_gateway_down' }));
rows.push(await charge('retry after gateway down', k3, { ...order, source: 'tok_gateway_down' }));

const k4 = randomUUID();
rows.push(await charge('declined card (kept)', k4, { ...order, source: 'tok_declined' }));
rows.push(await charge('retry after decline (replay)', k4, { ...order, source: 'tok_declined' }));

rows.push(await charge('missing key', '', order));

const width = Math.max(...rows.map((r) => r.scenario.length));
console.log(`${'scenario'.padEnd(width)}  status  replayed  retry-after  result`);
for (const r of rows) {
  console.log(
    `${r.scenario.padEnd(width)}  ${String(r.status).padEnd(6)}  ${(r.replayed ? 'yes' : '-').padEnd(8)}  ${(r.retryAfter ?? '-').padEnd(11)}  ${r.body}`,
  );
}
console.log(
  `\nledger has ${String(ledger.length)} charge(s) after ${String(rows.length)} requests`,
);

server.closeAllConnections();
await new Promise<void>((resolve) => {
  server.close(() => {
    resolve();
  });
});
await close();
