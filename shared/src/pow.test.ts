import { createHash, createHmac } from 'node:crypto';
import * as altcha from 'altcha-lib/v1';
import { describe, expect, it } from 'vitest';
import { base64Encode, utf8 } from './encoding.js';
import {
  createPowChallenge,
  decodePowSolution,
  encodePowSolution,
  powSaltParams,
  solvePow,
  verifyPowSolution,
} from './pow.js';

const KEY = 'test-hmac-key-0123456789abcdef';
const NOW = Date.now();
const LATER = NOW + 10 * 60_000;

async function solved(maxnumber = 500, params: Record<string, string> = { cid: 'c1' }) {
  const ch = await createPowChallenge({ hmacKey: KEY, maxnumber, expiresAt: LATER, params });
  const sol = await solvePow(ch);
  if (!sol) throw new Error('unsolved');
  return {
    ch,
    payload: {
      algorithm: ch.algorithm,
      challenge: ch.challenge,
      number: sol.number,
      salt: ch.salt,
      signature: ch.signature,
      took: sol.took,
    },
  };
}

describe('ALTCHA-compatible PoW', () => {
  it('creates, solves and verifies', async () => {
    const { ch, payload } = await solved();
    expect(ch.salt).toMatch(/^[0-9a-f]{24}\?cid=c1&expires=\d+&$/);
    const r = await verifyPowSolution(encodePowSolution(payload), KEY, NOW);
    expect(r).toEqual({
      ok: true,
      params: { cid: 'c1', expires: String(Math.floor(LATER / 1000)) },
    });
  });

  it('matches an independent node:crypto computation (test vector)', async () => {
    const ch = await createPowChallenge({
      hmacKey: KEY,
      maxnumber: 1000,
      expiresAt: 1_700_000_000_000,
      salt: 'abc',
      number: 42,
    });
    expect(ch.salt).toBe('abc?expires=1700000000&');
    const challenge = createHash('sha256').update('abc?expires=1700000000&42').digest('hex');
    expect(ch.challenge).toBe(challenge);
    expect(ch.signature).toBe(createHmac('sha256', KEY).update(challenge).digest('hex'));
  });

  it('produces the same challenge as altcha-lib for the same inputs', async () => {
    const expires = new Date(1_700_000_000_000);
    const theirs = await altcha.createChallenge({ hmacKey: KEY, salt: 'abc', number: 42, expires });
    const ours = await createPowChallenge({
      hmacKey: KEY,
      maxnumber: theirs.maxnumber ?? 1e6,
      expiresAt: expires.getTime(),
      salt: 'abc',
      number: 42,
    });
    expect(ours.salt).toBe(theirs.salt);
    expect(ours.challenge).toBe(theirs.challenge);
    expect(ours.signature).toBe(theirs.signature);
  });

  it('altcha-lib verifies our solved payload', async () => {
    const { payload } = await solved();
    expect(await altcha.verifySolution(encodePowSolution(payload), KEY)).toBe(true);
    expect(await altcha.verifySolution(encodePowSolution(payload), 'other-key')).toBe(false);
  });

  it('we verify a challenge made and solved by altcha-lib', async () => {
    const ch = await altcha.createChallenge({
      hmacKey: KEY,
      maxnumber: 500,
      expires: new Date(LATER),
      params: { cid: 'from-altcha' },
    });
    const sol = await altcha.solveChallenge(ch.challenge, ch.salt, ch.algorithm, 500).promise;
    expect(sol).not.toBeNull();
    const payload = base64Encode(
      utf8(JSON.stringify({ ...ch, number: sol?.number, took: sol?.took, maxnumber: undefined })),
    );
    const r = await verifyPowSolution(payload, KEY, NOW);
    expect(r.ok).toBe(true);
    expect(r.ok && r.params.cid).toBe('from-altcha');
  });

  it('rejects a wrong number, a forged signature, another key', async () => {
    const { payload } = await solved();
    expect(await verifyPowSolution({ ...payload, number: payload.number + 1 }, KEY, NOW)).toEqual({
      ok: false,
      reason: 'hash',
    });
    expect(
      await verifyPowSolution({ ...payload, signature: '0'.repeat(64) }, KEY, NOW),
    ).toMatchObject({ reason: 'signature' });
    expect(await verifyPowSolution(payload, 'another-key', NOW)).toMatchObject({
      reason: 'signature',
    });
  });

  it('rejects a salt whose parameters were changed (the challenge no longer matches)', async () => {
    const { payload } = await solved();
    const salt = payload.salt.replace('cid=c1', 'cid=c2');
    expect(await verifyPowSolution({ ...payload, salt }, KEY, NOW)).toMatchObject({ ok: false });
  });

  it('rejects an expired solution, and requires an expiry', async () => {
    const { payload } = await solved();
    expect(await verifyPowSolution(payload, KEY, LATER + 1000)).toMatchObject({
      reason: 'expired',
    });
    const noExp = await altcha.createChallenge({ hmacKey: KEY, number: 3, maxnumber: 10 });
    expect(await verifyPowSolution({ ...noExp, number: 3 }, KEY, NOW)).toMatchObject({
      reason: 'no-expiry',
    });
  });

  it('rejects malformed input', async () => {
    const { payload } = await solved();
    for (const bad of ['', 'not base64!', base64Encode(utf8('[]')), 'A'.repeat(5000)]) {
      expect(await verifyPowSolution(bad, KEY, NOW)).toMatchObject({ reason: 'malformed' });
    }
    for (const number of [-1, 1.5, Number.MAX_SAFE_INTEGER + 2]) {
      expect(await verifyPowSolution({ ...payload, number }, KEY, NOW)).toMatchObject({
        reason: 'malformed',
      });
    }
    expect(await verifyPowSolution({ ...payload, algorithm: 'SHA-1' }, KEY, NOW)).toMatchObject({
      reason: 'algorithm',
    });
  });

  it('decodes and splits salt parameters', () => {
    expect(powSaltParams('ab?x=1&expires=2&')).toEqual({ x: '1', expires: '2' });
    expect(powSaltParams('ab')).toEqual({});
    expect(decodePowSolution(base64Encode(utf8('{"algorithm":1}')))).toBeUndefined();
  });

  it('solvePow returns null when the number is out of range', async () => {
    const ch = await createPowChallenge({
      hmacKey: KEY,
      maxnumber: 100,
      expiresAt: LATER,
      number: 90,
    });
    expect(await solvePow({ ...ch, maxnumber: 50 })).toBeNull();
  });
});
