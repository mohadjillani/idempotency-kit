import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { MemoryStore } from '@mohadjillani/idempotency-kit';
import { createApp } from '../src/app.js';

const order = { amount: 1999, currency: 'usd', source: 'tok_visa' };

describe('express-payments example', () => {
  it('charges once for a double submit and replays the same charge', async () => {
    const { app, ledger } = createApp({
      store: new MemoryStore({ sweepIntervalMs: 0 }),
      gatewayLatencyMs: 5,
    });
    const first = await request(app)
      .post('/charges')
      .set('Idempotency-Key', 'k1')
      .send(order)
      .expect(201);
    const second = await request(app)
      .post('/charges')
      .set('Idempotency-Key', 'k1')
      .send(order)
      .expect(201);
    expect(second.body).toEqual(first.body);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(ledger).toHaveLength(1);
  });

  it('requires a key and validates the body', async () => {
    const { app } = createApp({
      store: new MemoryStore({ sweepIntervalMs: 0 }),
      gatewayLatencyMs: 5,
    });
    await request(app).post('/charges').send(order).expect(400);
    await request(app).post('/charges').set('Idempotency-Key', 'k2').send({}).expect(400);
  });

  it('does not keep a gateway failure but does keep a decline', async () => {
    const { app } = createApp({
      store: new MemoryStore({ sweepIntervalMs: 0 }),
      gatewayLatencyMs: 5,
    });
    await request(app)
      .post('/charges')
      .set('Idempotency-Key', 'k3')
      .send({ ...order, source: 'tok_gateway_down' })
      .expect(502);
    const retry = await request(app)
      .post('/charges')
      .set('Idempotency-Key', 'k3')
      .send({ ...order, source: 'tok_gateway_down' })
      .expect(502);
    expect(retry.headers['idempotent-replayed']).toBeUndefined();

    await request(app)
      .post('/charges')
      .set('Idempotency-Key', 'k4')
      .send({ ...order, source: 'tok_declined' })
      .expect(402);
    const replay = await request(app)
      .post('/charges')
      .set('Idempotency-Key', 'k4')
      .send({ ...order, source: 'tok_declined' })
      .expect(402);
    expect(replay.headers['idempotent-replayed']).toBe('true');
  });
});
