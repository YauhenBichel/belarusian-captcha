import { describe, expect, it } from 'vitest';
import { base64urlDecode, base64urlEncode, fromUtf8, utf8 } from './encoding.js';
import { KeyRing } from './keys.js';
import { testMasters, testRing } from './test-helpers.js';
import { issuePassToken, type PassTokenPayload, verifyPassToken } from './token.js';

const NOW = 1_800_000_000_000;
const payload: PassTokenPayload = {
  v: 1,
  tid: 'tid-1',
  sitekey: 'bc_pk_test',
  hostname: 'example.test',
  action: 'login',
  score: 1,
  iat: NOW / 1000,
  exp: NOW / 1000 + 300,
};

describe('pass tokens', () => {
  it('issues and verifies; the payload is readable', async () => {
    const ring = testRing();
    const token = await issuePassToken(ring, payload);
    expect(await verifyPassToken(ring, token, NOW)).toEqual({ ok: true, payload });
    const body = token.split('.')[1] as string;
    expect(JSON.parse(fromUtf8(base64urlDecode(body)))).toEqual(payload);
  });

  it('refuses an altered payload or signature', async () => {
    const ring = testRing();
    const [kid, , mac] = (await issuePassToken(ring, payload)).split('.') as [
      string,
      string,
      string,
    ];
    const forged = base64urlEncode(utf8(JSON.stringify({ ...payload, sitekey: 'bc_pk_other' })));
    expect(await verifyPassToken(ring, `${kid}.${forged}.${mac}`, NOW)).toEqual({
      ok: false,
      error: 'invalid-input-response',
    });
    const t = await issuePassToken(ring, payload);
    const flipped = `${t.slice(0, -2)}${t.endsWith('AA') ? 'BB' : 'AA'}`;
    expect((await verifyPassToken(ring, flipped, NOW)).ok).toBe(false);
  });

  it('refuses a token from another key or relabelled kid', async () => {
    const masters = testMasters(['k1', 'k2']);
    const ring = new KeyRing('k1', masters);
    const t = await issuePassToken(ring, payload);
    expect((await verifyPassToken(testRing(), t, NOW)).ok).toBe(false);
    expect((await verifyPassToken(ring, t.replace(/^k1/, 'k2'), NOW)).ok).toBe(false);
    expect((await verifyPassToken(new KeyRing('k2', masters), t, NOW)).ok).toBe(true);
  });

  it('expires', async () => {
    const ring = testRing();
    const t = await issuePassToken(ring, payload);
    expect(await verifyPassToken(ring, t, (payload.exp + 1) * 1000)).toEqual({
      ok: false,
      error: 'timeout-or-duplicate',
      payload,
    });
    expect((await verifyPassToken(ring, t, payload.exp * 1000 - 1)).ok).toBe(true);
  });

  it('refuses malformed tokens', async () => {
    const ring = testRing();
    for (const bad of ['', 'a', 'a.b', 'k1.b.c', 'k1.!.!', 'x'.repeat(3000)]) {
      expect(await verifyPassToken(ring, bad, NOW)).toEqual({
        ok: false,
        error: 'invalid-input-response',
      });
    }
  });

  it('refuses a correctly signed body that is not a token payload', async () => {
    const ring = testRing();
    const t = await issuePassToken(ring, { ...payload, v: 2 } as unknown as PassTokenPayload);
    expect((await verifyPassToken(ring, t, NOW)).ok).toBe(false);
  });

  it('carries the fallback flag; a token without it (issued before it existed) still verifies', async () => {
    const ring = testRing();
    const fb: PassTokenPayload = { ...payload, score: 0.3, fallback: true };
    expect(await verifyPassToken(ring, await issuePassToken(ring, fb), NOW)).toEqual({
      ok: true,
      payload: fb,
    });
    const old = await verifyPassToken(ring, await issuePassToken(ring, payload), NOW);
    expect(old.ok && old.payload.fallback).toBe(undefined);
    for (const bad of [false, 'yes', 1]) {
      const t = await issuePassToken(ring, {
        ...payload,
        fallback: bad,
      } as unknown as PassTokenPayload);
      expect((await verifyPassToken(ring, t, NOW)).ok).toBe(false);
    }
  });
});
