import { MemoryStore } from '@mohadjillani/idempotency-kit';
import { describeRaceSuite } from 'idempotency-kit-store-contract';

describeRaceSuite('memory', {
  create: () => new MemoryStore({ sweepIntervalMs: 0 }),
});
