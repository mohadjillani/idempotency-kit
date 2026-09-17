import { MemoryStore } from '@mohadjillani/idempotency-kit';
import { createApp } from './app.js';
import { MockProvider } from './provider.js';

const port = Number(process.env.PORT ?? 3000);
// The memory store is enough to show the behaviour; swap in the Redis store
// when you want the replay to survive a restart or to be shared across
// replicas, which is what a real deployment needs.
const app = createApp({ store: new MemoryStore(), provider: new MockProvider() });

const server = app.listen(port, () => {
  console.log(`completions example listening on http://localhost:${String(port)}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    server.close(() => {
      process.exit(0);
    });
  });
}
