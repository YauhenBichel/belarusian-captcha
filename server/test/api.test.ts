import type { ChallengeResponse, SiteverifyResponse } from '@belarusian-captcha/shared';
import { describe, expect, it } from 'vitest';
import type { SpentStore } from '../src/store.js';
import {
  getChallenge,
  harness,
  ORIGIN,
  PACK,
  powFor,
  rightAnswer,
  SECRET,
  site,
  siteverify,
  solve,
  wrongAnswer,
} from './helpers.js';

async function challenge(h: Awaited<ReturnType<typeof harness>>): Promise<ChallengeResponse> {
  const res = await getChallenge(h);
  expect(res.statusCode).toBe(200);
  return res.json();
}

async function passToken(h: Awaited<ReturnType<typeof harness>>): Promise<string> {
  const res = await solve(h, await challenge(h));
  expect(res.statusCode).toBe(200);
  return res.json().token;
}

describe('GET /challenge', () => {
  it('issues a sealed proverb challenge with four options and a bound proof-of-work', async () => {
    const h = await harness();
    const res = await getChallenge(h);
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(res.headers['cache-control']).toBe('no-store');
    const c: ChallengeResponse = res.json();
    expect(c.type).toBe('proverb');
    expect(c.display.questions).toHaveLength(1);
    const q = c.display.questions[0];
    expect(q?.options).toHaveLength(4);
    expect(new Set(q?.options.map((o) => o.text)).size).toBe(4);
    // The right ending is among the options; the sealed blob does not reveal it.
    const item = PACK.live.find((x) => x.cut === q?.prompt);
    expect(item?.status).toBe('live');
    expect(q?.options.map((o) => o.text)).toContain(item?.ending);
    expect(c.sealed).not.toContain(item?.ending ?? '');
    expect(c.pow.algorithm).toBe('SHA-256');
    expect(c.pow.salt).toMatch(/cid=/);
    expect(c.pow.maxnumber).toBe(50);
    expect(c.expires).toBe(h.clock.t + 600_000);
  });

  it('refuses unknown site keys and origins not listed for the site', async () => {
    const h = await harness();
    expect((await getChallenge(h, 'no-such-sitekey')).json()).toEqual({ error: 'invalid-sitekey' });
    const evil = await getChallenge(h, 'sitekey-aaaa', 'https://evil.test');
    expect(evil.statusCode).toBe(403);
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
    const none = await h.app.inject({
      method: 'GET',
      url: '/api/v1/challenge?sitekey=sitekey-aaaa',
    });
    expect(none.statusCode).toBe(403);
  });

  it('answers 400 bad-request to a malformed query', async () => {
    const h = await harness();
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/challenge',
      headers: { origin: ORIGIN },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'bad-request' });
  });

  it('answers 429 rate-limited over the hard limit, with Retry-After', async () => {
    const h = await harness({
      sites: [await site({ rate: { r0PerMin: 1, hardPerMin: 3, siteverifyPerMin: 600 } })],
    });
    for (let i = 0; i < 3; i++) expect((await getChallenge(h)).statusCode).toBe(200);
    const res = await getChallenge(h);
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBe('60');
    expect(res.json()).toEqual({ error: 'rate-limited' });
    // Another address is not affected.
    expect((await getChallenge(h, 'sitekey-aaaa', ORIGIN, '198.51.100.9')).statusCode).toBe(200);
  });

  it('raises the level, and so the proof-of-work, with the request rate', async () => {
    const h = await harness({
      sites: [await site({ rate: { r0PerMin: 1, hardPerMin: 100, siteverifyPerMin: 600 } })],
    });
    const maxes: number[] = [];
    for (let i = 0; i < 4; i++) maxes.push((await getChallenge(h)).json().pow.maxnumber);
    expect(maxes).toEqual([50, 100, 100, 200]);
  });
});

describe('CORS preflight', () => {
  it('allows configured origins only', async () => {
    const h = await harness();
    const ok = await h.app.inject({
      method: 'OPTIONS',
      url: '/api/v1/solve',
      headers: { origin: ORIGIN, 'access-control-request-method': 'POST' },
    });
    expect(ok.statusCode).toBe(204);
    expect(ok.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(ok.headers['access-control-allow-methods']).toContain('POST');
    const bad = await h.app.inject({
      method: 'OPTIONS',
      url: '/api/v1/challenge',
      headers: { origin: 'https://evil.test' },
    });
    expect(bad.statusCode).toBe(403);
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('POST /solve', () => {
  it('returns a pass token for the right answer and a valid proof-of-work', async () => {
    const h = await harness();
    const res = await solve(h, await challenge(h));
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe(ORIGIN);
    const body = res.json();
    expect(body.token.split('.')).toHaveLength(3);
    expect(body.expires).toBe(h.clock.t + 300_000);
  });

  it('accepts one answer per challenge: a replay is timeout-or-duplicate', async () => {
    const h = await harness();
    const c = await challenge(h);
    const pow = await powFor(c);
    expect((await solve(h, c, { pow })).statusCode).toBe(200);
    const again = await solve(h, c, { pow });
    expect(again.statusCode).toBe(422);
    expect(again.json().error).toBe('timeout-or-duplicate');
    expect(again.json().next.type).toBe('proverb');
  });

  it('a wrong answer spends the challenge and returns a harder next challenge', async () => {
    const h = await harness();
    const c = await challenge(h);
    const res = await solve(h, c, { answer: wrongAnswer(c) });
    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.error).toBe('wrong-answer');
    // r = 2 (no rate level yet), f = 1: level 1, so twice the work.
    expect(body.next.pow.maxnumber).toBe(100);
    // The right answer to the same challenge is now refused too.
    expect((await solve(h, c)).json().error).toBe('timeout-or-duplicate');
  });

  it('answers 422 for an answer with the wrong number of options', async () => {
    const h = await harness();
    const c = await challenge(h);
    const res = await solve(h, c, { answer: [...rightAnswer(c), 'extra'] });
    expect(res.json().error).toBe('wrong-answer');
  });

  it('rejects a bad proof-of-work, and one solved for another challenge', async () => {
    const h = await harness();
    const a = await challenge(h);
    const b = await challenge(h);
    const garbage = await solve(h, a, { pow: 'bm90LWEtcG93' });
    expect(garbage.statusCode).toBe(422);
    expect(garbage.json().error).toBe('bad-pow');
    // A valid proof-of-work, but bound to challenge b's id.
    const swapped = await solve(h, a, { pow: await powFor(b) });
    expect(swapped.json().error).toBe('bad-pow');
    // A failed proof-of-work does not spend the challenge.
    expect((await solve(h, a)).statusCode).toBe(200);
  });

  it('rejects an expired challenge by the server clock', async () => {
    const h = await harness();
    const c = await challenge(h);
    const pow = await powFor(c);
    h.clock.advance(600_001);
    const res = await solve(h, c, { pow });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('timeout-or-duplicate');
  });

  it('rejects a tampered seal and a malformed body', async () => {
    const h = await harness();
    const c = await challenge(h);
    const parts = c.sealed.split('.');
    const tampered = { ...c, sealed: `${parts[0]}.${parts[1]}.${(parts[2] ?? '').slice(0, -2)}AA` };
    const res = await solve(h, tampered, { pow: await powFor(c) });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid-input-response' });
    const bad = await h.app.inject({
      method: 'POST',
      url: '/api/v1/solve',
      headers: { origin: ORIGIN },
      payload: { sealed: c.sealed },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toEqual({ error: 'bad-request' });
  });

  it('refuses a solve from an origin that is not the sealed site', async () => {
    const other = await site({ sitekey: 'sitekey-bbbb', hostnames: ['site-b.test'] });
    const h = await harness({ sites: [await site(), other] });
    const c = await challenge(h);
    const res = await solve(h, c, { origin: 'https://site-b.test' });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'hostname-mismatch' });
  });

  it('fails closed with 503 when the spent store is down', async () => {
    const broken: SpentStore = {
      name: 'broken',
      spend: () => Promise.reject(new Error('disk gone')),
      prune: () => Promise.resolve(0),
      healthy: () => Promise.resolve(false),
      close: () => undefined,
    };
    const h = await harness({ store: broken });
    const res = await solve(h, await challenge(h));
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'store-unavailable' });
    const health = await h.app.inject({ method: 'GET', url: '/healthz' });
    expect(health.statusCode).toBe(503);
  });

  it('two concurrent solves of one challenge: exactly one wins', async () => {
    const h = await harness();
    const c = await challenge(h);
    const pow = await powFor(c);
    const results = await Promise.all([
      solve(h, c, { pow }),
      solve(h, c, { pow }),
      solve(h, c, { pow }),
    ]);
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes).toEqual([200, 422, 422]);
  });
});

describe('POST /siteverify', () => {
  it('verifies a token once, reCAPTCHA-shaped', async () => {
    const h = await harness();
    const token = await passToken(h);
    const res = await siteverify(h, token);
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    const body: SiteverifyResponse = res.json();
    expect(body).toEqual({
      success: true,
      challenge_ts: new Date(Math.floor(h.clock.t / 1000) * 1000).toISOString(),
      hostname: 'site-a.test',
      score: 1,
      action: '',
      fallback: false,
      'error-codes': [],
    });
    expect((await siteverify(h, token)).json()).toEqual({
      success: false,
      'error-codes': ['timeout-or-duplicate'],
    });
  });

  it('accepts form posts', async () => {
    const h = await harness();
    const token = await passToken(h);
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/siteverify',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        secret: SECRET,
        response: token,
        remoteip: '192.0.2.1',
      }).toString(),
    });
    expect(res.json().success).toBe(true);
  });

  it('a wrong secret is refused and does not burn the token', async () => {
    const h = await harness();
    const token = await passToken(h);
    expect((await siteverify(h, token, 'wrong-secret')).json()['error-codes']).toEqual([
      'invalid-secret',
    ]);
    expect((await siteverify(h, token, '')).json()['error-codes']).toEqual(['invalid-secret']);
    expect((await siteverify(h, token)).json().success).toBe(true);
  });

  it('an expired token is timeout-or-duplicate, but only with the right secret', async () => {
    const h = await harness();
    const token = await passToken(h);
    h.clock.advance(301_000);
    expect((await siteverify(h, token, 'wrong-secret')).json()['error-codes']).toEqual([
      'invalid-secret',
    ]);
    expect((await siteverify(h, token)).json()['error-codes']).toEqual(['timeout-or-duplicate']);
  });

  it('refuses a forged token and a missing response', async () => {
    const h = await harness();
    const token = await passToken(h);
    const forged = `${token.slice(0, -4)}AAAA`;
    expect((await siteverify(h, forged)).json()['error-codes']).toEqual(['invalid-input-response']);
    expect((await siteverify(h, '')).json()['error-codes']).toEqual(['invalid-input-response']);
    // A token from another server's keys is not authentic here.
    const other = await harness();
    expect((await siteverify(other, token)).json()['error-codes']).toEqual([
      'invalid-input-response',
    ]);
  });

  it('a token for one site does not verify with another site secret', async () => {
    const other = await site({ sitekey: 'sitekey-bbbb', hostnames: ['site-b.test'] });
    other.secretSha256 = new Uint8Array(32);
    const h = await harness({ sites: [await site(), other] });
    const token = await passToken(h);
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/siteverify',
      payload: { secret: SECRET, response: token, sitekey: 'sitekey-bbbb' },
    });
    expect(res.json()['error-codes']).toEqual(['invalid-sitekey']);
  });
});

describe('GET /healthz and privacy', () => {
  it('reports the pack version and store state', async () => {
    const h = await harness();
    const res = await h.app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: true,
      pack_version: `synthetic-0+${PACK.checksum}`,
      store: 'ok',
    });
  });

  it('never writes the client address, origin or answer to the log', async () => {
    const h = await harness();
    const c = await challenge(h);
    await solve(h, c, { remoteAddress: '203.0.113.7' });
    await solve(h, c, { remoteAddress: '2001:db8::1' });
    const text = h.logs.join('\n');
    expect(h.logs.length).toBeGreaterThanOrEqual(3);
    expect(text).toContain('"endpoint":"/api/v1/solve"');
    for (const secret of [
      '203.0.113.7',
      '2001:db8',
      'site-a.test',
      c.sealed.slice(0, 20),
      'remoteAddress',
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  it('counts metrics', async () => {
    const h = await harness();
    await siteverify(h, await passToken(h));
    const text = await h.deps.metrics.registry.metrics();
    expect(text).toMatch(/bc_challenges_total\{site="sitekey-aaaa",type="proverb",level="0"\} 1/);
    expect(text).toMatch(/bc_solves_total\{site="sitekey-aaaa",type="proverb",result="ok"\} 1/);
    expect(text).toMatch(/bc_siteverify_total\{site="sitekey-aaaa",result="ok"\} 1/);
    expect(text).toMatch(/bc_item_answers_total\{item="syn-[a-f][12]",result="right"\} 1/);
  });
});
