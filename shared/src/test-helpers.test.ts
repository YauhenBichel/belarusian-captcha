import { describe, expect, it } from 'vitest';
import { randomBytes } from './crypto.js';
import { base64urlDecode, base64urlEncode } from './encoding.js';
import { flipLastByte } from './test-helpers.js';

describe('flipLastByte', () => {
  it('always changes the decoded bytes of the last segment, and only those', () => {
    // Seal ciphertexts and token MACs come in every length mod 3; cover all three.
    for (let n = 16; n <= 48; n++) {
      for (let i = 0; i < 30; i++) {
        const bytes = randomBytes(n);
        const value = `k1.head.${base64urlEncode(bytes)}`;
        const out = flipLastByte(value);
        expect(out.startsWith('k1.head.')).toBe(true);
        const changed = base64urlDecode(out.slice('k1.head.'.length));
        expect(changed.length).toBe(n);
        expect(changed.slice(0, -1)).toEqual(bytes.slice(0, -1));
        expect(changed[n - 1]).toBe((bytes[n - 1] as number) ^ 1);
      }
    }
  });

  it('catches the case a text edit misses: a 32-byte MAC ending in "AB"', () => {
    // The old test swapped the last two characters for "AA". Here the last character carries 4
    // real bits, so "AB" and "AA" decode to the same 32 bytes and the "tampered" token was valid.
    const mac = new Uint8Array(32);
    const text = `${base64urlEncode(mac).slice(0, -1)}B`;
    expect(base64urlDecode(text)).toEqual(base64urlDecode(`${text.slice(0, -2)}AA`));
    expect(base64urlDecode(flipLastByte(`k1.p.${text}`).split('.')[2] as string)).not.toEqual(
      base64urlDecode(text),
    );
  });
});
