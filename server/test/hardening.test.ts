// Server hardening: key rotation at the API, Origin scheme and port, CORS on errors, the
// siteverify action and rate limit, the spent-store expiry, and the shutdown drain.

import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { type ChallengeResponse, KeyRing, randomBytes } from '@belarusian-captcha/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { matchOrigin } from '../src/config.js';
import { drain, isEntryPoint } from '../src/main.js';
import { createMetrics } from '../src/metrics.js';
import { type SpentStore, SqliteSpentStore } from '../src/store.js';
import {
  Clock,
  getChallenge,
  type Harness,
  harness,
  ORIGIN,
  SECRET,
  site,
  siteverify,
  solve,
} from './helpers.js';

async function challengeAt(h: Harness, origin = ORIGIN, query = ''): Promise<ChallengeResponse> {
  const res = await getChallenge(h, 'sitekey-aaaa', origin, '203.0.113.7', query);
  expect(res.statusCode).toBe(200);
  return res.json();
}

async function tokenFor(h: Harness, query = ''): Promise<string> {
  const res = await solve(h, await challengeAt(h, ORIGIN, query));
  expect(res.statusCode).toBe(200);
  return res.json().token;
}

describe('key rotation at the API', () => {
  it('an old-kid token and challenge still verify after the active key changes', async () => {
    const k1 = randomBytes(32);
    const k2 = randomBytes(32);
    const store = new SqliteSpentStore(':memory:');
    const clock = new Clock();
    const before = await harness({ ring: new KeyRing('k1', new Map([['k1', k1]])), store, clock });
    const oldToken = await tokenFor(before);
    const oldChallenge = await challengeAt(before);
    expect(oldToken.startsWith('k1.')).toBe(true);

    // `bc-admin keys rotate`: k2 becomes active, k1 stays listed for one TTL (section 5.2).
    const ring = new KeyRing(
      'k2',
      new Map([
        ['k1', k1],
        ['k2', k2],
      ]),
    );
    const after = await harness({ ring, store, clock });
    clock.advance(60_000); // inside the 5-minute token TTL
    const v = await siteverify(after, oldToken);
    expect(v.json()).toMatchObject({ success: true, hostname: 'site-a.test' });
    const solved = await solve(after, oldChallenge);
    expect(solved.statusCode).toBe(200);
    expect(solved.json().token.startsWith('k2.')).toBe(true); // new tokens use the active key
    expect((await challengeAt(after)).sealed.startsWith('k2.')).toBe(true);

    // Once k1 is removed (after one TTL), its tokens are refused.
    const later = await harness({ ring: new KeyRing('k2', new Map([['k2', k2]])), store, clock });
    const k1Token = await tokenFor(before);
    expect((await siteverify(later, k1Token)).json()).toEqual({
      success: false,
      'error-codes': ['invalid-input-response'],
    });
  });
});

describe('Origin scheme and port', () => {
  it.each([
    ['https://site-a.test', true],
    ['https://site-a.test:443', true],
    ['https://Site-A.test', true],
    ['https://site-a.test:8443', false],
    ['http://site-a.test', false],
    ['https://site-b.test:8443', true],
    ['https://site-b.test', false],
    ['http://localhost:5173', true],
    ['https://localhost:5173', true],
    ['http://localhost', false],
    ['http://localhost:5174', false],
    ['https://site-a.test/path', false],
    ['https://user@site-a.test', false],
    ['null', false],
    ['file:///x', false],
  ])('%s allowed: %s', async (origin, allowed) => {
    const h = await harness({
      sites: [await site({ hostnames: ['site-a.test', 'site-b.test:8443', 'localhost:5173'] })],
    });
    const res = await getChallenge(h, 'sitekey-aaaa', origin);
    expect(res.statusCode).toBe(allowed ? 200 : 403);
    expect(res.headers['access-control-allow-origin']).toBe(allowed ? origin : undefined);
  });

  it('matchOrigin returns the host name, and plain http only for local hosts', () => {
    expect(matchOrigin('https://site-a.test:8443', ['site-a.test:8443'])).toBe('site-a.test');
    expect(matchOrigin('http://127.0.0.1:3000', ['127.0.0.1:3000'])).toBe('127.0.0.1');
    expect(matchOrigin('http://app.localhost', ['app.localhost'])).toBe('app.localhost');
    expect(matchOrigin('http://site-a.test:443', ['site-a.test:443'])).toBeUndefined();
    expect(matchOrigin(undefined, ['site-a.test'])).toBeUndefined();
    expect(matchOrigin('not a url', ['site-a.test'])).toBeUndefined();
  });

  it('a solve from the right host on the wrong port is hostname-mismatch', async () => {
    const h = await harness();
    const res = await solve(h, await challengeAt(h), { origin: 'https://site-a.test:8443' });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'hostname-mismatch' });
  });

  it('siteverify accepts a token from a host:port entry by its host name', async () => {
    const h = await harness({ sites: [await site({ hostnames: ['site-a.test:8443'] })] });
    const origin = 'https://site-a.test:8443';
    const c = await challengeAt(h, origin);
    const token = (await solve(h, c, { origin })).json().token;
    expect((await siteverify(h, token)).json()).toMatchObject({
      success: true,
      hostname: 'site-a.test',
    });
  });
});

describe('error responses carry CORS for configured origins', () => {
  it('400 bad-request and 403 invalid-sitekey are readable by the widget', async () => {
    const h = await harness();
    const bad = await h.app.inject({
      method: 'GET',
      url: '/api/v1/challenge?sitekey=sitekey-aaaa&lang=xx',
      headers: { origin: ORIGIN },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(bad.headers.vary).toContain('Origin');
    const unknown = await getChallenge(h, 'no-such-sitekey');
    expect(unknown.statusCode).toBe(403);
    expect(unknown.json()).toEqual({ error: 'invalid-sitekey' });
    expect(unknown.headers['access-control-allow-origin']).toBe(ORIGIN);
  });

  it('solve errors (bad seal, malformed body, rate limit) carry CORS; other origins get none', async () => {
    const h = await harness({
      sites: [await site({ rate: { r0PerMin: 1, hardPerMin: 1, siteverifyPerMin: 600 } })],
    });
    const tampered = await h.app.inject({
      method: 'POST',
      url: '/api/v1/solve',
      headers: { origin: ORIGIN },
      payload: { sealed: 'k1.AAAA.BBBB', answer: ['x'], pow: 'x' },
    });
    expect(tampered.statusCode).toBe(400);
    expect(tampered.headers['access-control-allow-origin']).toBe(ORIGIN);
    const malformed = await h.app.inject({
      method: 'POST',
      url: '/api/v1/solve',
      headers: { origin: ORIGIN },
      payload: { nope: 1 },
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.headers['access-control-allow-origin']).toBe(ORIGIN);
    const evil = await h.app.inject({
      method: 'POST',
      url: '/api/v1/solve',
      headers: { origin: 'https://evil.test' },
      payload: { nope: 1 },
    });
    expect(evil.statusCode).toBe(400);
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
    expect((await getChallenge(h)).statusCode).toBe(200);
    const limited = await getChallenge(h);
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['access-control-allow-origin']).toBe(ORIGIN);
  });

  it('siteverify errors still carry no CORS headers', async () => {
    const h = await harness();
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/siteverify',
      headers: { origin: ORIGIN },
      payload: { secret: SECRET, response: 'garbage' },
    });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('siteverify action', () => {
  it('matches the action bound into the token, and a mismatch does not burn it', async () => {
    const h = await harness();
    const token = await tokenFor(h, '&action=login');
    expect((await siteverify(h, token, SECRET, { action: 'comment' })).json()).toEqual({
      success: false,
      'error-codes': ['action-mismatch'],
    });
    const ok = await siteverify(h, token, SECRET, { action: 'login' });
    expect(ok.json()).toMatchObject({ success: true, action: 'login' });
    expect((await siteverify(h, token, SECRET, { action: 'login' })).json()).toEqual({
      success: false,
      'error-codes': ['timeout-or-duplicate'],
    });
  });

  it('without an action field the token verifies and reports its action', async () => {
    const h = await harness();
    const token = await tokenFor(h, '&action=signup');
    expect((await siteverify(h, token)).json()).toMatchObject({ success: true, action: 'signup' });
  });

  it('an empty action matches a token issued without one', async () => {
    const h = await harness();
    const token = await tokenFor(h);
    expect((await siteverify(h, token, SECRET, { action: '' })).json()).toMatchObject({
      success: true,
    });
  });

  it('works with form posts', async () => {
    const h = await harness();
    const token = await tokenFor(h, '&action=login');
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/siteverify',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ secret: SECRET, response: token, action: 'other' }).toString(),
    });
    expect(res.json()).toEqual({ success: false, 'error-codes': ['action-mismatch'] });
  });
});

describe('siteverify rate limit', () => {
  it('limits calls per secret key; wrong secrets do not use the budget', async () => {
    const h = await harness({
      sites: [await site({ rate: { r0PerMin: 10, hardPerMin: 120, siteverifyPerMin: 2 } })],
    });
    const t1 = await tokenFor(h);
    const t2 = await tokenFor(h);
    const t3 = await tokenFor(h);
    for (let i = 0; i < 5; i++) {
      expect((await siteverify(h, t1, 'wrong-secret')).json()['error-codes']).toEqual([
        'invalid-secret',
      ]);
    }
    expect((await siteverify(h, t1)).json().success).toBe(true);
    expect((await siteverify(h, t2)).json().success).toBe(true);
    const limited = await siteverify(h, t3);
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBe('60');
    expect(limited.json()).toEqual({ success: false, 'error-codes': ['rate-limited'] });
    h.clock.advance(61_000);
    expect((await siteverify(h, t3)).json().success).toBe(true);
    const text = await h.deps.metrics.registry.metrics();
    expect(text).toMatch(/bc_siteverify_total\{site="sitekey-aaaa",result="rate-limited"\} 1/);
  });
});

describe('spent store expiry', () => {
  it('callers store the bare expiry; the grace is added once, at prune', async () => {
    const inner = new SqliteSpentStore(':memory:');
    const calls: [string, number][] = [];
    const store: SpentStore = {
      name: 'recording',
      spend: (kind, id, exp) => {
        calls.push([kind, exp]);
        return inner.spend(kind, id, exp);
      },
      prune: (n) => inner.prune(n),
      healthy: () => inner.healthy(),
      close: () => inner.close(),
    };
    const h = await harness({ store });
    const c = await challengeAt(h);
    const solved = (await solve(h, c)).json();
    await siteverify(h, solved.token);
    const sealedExp = h.clock.t + 600_000;
    expect(calls).toEqual([
      ['challenge', sealedExp],
      ['token', solved.expires],
    ]);
    // Kept for exactly PRUNE_GRACE_MS (one minute) past the latest expiry, then gone.
    expect(await inner.prune(sealedExp + 60_000)).toBe(1); // the token (earlier exp)
    expect(await inner.prune(sealedExp + 60_001)).toBe(1); // the challenge
  });
});

describe('item metrics cardinality', () => {
  it('caps distinct item labels and folds the rest into "other"', async () => {
    const m = createMetrics({ maxItemLabels: 2 });
    expect(['a', 'b', 'c', 'a', 'd', 'b'].map((x) => m.itemLabel(x))).toEqual([
      'a',
      'b',
      'other',
      'a',
      'other',
      'b',
    ]);
  });
});

describe('shutdown', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bc-main-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function closingStore(): SpentStore & { closed: boolean } {
    const inner = new SqliteSpentStore(':memory:');
    const s = {
      name: 'sqlite',
      closed: false,
      spend: inner.spend.bind(inner),
      prune: inner.prune.bind(inner),
      healthy: inner.healthy.bind(inner),
      close: () => {
        s.closed = true;
        inner.close();
      },
    };
    return s;
  }

  async function slowApp(delayMs: number) {
    const store = closingStore();
    const h = await harness({ store });
    h.app.get('/slow', async () => {
      await new Promise((r) => setTimeout(r, delayMs));
      return { done: true };
    });
    await h.app.listen({ port: 0, host: '127.0.0.1' });
    const addr = h.app.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    return { h, store, url: `http://127.0.0.1:${port}/slow` };
  }

  it('drains an in-flight request before closing, then closes the store', async () => {
    const { h, store, url } = await slowApp(200);
    const inflight = fetch(url).then((r) => r.json());
    await new Promise((r) => setTimeout(r, 50));
    const result = await drain({ app: h.app, store }, 5_000);
    expect(result).toBe('drained');
    expect(await inflight).toEqual({ done: true });
    expect(store.closed).toBe(true);
    await expect(fetch(url)).rejects.toThrow();
  });

  it('gives up after the timeout and cuts the open connections', async () => {
    const { h, store, url } = await slowApp(3_000);
    const inflight = fetch(url).then(
      () => 'answered',
      () => 'cut',
    );
    await new Promise((r) => setTimeout(r, 50));
    const t0 = Date.now();
    expect(await drain({ app: h.app, store }, 100)).toBe('timeout');
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(await inflight).toBe('cut');
    expect(store.closed).toBe(true);
  });

  it('recognises the entry point through a symlink, and nothing else', () => {
    const real = join(dir, 'main.js');
    writeFileSync(real, '');
    const link = join(dir, 'link.js');
    symlinkSync(real, link);
    const url = pathToFileURL(real).href;
    expect(isEntryPoint(url, real)).toBe(true);
    expect(isEntryPoint(url, link)).toBe(true);
    expect(isEntryPoint(url, join(dir, 'missing.js'))).toBe(false);
    expect(isEntryPoint(url, undefined)).toBe(false);
  });
});
