# express-payments

A fake payments API protected by `@mohadjillani/idempotency-kit`. `POST /charges` appends to an in-memory ledger after a simulated gateway round trip; the middleware is what keeps a retried request from appending twice.

```sh
npm run demo          # from the repository root: builds, then runs the scripted double submit
npm start -w examples/express-payments   # serves on :3000 with the memory store
REDIS_URL=redis://127.0.0.1:6379 npm start -w examples/express-payments
```

Magic sources: `tok_declined` returns 402 (kept and replayed), `tok_gateway_down` returns 502 (released, so a retry runs the handler again).
