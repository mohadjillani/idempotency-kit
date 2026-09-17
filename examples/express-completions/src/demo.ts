import { randomUUID } from 'node:crypto';
import { MemoryStore } from '@mohadjillani/idempotency-kit';
import { createApp } from './app.js';
import { MockProvider } from './provider.js';

/**
 * Scripted retries against an in-process server, printing what each one cost.
 *
 * The column that matters is `billed`: it is the running token count at the
 * provider, so a replayed row leaves it unchanged.
 */
const provider = new MockProvider({ tokenLatencyMs: 20 });
const app = createApp({ store: new MemoryStore({ sweepIntervalMs: 0 }), provider });
const server = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));
const address = server.address();
const base = `http://127.0.0.1:${String(typeof address === 'object' && address ? address.port : 0)}`;

interface Row {
  scenario: string;
  status: number;
  replayed: boolean;
  billed: number;
  answer: string;
}

async function complete(scenario: string, key: string, prompt: string): Promise<Row> {
  const res = await fetch(`${base}/v1/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify({ prompt }),
  });
  const text = await res.text();
  const tokens = [...text.matchAll(/event: token\ndata: (\{.*?\})/g)].map(
    (match) => (JSON.parse(match[1] ?? '{}') as { text?: string }).text ?? '',
  );
  return {
    scenario,
    status: res.status,
    replayed: res.headers.get('idempotent-replayed') === 'true',
    billed: provider.tokensBilled,
    answer: tokens.length > 0 ? tokens.join(' ') : text.slice(0, 40).replaceAll('\n', ' '),
  };
}

const rows: Row[] = [];
const prompt = 'why is the sky blue';

const k1 = randomUUID();
rows.push(await complete('first call', k1, prompt));
rows.push(await complete('retry, same key (replay)', k1, prompt));
rows.push(await complete('same prompt, new key', randomUUID(), prompt));

const k2 = randomUUID();
rows.push(await complete('provider overloaded', k2, '__overloaded__'));
rows.push(await complete('retry after overload', k2, '__overloaded__'));

const k3 = randomUUID();
rows.push(await complete('content refused', k3, '__refused__'));
rows.push(await complete('retry after refusal (replay)', k3, '__refused__'));

const width = Math.max(...rows.map((row) => row.scenario.length));
console.log(`${'scenario'.padEnd(width)}  status  replayed  billed  answer`);
for (const row of rows) {
  console.log(
    `${row.scenario.padEnd(width)}  ${String(row.status).padEnd(6)}  ${(row.replayed ? 'yes' : '-').padEnd(8)}  ${String(row.billed).padEnd(6)}  ${row.answer}`,
  );
}
console.log(
  `\n${String(provider.calls)} provider call(s) for ${String(rows.length)} requests, ` +
    `${String(provider.tokensBilled)} tokens billed`,
);

server.closeAllConnections();
await new Promise<void>((resolve) => {
  server.close(() => {
    resolve();
  });
});
