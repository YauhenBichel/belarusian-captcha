import type { ErrorCode } from '@belarusian-captcha/shared';
import { describe, expect, it } from 'vitest';
import { type ApiErrorCode, DEFAULT_TIMEOUT_MS, verify } from './server.js';

// The SDK cannot depend on the private shared package, so it keeps its own copy of the codes.
// These two lines fail the type-check if the copies drift apart.
const toApi = (c: ErrorCode): ApiErrorCode => c;
const toShared = (c: ApiErrorCode): ErrorCode => c;
void toApi;
void toShared;

const SECRET = 'sdk-test-secret-not-real';
const URL_BASE = 'https://captcha.example.test';

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(answer: (call: Call) => Response | Promise<Response>): {
  fetch: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    return answer(call);
  }) as typeof fetch;
  return { fetch: f, calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const OK = {
  success: true,
  challenge_ts: '2026-11-20T12:00:00.000Z',
  hostname: 'site-a.test',
  score: 0.9,
  action: 'login',
  'error-codes': [],
};

describe('verify', () => {
  it('posts the token, secret and optional fields as JSON to /api/v1/siteverify', async () => {
    const f = fakeFetch(() => json(200, OK));
    const r = await verify('tok', {
      secret: SECRET,
      url: `${URL_BASE}/`,
      remoteip: '203.0.113.7',
      sitekey: 'sitekey-aaaa',
      action: 'login',
      fetch: f.fetch,
    });
    expect(r).toEqual({
      success: true,
      score: 0.9,
      hostname: 'site-a.test',
      action: 'login',
      challenge_ts: '2026-11-20T12:00:00.000Z',
      error_codes: [],
      unavailable: false,
    });
    expect(f.calls).toHaveLength(1);
    const [call] = f.calls;
    expect(call?.url).toBe(`${URL_BASE}/api/v1/siteverify`);
    expect(call?.init.method).toBe('POST');
    expect(call?.init.redirect).toBe('error');
    expect(JSON.parse(String(call?.init.body))).toEqual({
      secret: SECRET,
      response: 'tok',
      remoteip: '203.0.113.7',
      sitekey: 'sitekey-aaaa',
      action: 'login',
    });
  });

  it('keeps a path prefix in the base URL', async () => {
    const f = fakeFetch(() => json(200, OK));
    await verify('tok', { secret: SECRET, url: `${URL_BASE}/captcha//`, fetch: f.fetch });
    expect(f.calls[0]?.url).toBe(`${URL_BASE}/captcha/api/v1/siteverify`);
  });

  it('refuses an empty, missing or oversized token without calling the API', async () => {
    const f = fakeFetch(() => json(200, OK));
    for (const t of ['', undefined, null, 'x'.repeat(4097)]) {
      const r = await verify(t, { secret: SECRET, url: URL_BASE, fetch: f.fetch });
      expect(r).toEqual({
        success: false,
        error_codes: ['invalid-input-response'],
        unavailable: false,
      });
    }
    expect(f.calls).toHaveLength(0);
  });

  it('passes the API refusal codes through, and does not fail open on them', async () => {
    const f = fakeFetch(() =>
      json(200, { success: false, 'error-codes': ['timeout-or-duplicate'] }),
    );
    const r = await verify('tok', {
      secret: SECRET,
      url: URL_BASE,
      failOpen: true,
      fetch: f.fetch,
    });
    expect(r).toEqual({
      success: false,
      error_codes: ['timeout-or-duplicate'],
      unavailable: false,
    });
  });

  it('treats 429 rate-limited as a refusal, not as unavailable', async () => {
    const f = fakeFetch(() => json(429, { success: false, 'error-codes': ['rate-limited'] }));
    const r = await verify('tok', {
      secret: SECRET,
      url: URL_BASE,
      failOpen: true,
      fetch: f.fetch,
    });
    expect(r).toEqual({ success: false, error_codes: ['rate-limited'], unavailable: false });
  });

  it('applies minScore', async () => {
    const f = fakeFetch(() => json(200, { ...OK, score: 0.3 }));
    const low = await verify('tok', {
      secret: SECRET,
      url: URL_BASE,
      minScore: 0.5,
      fetch: f.fetch,
    });
    expect(low.success).toBe(false);
    expect(low.error_codes).toEqual(['score-below-threshold']);
    expect(low.score).toBe(0.3);
    const ok = await verify('tok', {
      secret: SECRET,
      url: URL_BASE,
      minScore: 0.3,
      fetch: f.fetch,
    });
    expect(ok.success).toBe(true);
  });

  it('treats a missing score as 0 under a threshold', async () => {
    const { score: _drop, ...noScore } = OK;
    const f = fakeFetch(() => json(200, noScore));
    const r = await verify('tok', { secret: SECRET, url: URL_BASE, minScore: 0.1, fetch: f.fetch });
    expect(r.success).toBe(false);
  });

  describe('when the API is unavailable', () => {
    const cases: [string, () => Response | Promise<Response>][] = [
      ['a network error', () => Promise.reject(new TypeError('fetch failed'))],
      [
        '503 store-unavailable',
        () => json(503, { success: false, 'error-codes': ['store-unavailable'] }),
      ],
      ['502 with an HTML page', () => new Response('<html>bad gateway</html>', { status: 502 })],
      ['200 that is not a siteverify answer', () => json(200, { hello: 'world' })],
      ['200 with a body that is not JSON', () => new Response('ok', { status: 200 })],
    ];
    for (const [name, answer] of cases) {
      it(`fails closed by default on ${name}`, async () => {
        const f = fakeFetch(answer);
        const r = await verify('tok', { secret: SECRET, url: URL_BASE, fetch: f.fetch });
        expect(r).toEqual({
          success: false,
          error_codes: ['captcha-unavailable'],
          unavailable: true,
        });
      });
      it(`fails open with failOpen on ${name}`, async () => {
        const f = fakeFetch(answer);
        const r = await verify('tok', {
          secret: SECRET,
          url: URL_BASE,
          failOpen: true,
          minScore: 0.9,
          fetch: f.fetch,
        });
        expect(r).toEqual({
          success: true,
          error_codes: ['captcha-unavailable'],
          unavailable: true,
        });
      });
    }

    it('times out after the timeout and reports unavailable', async () => {
      const f = fakeFetch(
        ({ init }) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
          }),
      );
      const t0 = Date.now();
      const r = await verify('tok', { secret: SECRET, url: URL_BASE, timeout: 50, fetch: f.fetch });
      expect(r.unavailable).toBe(true);
      expect(r.success).toBe(false);
      expect(Date.now() - t0).toBeLessThan(DEFAULT_TIMEOUT_MS);
    });

    it("stops when the caller's signal aborts", async () => {
      const f = fakeFetch(
        ({ init }) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
          }),
      );
      const ac = new AbortController();
      const p = verify('tok', { secret: SECRET, url: URL_BASE, signal: ac.signal, fetch: f.fetch });
      ac.abort();
      expect((await p).unavailable).toBe(true);
    });
  });

  it('never puts the secret into a result', async () => {
    const f = fakeFetch(() => Promise.reject(new Error(`boom ${SECRET}`)));
    const r = await verify('tok', { secret: SECRET, url: URL_BASE, fetch: f.fetch });
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });

  it('throws TypeError for wrong options, without the secret in the message', async () => {
    const bad: [string, Partial<Parameters<typeof verify>[1]>][] = [
      ['no secret', { secret: '' }],
      ['relative url', { url: '/captcha' }],
      ['ftp url', { url: 'ftp://captcha.example.test' }],
      ['credentials in url', { url: 'https://u:p@captcha.example.test' }],
      ['query in url', { url: `${URL_BASE}?x=1` }],
      ['minScore > 1', { minScore: 1.5 }],
      ['minScore NaN', { minScore: Number.NaN }],
      ['timeout 0', { timeout: 0 }],
    ];
    for (const [name, override] of bad) {
      const opts = { secret: SECRET, url: URL_BASE, ...override };
      const err = await verify('tok', opts).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err, name).toBeInstanceOf(TypeError);
      expect(String(err), name).not.toContain(SECRET);
    }
  });
});
