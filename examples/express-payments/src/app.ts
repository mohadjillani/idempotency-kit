import { randomUUID } from 'node:crypto';
import express, { type Express, type Request, type Response } from 'express';
import type { IdempotencyStore } from '@mohadjillani/idempotency-kit';
import { idempotency, type CapturedResponse } from '@mohadjillani/idempotency-kit/express';

export interface Charge {
  id: string;
  amount: number;
  currency: string;
  source: string;
  status: 'succeeded';
  createdAt: string;
}

export interface AppOptions {
  store: IdempotencyStore<CapturedResponse>;
  /** Simulated gateway latency in milliseconds. Default 200. */
  gatewayLatencyMs?: number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * A fake payments API. `POST /charges` "charges" a card by appending to an
 * in-memory ledger after a simulated gateway round trip; the idempotency
 * middleware is what keeps a retried request from appending twice.
 *
 * Two magic sources exercise the error rules: `tok_declined` answers 402
 * (kept and replayed, because the decline is deterministic) and
 * `tok_gateway_down` answers 502 (not kept, so a retry runs again).
 */
export function createApp(options: AppOptions): { app: Express; ledger: Charge[] } {
  const ledger: Charge[] = [];
  const latency = options.gatewayLatencyMs ?? 200;
  const app = express();

  app.use(express.json());
  app.use(
    '/charges',
    idempotency({
      store: options.store,
      required: true,
      ttlMs: 24 * 60 * 60 * 1000,
      lockTtlMs: 10_000,
      onStoreError: (error, context) => {
        console.error(`idempotency store ${context.operation} failed`, error);
      },
    }),
  );

  app.post('/charges', async (req: Request, res: Response) => {
    const body = req.body as Partial<Pick<Charge, 'amount' | 'currency' | 'source'>>;
    const amount = body.amount ?? 0;
    if (!Number.isInteger(amount) || amount <= 0 || !body.currency || !body.source) {
      res.status(400).json({
        error: 'invalid_request',
        message: 'amount, currency and source are required',
      });
      return;
    }

    await sleep(latency);

    if (body.source === 'tok_gateway_down') {
      res
        .status(502)
        .json({ error: 'gateway_unavailable', message: 'The card network did not respond' });
      return;
    }
    if (body.source === 'tok_declined') {
      res.status(402).json({ error: 'card_declined', message: 'The card was declined' });
      return;
    }

    const charge: Charge = {
      id: `ch_${randomUUID().replaceAll('-', '').slice(0, 24)}`,
      amount,
      currency: body.currency,
      source: body.source,
      status: 'succeeded',
      createdAt: new Date().toISOString(),
    };
    ledger.push(charge);
    res.status(201).json(charge);
  });

  app.get('/charges', (_req, res) => {
    res.json({ data: ledger, count: ledger.length });
  });

  return { app, ledger };
}
