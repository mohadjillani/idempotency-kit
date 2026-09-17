import express, { type Express, type Request, type Response } from 'express';
import type { IdempotencyStore } from '@mohadjillani/idempotency-kit';
import { idempotency, type CapturedResponse } from '@mohadjillani/idempotency-kit/express';
import { ContentRefused, ProviderOverloaded } from './provider.js';
import type { MockProvider } from './provider.js';

export interface AppOptions {
  store: IdempotencyStore<CapturedResponse>;
  provider: MockProvider;
}

/**
 * A completion endpoint that is safe to retry.
 *
 * `POST /v1/completions` streams a completion back as server-sent events. The
 * idempotency middleware captures the whole stream, so a retry with the same
 * key replays the identical bytes without calling the provider again.
 *
 * Two prompts exercise the error rules. A prompt containing `__overloaded__`
 * answers 503, which is **not** stored — a provider that was busy should be
 * asked again. One containing `__refused__` answers 400, which **is** stored,
 * because a content refusal is a property of the prompt and asking again just
 * pays for the same refusal.
 */
export function createApp(options: AppOptions): Express {
  const app = express();
  const { provider } = options;

  app.use(express.json());
  app.use(
    '/v1/completions',
    idempotency({
      store: options.store,
      required: true,
      ttlMs: 24 * 60 * 60 * 1000,
      // Longer than the slowest completion: the lock has to outlive the
      // stream, or a retry arriving mid-generation starts a second one.
      lockTtlMs: 60_000,
    }),
  );

  app.post('/v1/completions', async (req: Request, res: Response) => {
    const body = req.body as { prompt?: unknown };
    if (typeof body.prompt !== 'string' || body.prompt.length === 0) {
      res.status(400).json({ error: 'invalid_request', message: 'prompt is required' });
      return;
    }

    const stream = provider.stream(body.prompt);

    // The provider is only contacted on the first `next()`, so the failure
    // modes surface here rather than at the call above.
    let first;
    try {
      first = await stream.next();
    } catch (error) {
      if (error instanceof ProviderOverloaded) {
        res
          .status(503)
          .setHeader('Retry-After', String(error.retryAfterSeconds))
          .json({ error: 'provider_overloaded', message: error.message });
        return;
      }
      if (error instanceof ContentRefused) {
        res.status(400).json({ error: 'content_refused', message: error.message });
        return;
      }
      throw error;
    }

    // Nothing is written before this point, which is what lets the two error
    // paths above answer with a status at all. After the first byte the status
    // is committed and a mid-stream failure can only be reported in the body.
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');

    let next = first;
    while (!next.done) {
      res.write(`event: token\ndata: ${JSON.stringify({ text: next.value })}\n\n`);
      next = await stream.next();
    }

    const usage = next.value;
    res.write(`event: usage\ndata: ${JSON.stringify(usage)}\n\n`);
    res.end('data: [DONE]\n\n');
  });

  app.get('/v1/usage', (_req, res) => {
    res.json({
      calls: provider.calls,
      tokensBilled: provider.tokensBilled,
      costInHundredthsOfACent: provider.costInHundredthsOfACent,
    });
  });

  return app;
}
