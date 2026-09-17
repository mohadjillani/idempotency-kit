import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { MemoryStore } from '@mohadjillani/idempotency-kit';
import { createApp } from '../src/app.js';
import { MockProvider } from '../src/provider.js';

const build = () => {
  const provider = new MockProvider({ tokenLatencyMs: 0 });
  const app = createApp({ store: new MemoryStore({ sweepIntervalMs: 0 }), provider });
  return { app, provider };
};

const post = (app: ReturnType<typeof build>['app'], key: string, prompt: string) =>
  request(app).post('/v1/completions').set('Idempotency-Key', key).send({ prompt });

describe('express-completions example', () => {
  it('replays the stream instead of generating a second completion', async () => {
    const { app, provider } = build();

    const first = await post(app, 'k1', 'why is the sky blue').expect(200);
    const second = await post(app, 'k1', 'why is the sky blue').expect(200);

    expect(second.text).toBe(first.text);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(provider.calls).toBe(1);
  });

  it('charges nothing for the replay', async () => {
    const { app, provider } = build();

    await post(app, 'k1', 'why is the sky blue');
    const afterFirst = provider.costInHundredthsOfACent;
    await post(app, 'k1', 'why is the sky blue');

    expect(provider.costInHundredthsOfACent).toBe(afterFirst);
    expect(afterFirst).toBeGreaterThan(0);
  });

  it('would have produced a different answer without the key', async () => {
    const { app } = build();

    const first = await post(app, 'k1', 'why is the sky blue').expect(200);
    const other = await post(app, 'k2', 'why is the sky blue').expect(200);

    // The provider samples, so this is what a retry costs when it is not
    // replayed: a second bill for an answer the caller never asked to change.
    expect(other.text).not.toBe(first.text);
  });

  it('replays the usage event, so the recorded cost matches the first call', async () => {
    const { app } = build();

    const first = await post(app, 'k1', 'count to four').expect(200);
    const second = await post(app, 'k1', 'count to four').expect(200);

    const usage = (body: string): string | undefined =>
      body.split('\n').find((line) => line.includes('promptTokens'));

    expect(usage(second.text)).toBe(usage(first.text));
    expect(usage(first.text)).toBeDefined();
  });

  it('does not store a provider overload, so the retry reaches the provider', async () => {
    const { app, provider } = build();

    await post(app, 'k1', '__overloaded__').expect(503);
    await post(app, 'k1', '__overloaded__').expect(503);

    expect(provider.calls).toBe(2);
  });

  it('stores a content refusal, so the retry does not pay for it again', async () => {
    const { app, provider } = build();

    await post(app, 'k1', '__refused__').expect(400);
    const second = await post(app, 'k1', '__refused__').expect(400);

    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(provider.calls).toBe(1);
  });

  it('rejects the same key carrying a different prompt', async () => {
    const { app, provider } = build();

    await post(app, 'k1', 'why is the sky blue').expect(200);
    await post(app, 'k1', 'why is the sea blue').expect(422);

    expect(provider.calls).toBe(1);
  });

  it('requires a key', async () => {
    const { app } = build();
    await request(app).post('/v1/completions').send({ prompt: 'hello' }).expect(400);
  });
});
