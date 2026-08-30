// Smoke-test the built packages the way consumers load them: ESM import and
// CJS require through the package.json "exports" map, not through the
// workspace aliases the tests use.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const expected = {
  '@mohadjillani/idempotency-kit': ['createIdempotency', 'MemoryStore', 'fingerprint', 'state'],
  '@mohadjillani/idempotency-kit/express': ['idempotency', 'defaultFingerprint'],
  '@mohadjillani/idempotency-kit-redis': ['RedisStore'],
  '@mohadjillani/idempotency-kit-mongodb': ['MongoStore'],
};

let failures = 0;
for (const [specifier, names] of Object.entries(expected)) {
  const esm = await import(specifier);
  const cjs = require(specifier);
  for (const name of names) {
    for (const [kind, mod] of [
      ['esm', esm],
      ['cjs', cjs],
    ]) {
      if (typeof mod[name] === 'undefined') {
        console.error(`${specifier} (${kind}) does not export ${name}`);
        failures += 1;
      }
    }
  }
}
if (failures > 0) process.exit(1);
console.log('exports ok');
