import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const pkg = (path: string) => fileURLToPath(new URL(path, import.meta.url));

// The Redis and MongoDB suites skip without a backend, so those stores only
// count towards coverage when one is configured. Locally the MongoDB suite
// falls back to mongodb-memory-server unless CI is set (see its test file).
const withoutRedis = !process.env.REDIS_URL;
const withoutMongo = !process.env.MONGODB_URL && Boolean(process.env.CI);

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@mohadjillani\/idempotency-kit\/express$/,
        replacement: pkg('./packages/core/src/express.ts'),
      },
      {
        find: /^@mohadjillani\/idempotency-kit$/,
        replacement: pkg('./packages/core/src/index.ts'),
      },
      {
        find: /^@mohadjillani\/idempotency-kit-redis$/,
        replacement: pkg('./packages/store-redis/src/index.ts'),
      },
      {
        find: /^@mohadjillani\/idempotency-kit-mongodb$/,
        replacement: pkg('./packages/store-mongodb/src/index.ts'),
      },
      {
        find: /^idempotency-kit-store-contract$/,
        replacement: pkg('./packages/store-contract/src/index.ts'),
      },
    ],
  },
  test: {
    projects: [
      {
        extends: true,
        test: { name: 'core', root: 'packages/core', include: ['test/**/*.test.ts'] },
      },
      {
        extends: true,
        test: { name: 'redis', root: 'packages/store-redis', include: ['test/**/*.test.ts'] },
      },
      {
        extends: true,
        test: { name: 'mongodb', root: 'packages/store-mongodb', include: ['test/**/*.test.ts'] },
      },
      {
        extends: true,
        test: {
          name: 'example',
          root: 'examples/express-payments',
          include: ['test/**/*.test.ts'],
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      // store-contract is test code; types.ts has no runtime statements.
      exclude: [
        'packages/store-contract/**',
        'packages/core/src/types.ts',
        ...(withoutRedis ? ['packages/store-redis/**'] : []),
        ...(withoutMongo ? ['packages/store-mongodb/**'] : []),
      ],
      thresholds: { lines: 90, functions: 95, branches: 80, statements: 90 },
    },
  },
});
