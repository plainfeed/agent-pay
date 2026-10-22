// Small helpers: random ids, SHA-256, HMAC and canonical JSON (sorted keys, so hashes and
// signatures do not depend on property order).

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

/** Short random id with a readable prefix, for example q_7f3k9m2x4c1a. */
export function newId(prefix: string, length = 12): string {
  const bytes = randomBytes(length);
  let s = '';
  for (const b of bytes) s += ALPHABET[b & 31];
  return `${prefix}_${s}`;
}

/** A long random secret, for agent keys and receipt signing. */
export function newSecret(prefix: string): string {
  return `${prefix}_${randomBytes(24).toString('base64url')}`;
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function hmac(secret: string, text: string): string {
  return createHmac('sha256', secret).update(text).digest('base64url');
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** JSON with object keys sorted at every level. Undefined values are dropped, as JSON.stringify does. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}
