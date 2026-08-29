import { createHash } from 'node:crypto';

/**
 * Canonical JSON: object keys sorted recursively so `{a:1,b:2}` and `{b:2,a:1}`
 * hash the same. `undefined` values are dropped, as `JSON.stringify` would.
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    if (value instanceof Date) return value.toISOString();
    if (Buffer.isBuffer(value)) return value.toString('base64');
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const v = source[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

/**
 * SHA-256 over the canonical form of whatever identifies "the same request".
 * Only the hash is stored, so the store never holds request bodies.
 *
 * Which parts count is a product decision: the default Express fingerprint
 * uses method, path, and body. Add the caller's identity if keys are shared
 * across tenants, or leave out volatile fields such as client timestamps.
 */
export function fingerprint(parts: unknown): string {
  return createHash('sha256').update(canonicalize(parts)).digest('hex');
}
