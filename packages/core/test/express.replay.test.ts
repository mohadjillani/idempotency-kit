import { createServer } from 'node:http';
import express, { type Express, type Request, type Response } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { MemoryStore } from '@mohadjillani/idempotency-kit';
import {
  defaultReplayHeaders,
  idempotency,
  type CapturedResponse,
  type ExpressIdempotencyOptions,
} from '@mohadjillani/idempotency-kit/express';

const KEY = 'replay-0000-4000-8000-000000000001';
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function app(
  options: Partial<ExpressIdempotencyOptions>,
  route: (req: Request, res: Response, calls: number) => void | Promise<void>,
): { app: Express; store: MemoryStore<CapturedResponse>; calls: () => number } {
  const store = new MemoryStore<CapturedResponse>({ sweepIntervalMs: 0 });
  let calls = 0;
  const a = express();
  a.use(express.json());
  a.use(idempotency({ store, ...options }));
  a.post('/op', (req, res, next) => {
    calls += 1;
    Promise.resolve(route(req, res, calls)).catch(next);
  });
  a.use((err: Error, _req: Request, res: Response, _next: express.NextFunction) => {
    res.status(500).json({ error: err.message });
  });
  return { app: a, store, calls: () => calls };
}

const post = (a: Express, body: unknown = {}) =>
  request(a)
    .post('/op')
    .set('Idempotency-Key', KEY)
    .send(body as object);

describe('express replay fidelity', () => {
  it('replays status, headers and body exactly', async () => {
    const h = app({}, (_req, res, n) => {
      res
        .status(202)
        .set('Location', '/ops/1')
        .set('X-Call', String(n))
        .type('text/plain')
        .send('accepted');
    });
    const first = await post(h.app).expect(202);
    const second = await post(h.app).expect(202);
    expect(second.text).toBe('accepted');
    expect(second.headers.location).toBe('/ops/1');
    expect(second.headers['x-call']).toBe('1');
    expect(second.headers['content-type']).toBe(first.headers['content-type']);
    expect(second.headers['content-length']).toBe(first.headers['content-length']);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(h.calls()).toBe(1);
  });

  it('captures streamed writes', async () => {
    const h = app({}, (_req, res) => {
      res.status(200).type('text/plain');
      res.write('part-1,');
      res.write(Buffer.from('part-2,'));
      res.end('part-3');
    });
    await post(h.app).expect(200);
    const replay = await post(h.app).expect(200);
    expect(replay.text).toBe('part-1,part-2,part-3');
    expect(h.calls()).toBe(1);
  });

  it('round-trips bytes that are not valid utf-8', async () => {
    const bytes = Buffer.from([0xff, 0xfe, 0x00, 0x89, 0x50, 0x4e, 0x47]);
    const h = app({}, (_req, res) => {
      res.status(200).type('application/octet-stream').end(bytes);
    });
    await post(h.app).expect(200);
    const record = await h.store.get(KEY);
    expect(record?.status === 'completed' && record.response.encoding).toBe('base64');
    const replay = await post(h.app).buffer().parse(binaryParser).expect(200);
    expect(Buffer.compare(replay.body as Buffer, bytes)).toBe(0);
  });

  it('does not keep 5xx responses, so a retry runs the handler again', async () => {
    const h = app({}, (_req, res, n) => {
      if (n === 1) res.status(502).json({ error: 'gateway' });
      else res.status(201).json({ ok: true });
    });
    await post(h.app).expect(502);
    expect(await h.store.get(KEY)).toBeUndefined();
    await post(h.app).expect(201);
    const replay = await post(h.app).expect(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(h.calls()).toBe(2);
  });

  it('does not keep thrown errors either', async () => {
    const h = app({}, (_req, res, n) => {
      if (n === 1) throw new Error('boom');
      res.status(201).json({ ok: true });
    });
    const res = await post(h.app).expect(500);
    expect(res.body).toEqual({ error: 'boom' });
    await post(h.app).expect(201);
    expect(h.calls()).toBe(2);
  });

  it('keeps 4xx responses by default', async () => {
    const h = app({}, (_req, res) => {
      res.status(400).json({ error: 'card_declined' });
    });
    await post(h.app).expect(400);
    const replay = await post(h.app).expect(400);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(h.calls()).toBe(1);
  });

  it('lets shouldStore exclude 4xx responses', async () => {
    const h = app({ shouldStore: (r) => r.status < 400 }, (_req, res) => {
      res.status(400).json({ error: 'try_again' });
    });
    await post(h.app).expect(400);
    await post(h.app).expect(400);
    expect(h.calls()).toBe(2);
  });

  it('never replays Set-Cookie or hop-by-hop headers', async () => {
    const h = app({}, (_req, res) => {
      res.cookie('session', 'abc').status(201).json({ ok: true });
    });
    const first = await post(h.app).expect(201);
    expect(first.headers['set-cookie']).toBeDefined();
    const replay = await post(h.app).expect(201);
    expect(replay.headers['set-cookie']).toBeUndefined();
    expect(defaultReplayHeaders('Transfer-Encoding')).toBe(false);
    expect(defaultReplayHeaders('Content-Type')).toBe(true);
  });

  it('lets replayHeaders choose what comes back', async () => {
    const h = app({ replayHeaders: (name) => name === 'content-type' }, (_req, res) => {
      res.status(201).set('X-Secret', 'no').json({ ok: true });
    });
    await post(h.app).expect(201);
    const replay = await post(h.app).expect(201);
    expect(replay.headers['x-secret']).toBeUndefined();
    expect(replay.headers['content-type']).toMatch(/json/);
  });

  it('uses a custom render for problem responses', async () => {
    const h = app(
      {
        required: true,
        render: (problem, _req, res) => {
          res.status(problem.status).type('text/plain').send(`${problem.code}!`);
        },
      },
      (_req, res) => {
        res.status(201).json({ ok: true });
      },
    );
    const res = await request(h.app).post('/op').send({}).expect(400);
    expect(res.text).toBe('idempotency_key_missing!');
  });

  it('uses a custom fingerprint', async () => {
    const h = app(
      { fingerprint: (req) => String((req.body as { amount: number }).amount) },
      (_req, res) => {
        res.status(201).json({ ok: true });
      },
    );
    await post(h.app, { amount: 1, note: 'a' }).expect(201);
    await post(h.app, { amount: 1, note: 'b' }).expect(201);
    await post(h.app, { amount: 2, note: 'a' }).expect(422);
    expect(h.calls()).toBe(1);
  });

  it('releases the key when the client disconnects mid-handler', async () => {
    const h = app({}, async (_req, res) => {
      await sleep(150);
      res.status(201).json({ ok: true });
    });
    const server = createServer(h.app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const controller = new AbortController();
    const aborted = fetch(`http://127.0.0.1:${String(port)}/op`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': KEY },
      body: '{}',
      signal: controller.signal,
    });
    await sleep(30);
    controller.abort();
    await expect(aborted).rejects.toThrow();
    await sleep(200);
    expect(await h.store.get(KEY)).toBeUndefined();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  });
});

function binaryParser(res: request.Response, callback: (err: Error | null, body: Buffer) => void) {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer) => chunks.push(chunk));
  res.on('end', () => {
    callback(null, Buffer.concat(chunks));
  });
}
