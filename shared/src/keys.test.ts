import { describe, expect, it } from 'vitest';
import { randomBytes } from './crypto.js';
import { base64Encode } from './encoding.js';
import { KeyRing } from './keys.js';

const k = () => base64Encode(randomBytes(32));

describe('KeyRing', () => {
  it('parses a key file and derives distinct, stable purpose keys', async () => {
    const ring = KeyRing.fromJson(JSON.stringify({ active: 'k2', keys: { k1: k(), k2: k() } }));
    expect(ring.active).toBe('k2');
    expect(ring.has('k1')).toBe(true);
    const a = await ring.keys('k1');
    const b = await ring.keys('k2');
    expect(a?.pow).toMatch(/^[0-9a-f]{64}$/);
    expect(a?.pow).not.toBe(b?.pow);
    expect(await ring.keys('k1')).toBe(a);
    expect(ring.keys('nope')).toBeUndefined();
  });

  it('refuses bad key files', () => {
    expect(() => KeyRing.fromJson('{}')).toThrow();
    expect(() => KeyRing.fromJson(JSON.stringify({ active: 'k9', keys: { k1: k() } }))).toThrow(
      /active/,
    );
    const short = base64Encode(randomBytes(16));
    expect(() => KeyRing.fromJson(JSON.stringify({ active: 'k1', keys: { k1: short } }))).toThrow(
      /32 bytes/,
    );
    expect(() => KeyRing.fromJson(JSON.stringify({ active: 'a b', keys: { 'a b': k() } }))).toThrow(
      /key id/,
    );
    expect(() => KeyRing.fromJson(JSON.stringify({ active: 'k1', keys: { k1: 5 } }))).toThrow();
  });
});
