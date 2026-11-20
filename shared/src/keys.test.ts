import { describe, expect, it } from 'vitest';
import { randomBytes } from './crypto.js';
import { base64Encode, base64urlEncode } from './encoding.js';
import { KeyFileError, KeyRing } from './keys.js';

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

  it.each([
    ['not JSON', '{"active": "k1", "keys": {"k1": "SECRETISH', /not valid JSON/],
    ['an array', '[]', /key file must be/],
    ['null', 'null', /key file must be/],
    [
      'keys as an array of objects',
      JSON.stringify({ active: 'k1', keys: [{ kid: 'k1', key: k() }] }),
      /"keys" must be a mapping/,
    ],
    ['empty keys', JSON.stringify({ active: 'k1', keys: {} }), /"keys" is empty/],
    ['no active', JSON.stringify({ keys: { k1: k() } }), /"active"/],
    [
      'an unknown field',
      JSON.stringify({ active: 'k1', keys: { k1: k() }, extra: 1 }),
      /unknown field "extra"/,
    ],
  ])('refuses %s with a KeyFileError', (_name, json, msg) => {
    expect(() => KeyRing.fromJson(json)).toThrow(KeyFileError);
    expect(() => KeyRing.fromJson(json)).toThrow(msg);
  });

  it('names the kid of a key that is not base64, and never echoes the key', () => {
    const bad = 'not*base64!value-that-is-long-enough-to-be-a-key';
    let err: unknown;
    try {
      KeyRing.fromJson(JSON.stringify({ active: 'k1', keys: { k1: k(), k2: bad } }));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(KeyFileError);
    expect((err as KeyFileError).kid).toBe('k2');
    expect((err as KeyFileError).name).toBe('KeyFileError');
    expect((err as Error).message).toBe('key "k2" is not valid base64');
    expect((err as Error).message).not.toContain(bad);
  });

  it('does not quote the file in a JSON syntax error', () => {
    expect(() => KeyRing.fromJson('{"keys": {"k1": "AAAAplaceholderAAAA"')).toThrow(
      /^key file is not valid JSON$/,
    );
  });

  it('accepts base64url keys as well as standard base64', () => {
    const ring = KeyRing.fromJson(
      JSON.stringify({ active: 'k1', keys: { k1: base64urlEncode(randomBytes(32)) } }),
    );
    expect(ring.has('k1')).toBe(true);
    // 34 bytes of 0xfb: 46 base64url characters, some "-" and "_"; padded to 48 with "==".
    const urlKey = base64urlEncode(new Uint8Array(34).fill(0xfb));
    expect(urlKey).toMatch(/[-_]/);
    for (const v of [urlKey, `${urlKey}==`]) {
      expect(KeyRing.fromJson(JSON.stringify({ active: 'k1', keys: { k1: v } })).has('k1')).toBe(
        true,
      );
    }
  });
});
