import { randomUUID } from 'node:crypto';
import type {
  AcquireResult,
  AcquireTtl,
  IdempotencyRecord,
  IdempotencyStore,
} from '@mohadjillani/idempotency-kit';
import type { Collection, MongoServerError } from 'mongodb';

export interface MongoStoreOptions {
  /** Clock for TTL arithmetic. Defaults to `Date.now`. */
  now?: () => number;
}

/** Shape of a stored document. `_id` is the idempotency key, so uniqueness is the collection's own index. */
export interface IdempotencyDocument {
  _id: string;
  status: 'in-flight' | 'completed';
  fingerprint: string;
  token: string;
  createdAt: Date;
  expiresAt: Date;
  lockExpiresAt?: Date;
  completedAt?: Date;
  response?: unknown;
}

const DUPLICATE_KEY = 11000;

/**
 * MongoDB-backed store. Acquire is a `findOneAndUpdate` upsert keyed on
 * `_id`: the insert path claims an absent key atomically, and a second
 * conditional update takes over a document whose lock or key has expired,
 * matched on the old token so two takeovers cannot both succeed. A TTL index
 * on `expiresAt` removes forgotten keys; expiry is also checked on read
 * because that index runs about once a minute.
 */
export class MongoStore<T = unknown> implements IdempotencyStore<T> {
  private readonly now: () => number;
  private indexes: Promise<void> | undefined;

  constructor(
    private readonly collection: Collection<IdempotencyDocument>,
    options: MongoStoreOptions = {},
  ) {
    this.now = options.now ?? Date.now;
  }

  /** Create the TTL index. Called lazily on first use; call it at boot to fail early. */
  ensureIndexes(): Promise<void> {
    this.indexes ??= this.collection
      .createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'idempotency_expiry' })
      .then(() => undefined);
    return this.indexes;
  }

  async acquire(key: string, fingerprint: string, ttl: AcquireTtl): Promise<AcquireResult<T>> {
    await this.ensureIndexes();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const now = this.now();
      const fresh = this.claim(key, fingerprint, ttl, now);

      let existing: IdempotencyDocument | null;
      try {
        existing = await this.collection.findOneAndUpdate(
          { _id: key },
          { $setOnInsert: fresh },
          { upsert: true, returnDocument: 'before' },
        );
      } catch (error) {
        // Two upserts raced for the same _id; the loser re-reads on the next pass.
        if ((error as MongoServerError).code === DUPLICATE_KEY) continue;
        throw error;
      }
      if (!existing) return this.acquired(fresh);

      const expired = existing.expiresAt.getTime() <= now;
      const lockExpired =
        existing.status === 'in-flight' && (existing.lockExpiresAt?.getTime() ?? 0) <= now;
      if (expired || lockExpired) {
        const taken = await this.collection.findOneAndUpdate(
          { _id: key, token: existing.token },
          { $set: fresh, $unset: { completedAt: '', response: '' } },
          { returnDocument: 'after' },
        );
        if (taken) return this.acquired(taken);
        continue; // someone else took it over first
      }

      const record = this.toRecord(existing);
      return record.status === 'completed'
        ? { status: 'completed', record }
        : { status: 'in-flight', record };
    }
    throw new Error('mongodb store: acquire lost the race five times in a row');
  }

  async complete(key: string, token: string, response: T): Promise<boolean> {
    const result = await this.collection.updateOne(
      { _id: key, status: 'in-flight', token },
      {
        $set: { status: 'completed', response, completedAt: new Date(this.now()) },
        $unset: { lockExpiresAt: '' },
      },
    );
    return result.matchedCount === 1;
  }

  async release(key: string, token: string): Promise<boolean> {
    const result = await this.collection.deleteOne({ _id: key, status: 'in-flight', token });
    return result.deletedCount === 1;
  }

  async get(key: string): Promise<IdempotencyRecord<T> | undefined> {
    const doc = await this.collection.findOne({ _id: key });
    if (!doc || doc.expiresAt.getTime() <= this.now()) return undefined;
    return this.toRecord(doc);
  }

  private acquired(doc: IdempotencyDocument): AcquireResult<T> {
    const record = this.toRecord(doc);
    if (record.status !== 'in-flight')
      throw new Error('mongodb store claimed a completed document');
    return { status: 'acquired', record };
  }

  private claim(
    key: string,
    fingerprint: string,
    ttl: AcquireTtl,
    now: number,
  ): IdempotencyDocument {
    return {
      _id: key,
      status: 'in-flight',
      fingerprint,
      token: randomUUID(),
      createdAt: new Date(now),
      expiresAt: new Date(now + ttl.keyTtlMs),
      lockExpiresAt: new Date(now + ttl.lockTtlMs),
    };
  }

  private toRecord(doc: IdempotencyDocument): IdempotencyRecord<T> {
    const base = {
      key: doc._id,
      fingerprint: doc.fingerprint,
      token: doc.token,
      createdAt: doc.createdAt.getTime(),
      expiresAt: doc.expiresAt.getTime(),
    };
    if (doc.status === 'completed') {
      return {
        ...base,
        status: 'completed',
        completedAt: doc.completedAt?.getTime() ?? base.createdAt,
        response: doc.response as T,
      };
    }
    return { ...base, status: 'in-flight', lockExpiresAt: doc.lockExpiresAt?.getTime() ?? 0 };
  }
}
