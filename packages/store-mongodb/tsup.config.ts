import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node20',
  tsconfig: 'tsconfig.build.json',
  external: ['@mohadjillani/idempotency-kit', 'mongodb'],
});
