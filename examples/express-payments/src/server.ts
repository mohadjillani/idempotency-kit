import { createApp } from './app.js';
import { createStore } from './store.js';

const port = Number(process.env.PORT ?? 3000);
const { name, store, close } = await createStore();
const { app } = createApp({ store });

const server = app.listen(port, () => {
  console.log(`payments example listening on http://localhost:${String(port)} (store: ${name})`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    server.close(() => {
      void close().then(() => process.exit(0));
    });
  });
}
