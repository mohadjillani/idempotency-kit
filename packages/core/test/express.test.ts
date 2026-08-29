import express, { type Express, type Request, type Response } from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '@mohadjillani/idempotency-kit';
import {
  idempotency,
  type CapturedResponse,
  type ExpressIdempotencyOptions,
} from '@mohadjillani/idempotency-kit/express';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface Harness {
  app: Express;
  store: MemoryStore<CapturedResponse>;
  calls: number;
}

function harness(
  options: Partial<ExpressIdempotencyOptions> = {},
  route?: (req: Request, res: Response) => void | Promise<void>,
): Harness {
  const store = new MemoryStore<CapturedResponse>({ sweepIntervalMs: 0 });
  const h: Harness = { app: express(), store, calls: 0 };
  h.app.use(express.json());
  h.app.use(idempotency({ store, ...options }));
  h.app.post('/charges', (req, res, next) => {
    h.calls += 1;
    if (route) {
      Promise.resolve(route(req, res)).catch(next);
      return;
    }
    res
      .status(201)
      .set('X-Charge', 'yes')
      .json({ id: `ch_${String(h.calls)}`, ...req.body });
  });
  h.app.get('/charges', (_req, res) => {
    h.calls += 1;
    res.json({ list: true });
  });
  h.app.use((err: Error, _req: Request, res: Response, _next: express.NextFunction) => {
    res.status(500).json({ error: err.message });
  });
  return h;
}

const KEY = 'a1b2c3d4-0000-4000-8000-000000000001';
const json = (res: request.Response) => res.body as Record<string, unknown>;

describe('express binding: keys', () => {
  it('lets requests without a key through unprotected by default', async () => {
    const h = harness();
    await request(h.app).post('/charges').send({ amount: 1 }).expect(201);
    await request(h.app).post('/charges').send({ amount: 1 }).expect(201);
    expect(h.calls).toBe(2);
  });

  it('rejects a missing key with 400 when required', async () => {
    const h = harness({ required: true });
    const res = await request(h.app).post('/charges').send({ amount: 1 }).expect(400);
    expect(res.body).toEqual({
      error: 'idempotency_key_missing',
      message: 'The Idempotency-Key header is required for this request.',
    });
    expect(h.calls).toBe(0);
  });

  it('rejects malformed keys with 400', async () => {
    const h = harness();
    for (const bad of ['', 'has space', 'x'.repeat(256), 'ünïcode']) {
      const res = await request(h.app)
        .post('/charges')
        .set('Idempotency-Key', bad)
        .send({})
        .expect(400);
      expect(json(res).error).toBe('idempotency_key_invalid');
    }
    expect(h.calls).toBe(0);
  });

  it('accepts a custom header name and validator', async () => {
    const h = harness({ header: 'X-Request-Id', validateKey: (k) => k.startsWith('req_') });
    await request(h.app).post('/charges').set('X-Request-Id', 'nope').send({}).expect(400);
    await request(h.app).post('/charges').set('X-Request-Id', 'req_1').send({}).expect(201);
  });

  it('ignores methods it is not configured for', async () => {
    const h = harness();
    await request(h.app).get('/charges').set('Idempotency-Key', KEY).expect(200);
    await request(h.app).get('/charges').set('Idempotency-Key', KEY).expect(200);
    expect(h.calls).toBe(2);
    expect(await h.store.get(KEY)).toBeUndefined();
  });

  it('namespaces keys with scope', async () => {
    const h = harness({ scope: (req) => req.get('X-User') });
    const a = await request(h.app)
      .post('/charges')
      .set('Idempotency-Key', KEY)
      .set('X-User', 'alice')
      .send({ amount: 1 })
      .expect(201);
    const b = await request(h.app)
      .post('/charges')
      .set('Idempotency-Key', KEY)
      .set('X-User', 'bob')
      .send({ amount: 1 })
      .expect(201);
    expect(json(a).id).not.toBe(json(b).id);
    expect(h.calls).toBe(2);
    expect(await h.store.get(`alice:${KEY}`)).toBeDefined();
  });
});

describe('express binding: outcomes', () => {
  it('replays a completed request without running the handler', async () => {
    const h = harness();
    const first = await request(h.app)
      .post('/charges')
      .set('Idempotency-Key', KEY)
      .send({ amount: 100 })
      .expect(201);
    const second = await request(h.app)
      .post('/charges')
      .set('Idempotency-Key', KEY)
      .send({ amount: 100 })
      .expect(201);
    expect(h.calls).toBe(1);
    expect(second.body).toEqual(first.body);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(first.headers['idempotent-replayed']).toBeUndefined();
  });

  it('answers 409 with Retry-After while the first request is in flight', async () => {
    const h = harness({ lockTtlMs: 3_000 }, async (_req, res) => {
      await sleep(80);
      res.status(201).json({ ok: true });
    });
    const first = request(h.app)
      .post('/charges')
      .set('Idempotency-Key', KEY)
      .send({})
      .then((r) => r);
    await sleep(20);
    const second = await request(h.app)
      .post('/charges')
      .set('Idempotency-Key', KEY)
      .send({})
      .expect(409);
    expect(second.headers['retry-after']).toBe('3');
    expect(json(second).error).toBe('idempotency_key_in_flight');
    expect((await first).status).toBe(201);
    expect(h.calls).toBe(1);
  });

  it('answers 422 when the key is reused with a different body', async () => {
    const h = harness();
    await request(h.app)
      .post('/charges')
      .set('Idempotency-Key', KEY)
      .send({ amount: 100 })
      .expect(201);
    const res = await request(h.app)
      .post('/charges')
      .set('Idempotency-Key', KEY)
      .send({ amount: 999 })
      .expect(422);
    expect(json(res).error).toBe('idempotency_key_reused');
    expect(h.calls).toBe(1);
  });

  it('treats the same body with different key order as the same request', async () => {
    const h = harness();
    await request(h.app)
      .post('/charges')
      .set('Idempotency-Key', KEY)
      .send({ amount: 100, currency: 'usd' })
      .expect(201);
    await request(h.app)
      .post('/charges')
      .set('Idempotency-Key', KEY)
      .send({ currency: 'usd', amount: 100 })
      .expect(201);
    expect(h.calls).toBe(1);
  });

  it('answers 503 and does not run the handler when the store is down', async () => {
    const onStoreError = vi.fn();
    const h = harness({ onStoreError });
    vi.spyOn(h.store, 'acquire').mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const res = await request(h.app)
      .post('/charges')
      .set('Idempotency-Key', KEY)
      .send({})
      .expect(503);
    expect(json(res).error).toBe('idempotency_store_unavailable');
    expect(h.calls).toBe(0);
    expect(onStoreError).toHaveBeenCalledTimes(1);
  });

  it('runs unprotected with failOpen when the store is down', async () => {
    const h = harness({ failOpen: true });
    vi.spyOn(h.store, 'acquire').mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await request(h.app).post('/charges').set('Idempotency-Key', KEY).send({}).expect(201);
    expect(h.calls).toBe(1);
    expect(await h.store.get(KEY)).toBeUndefined();
  });

  it('waits for the first request and replays with onConflict: wait', async () => {
    const h = harness({ onConflict: 'wait', wait: { pollIntervalMs: 5 } }, async (_req, res) => {
      await sleep(60);
      res.status(201).json({ ok: true });
    });
    const [a, b] = await Promise.all([
      request(h.app).post('/charges').set('Idempotency-Key', KEY).send({}),
      request(h.app).post('/charges').set('Idempotency-Key', KEY).send({}),
    ]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect([a.headers['idempotent-replayed'], b.headers['idempotent-replayed']]).toContain('true');
    expect(h.calls).toBe(1);
  });
});
