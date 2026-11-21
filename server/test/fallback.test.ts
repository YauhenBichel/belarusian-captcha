// The accessible way through (docs/DESIGN.md section 6.3, D3 option B): GET /api/v1/fallback, a
// question-free challenge with a harder proof-of-work, solved with an empty answer for a
// low-score pass that siteverify marks `fallback: true`.

import { type ChallengeResponse, FALLBACK_SCORE } from '@belarusian-captcha/shared';
import { describe, expect, it } from 'vitest';
import { FALLBACK_EXTRA_LEVELS, fallbackMaxNumber } from '../src/challenge.js';
import {
  getChallenge,
  type Harness,
  harness,
  ORIGIN,
  powFor,
  site,
  siteverify,
  solve,
} from './helpers.js';

async function getFallback(
  h: Harness,
  { sitekey = 'sitekey-aaaa', origin = ORIGIN, query = '', remoteAddress = '203.0.113.7' } = {},
) {
  return h.app.inject({
    method: 'GET',
    url: `/api/v1/fallback?sitekey=${sitekey}${query}`,
    headers: { origin },
    remoteAddress,
  });
}

async function fallbackChallenge(h: Harness, query = ''): Promise<ChallengeResponse> {
  const res = await getFallback(h, { query });
  expect(res.statusCode).toBe(200);
  return res.json();
}

describe('GET /api/v1/fallback', () => {
  it('gives a challenge with no question and a proof-of-work two levels harder', async () => {
    const h = await harness();
    const res = await getFallback(h);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['access-control-allow-origin']).toBe(ORIGIN);
    const c: ChallengeResponse = res.json();
    expect(c.type).toBe('fallback');
    expect(c.display).toEqual({ questions: [] });
    // Level 0 on the test site: a proverb would carry base 50, the fallback 50 x 2^2.
    expect(FALLBACK_EXTRA_LEVELS).toBe(2);
    expect(c.pow.maxnumber).toBe(200);
  });

  it('refuses an unknown site key and an origin the site does not list', async () => {
    const h = await harness();
    const unknown = await getFallback(h, { sitekey: 'nope-nope-nope' });
    expect(unknown.statusCode).toBe(403);
    expect(unknown.json()).toEqual({ error: 'invalid-sitekey' });
    const foreign = await getFallback(h, { origin: 'https://evil.test' });
    expect(foreign.statusCode).toBe(403);
    expect(foreign.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('shares the rate limit of /challenge, so it is no way around it', async () => {
    const h = await harness({
      sites: [await site({ rate: { r0PerMin: 1, hardPerMin: 3, siteverifyPerMin: 600 } })],
    });
    expect((await getChallenge(h)).statusCode).toBe(200);
    expect((await getChallenge(h)).statusCode).toBe(200);
    expect((await getFallback(h)).statusCode).toBe(200);
    const res = await getFallback(h);
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBe('60');
    expect(res.json()).toEqual({ error: 'rate-limited' });
  });

  it('answers a preflight from a configured origin', async () => {
    const h = await harness();
    const res = await h.app.inject({
      method: 'OPTIONS',
      url: '/api/v1/fallback',
      headers: { origin: ORIGIN, 'access-control-request-method': 'GET' },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(ORIGIN);
  });

  it('caps the proof-of-work at the largest number a challenge may carry', async () => {
    const s = await site({ pow: { base: 10_000_000, maxLevel: 8 } });
    expect(fallbackMaxNumber(s, 8)).toBe(0xffffffff);
    expect(fallbackMaxNumber(s, 0)).toBe(40_000_000);
  });
});

describe('solving the fallback', () => {
  it('gives a low-score pass that siteverify marks as a fallback, once', async () => {
    const h = await harness();
    const c = await fallbackChallenge(h, '&action=signup');
    const res = await solve(h, c, { answer: [] });
    expect(res.statusCode).toBe(200);
    const token = res.json().token as string;
    const v = await siteverify(h, token);
    expect(v.json()).toMatchObject({
      success: true,
      score: FALLBACK_SCORE,
      fallback: true,
      action: 'signup',
      hostname: 'site-a.test',
      'error-codes': [],
    });
    expect(FALLBACK_SCORE).toBeLessThanOrEqual(0.3);
    expect((await siteverify(h, token)).json()['error-codes']).toEqual(['timeout-or-duplicate']);
  });

  it('marks a proverb pass as not a fallback, with score 1', async () => {
    const h = await harness();
    const c: ChallengeResponse = (await getChallenge(h)).json();
    const token = (await solve(h, c)).json().token as string;
    expect((await siteverify(h, token)).json()).toMatchObject({
      success: true,
      score: 1,
      fallback: false,
    });
  });

  it('does not let an empty answer skip the question of a proverb challenge', async () => {
    const h = await harness();
    const c: ChallengeResponse = (await getChallenge(h)).json();
    const res = await solve(h, c, { answer: [] });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('wrong-answer');
    // The next one is a proverb again: the fallback is only reached through /fallback.
    expect(res.json().next.type).toBe('proverb');
  });

  it('refuses an answer to a fallback challenge', async () => {
    const h = await harness();
    const c = await fallbackChallenge(h);
    const res = await solve(h, c, { answer: ['abc'] });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('wrong-answer');
  });

  it('needs the proof-of-work, and a refusal brings another fallback', async () => {
    const h = await harness();
    const c = await fallbackChallenge(h);
    const other = await fallbackChallenge(h);
    const res = await solve(h, c, { answer: [], pow: await powFor(other) });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('bad-pow');
    const next: ChallengeResponse = res.json().next;
    expect(next.type).toBe('fallback');
    expect(next.display.questions).toEqual([]);
  });

  it('is single use and expires like any challenge', async () => {
    const h = await harness();
    const c = await fallbackChallenge(h);
    const pow = await powFor(c);
    expect((await solve(h, c, { answer: [], pow })).statusCode).toBe(200);
    const again = await solve(h, c, { answer: [], pow });
    expect(again.json().error).toBe('timeout-or-duplicate');

    const late = await fallbackChallenge(h);
    h.clock.advance(601_000);
    expect((await solve(h, late, { answer: [] })).json().error).toBe('timeout-or-duplicate');
  });

  it('counts fallback challenges and solves under their own type', async () => {
    const h = await harness();
    const c = await fallbackChallenge(h);
    await solve(h, c, { answer: [] });
    const text = await h.deps.metrics.registry.metrics();
    expect(text).toMatch(/bc_challenges_total\{[^}]*type="fallback"[^}]*\} 1/);
    expect(text).toMatch(/bc_solves_total\{[^}]*type="fallback"[^}]*result="ok"[^}]*\} 1/);
  });
});
