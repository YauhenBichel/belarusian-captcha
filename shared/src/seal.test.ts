import { describe, expect, it } from 'vitest';
import { base64urlDecode, base64urlEncode } from './encoding.js';
import { KeyRing } from './keys.js';
import { SealError, seal, sealKid, unseal } from './seal.js';
import { testMasters, testRing } from './test-helpers.js';

async function reason(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'opened';
  } catch (e) {
    return e instanceof SealError ? e.reason : `other: ${String(e)}`;
  }
}

describe('sealed values (AES-256-GCM)', () => {
  it('round-trips and hides the content', async () => {
    const ring = testRing();
    const value = { cid: 'abc', answer: 'secret-answer-hash', level: 3 };
    const sealed = await seal(ring, value);
    expect(sealed).toMatch(/^k1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/);
    expect(sealed).not.toContain('secret');
    expect(await unseal(ring, sealed)).toEqual(value);
    expect(sealKid(sealed)).toBe('k1');
  });

  it('uses a fresh IV each time', async () => {
    const ring = testRing();
    expect(await seal(ring, 1)).not.toBe(await seal(ring, 1));
  });

  it('refuses any flipped byte', async () => {
    const ring = testRing();
    const [kid, iv, ct] = (await seal(ring, { a: 1 })).split('.') as [string, string, string];
    const bytes = base64urlDecode(ct);
    bytes[0] = (bytes[0] as number) ^ 1;
    expect(await reason(unseal(ring, `${kid}.${iv}.${base64urlEncode(bytes)}`))).toBe('bad-seal');
    const ivb = base64urlDecode(iv);
    ivb[0] = (ivb[0] as number) ^ 1;
    expect(await reason(unseal(ring, `${kid}.${base64urlEncode(ivb)}.${ct}`))).toBe('bad-seal');
  });

  it('refuses a seal relabelled to another kid, or from another ring', async () => {
    const masters = testMasters(['k1', 'k2']);
    const ring = new KeyRing('k1', masters);
    const sealed = await seal(ring, { a: 1 });
    expect(await reason(unseal(ring, sealed.replace(/^k1/, 'k2')))).toBe('bad-seal');
    expect(await reason(unseal(testRing(), sealed))).toBe('bad-seal');
  });

  it('accepts an old kid during a rotation and refuses it once removed', async () => {
    const masters = testMasters(['k1', 'k2']);
    const old = await seal(new KeyRing('k1', masters), 'x');
    const rotated = new KeyRing('k2', masters);
    expect(await unseal(rotated, old)).toBe('x');
    expect(sealKid(await seal(rotated, 'y'))).toBe('k2');
    const k2only = new KeyRing(
      'k2',
      new Map([['k2', masters.get('k2') as Uint8Array<ArrayBuffer>]]),
    );
    expect(await reason(unseal(k2only, old))).toBe('unknown-kid');
  });

  it('refuses malformed input', async () => {
    const ring = testRing();
    for (const bad of [
      '',
      'a.b',
      'k1.!!.xx',
      'bad kid.aaaa.bbbb',
      'k1.AAAA.AAAA',
      'x'.repeat(5000),
    ]) {
      expect(await reason(unseal(ring, bad))).toBe('malformed');
    }
  });
});
