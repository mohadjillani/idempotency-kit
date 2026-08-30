import { MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoStore, type IdempotencyDocument } from '@mohadjillani/idempotency-kit-mongodb';
import type { CapturedResponse } from '@mohadjillani/idempotency-kit/express';
import { describeRaceSuite, describeStoreContract } from 'idempotency-kit-store-contract';

/**
 * MONGODB_URL points at a real server (CI uses a mongo:7 service). Without it,
 * a local run starts mongodb-memory-server, which downloads a mongod binary
 * on first use; CI without the URL skips instead of downloading.
 */
const url = process.env.MONGODB_URL;
const useMemoryServer = !url && !process.env.CI;

if (!url && !useMemoryServer) {
  describe.skip('mongodb store (set MONGODB_URL to run against a live server)', () => {
    it('skipped: MONGODB_URL is not set and CI is set', () => undefined);
  });
} else {
  let client: MongoClient;
  let stop: () => Promise<void> = () => Promise.resolve();
  const dbName = `idem_test_${String(process.pid)}`;

  beforeAll(async () => {
    let uri = url;
    if (!uri) {
      const { MongoMemoryServer } = await import('mongodb-memory-server');
      const server = await MongoMemoryServer.create();
      uri = server.getUri();
      stop = () => server.stop().then(() => undefined);
    }
    client = await MongoClient.connect(uri);
  }, 120_000);

  afterAll(async () => {
    await client.db(dbName).dropDatabase();
    await client.close();
    await stop();
  });

  const collection = (name: string) => client.db(dbName).collection<IdempotencyDocument>(name);

  describeStoreContract('mongodb', {
    create: () => new MongoStore(collection('contract')),
    destroy: () => undefined,
  });

  describeRaceSuite('mongodb', {
    create: () => new MongoStore<CapturedResponse>(collection('race')),
    destroy: () => undefined,
  });

  describe('mongodb store specifics', () => {
    it('creates the ttl index once', async () => {
      const store = new MongoStore(collection('indexes'));
      await store.ensureIndexes();
      await store.acquire('k', 'fp', { keyTtlMs: 5_000, lockTtlMs: 1_000 });
      const indexes = await collection('indexes').indexes();
      const ttl = indexes.find((i) => i.name === 'idempotency_expiry');
      expect(ttl?.expireAfterSeconds).toBe(0);
      expect(ttl?.key).toEqual({ expiresAt: 1 });
    });

    it('stores dates, not numbers, so the ttl index applies', async () => {
      const store = new MongoStore(collection('dates'));
      const first = await store.acquire('k', 'fp', { keyTtlMs: 5_000, lockTtlMs: 1_000 });
      await store.complete('k', first.record.token, { status: 201 });
      const doc = await collection('dates').findOne({ _id: 'k' });
      expect(doc?.expiresAt).toBeInstanceOf(Date);
      expect(doc?.completedAt).toBeInstanceOf(Date);
      expect(doc?.lockExpiresAt).toBeUndefined();
      expect(doc?.response).toEqual({ status: 201 });
    });
  });
}
