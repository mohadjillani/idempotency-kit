import { MemoryStore } from '@mohadjillani/idempotency-kit';
import { describeStoreContract } from 'idempotency-kit-store-contract';

describeStoreContract('memory', {
  create: () => new MemoryStore({ sweepIntervalMs: 0 }),
});
