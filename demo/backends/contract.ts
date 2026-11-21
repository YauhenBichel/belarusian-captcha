// The contract every Node demo backend keeps (Express, Fastify), run against a recorded
// siteverify: what it sends, what it answers, and that the secret never comes back. Each backend's
// test calls describeDemoBackend() with a function that starts it. The real API is exercised by
// scripts/compose-smoke.ts against every backend in compose.yaml.
//
//   GET  /             the built demo page, with x-content-type-options and no x-powered-by
//   GET  /healthz      {ok: true}
//   POST /demo/submit  application/x-www-form-urlencoded `bc-response` (+ `comment`):
//     200 {accepted: true,  verify}   the token is valid, unspent and for this site and action
//     400 {accepted: false, verify}   the API refused it (replay, expired, wrong site, ...)
//     400 {accepted: false, error: 'missing-token'}   no usable token; the API is not called
//     503 {accepted: false, verify}   the API could not be reached (fail closed, D11)

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

export const SUBMIT_PATH = '/demo/submit';
const SECRET = 'demo-test-secret-not-real';
const SITEKEY = 'demo-sitekey-0001';

/** The configuration the Node demo backends share. */
export interface ContractConfig {
  secret: string;
  apiUrl: string;
  sitekey: string;
  staticDir: string;
  fetch?: typeof fetch;
}

/** Starts the backend on 127.0.0.1 with an ephemeral port. */
export type StartBackend = (
  cfg: ContractConfig,
) => Promise<{ base: string; close: () => Promise<void> }>;

interface Call {
  url: string;
  body: Record<string, unknown>;
}

/** A fetch that records each siteverify call and answers with `reply`. */
function fakeApi(reply: () => Response | Promise<Response>) {
  const calls: Call[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return reply();
  }) as typeof fetch;
  return { calls, fetch: f };
}

const ok = () =>
  Response.json({
    success: true,
    challenge_ts: '2026-11-21T10:00:00Z',
    hostname: 'localhost',
    score: 0.9,
    action: 'demo',
    fallback: false,
    'error-codes': [],
  });
const spent = () => Response.json({ success: false, 'error-codes': ['timeout-or-duplicate'] });

const submit = (base: string, body: BodyInit, type = 'application/x-www-form-urlencoded') =>
  fetch(base + SUBMIT_PATH, { method: 'POST', headers: { 'content-type': type }, body });

export function describeDemoBackend(name: string, startBackend: StartBackend): void {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  async function start(over: Partial<ContractConfig> = {}): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), 'bc-demo-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>demo</title>');
    const s = await startBackend({
      secret: SECRET,
      apiUrl: 'http://api.test',
      sitekey: SITEKEY,
      staticDir: dir,
      ...over,
    });
    close = s.close;
    return s.base;
  }

  describe(`${name} demo backend`, () => {
    it('serves the demo page and a health check', async () => {
      const base = await start();
      const page = await fetch(`${base}/`);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain('<title>demo</title>');
      expect(page.headers.get('x-powered-by')).toBeNull();
      expect(page.headers.get('x-content-type-options')).toBe('nosniff');
      expect(page.headers.get('referrer-policy')).toBe('no-referrer');
      const health = await fetch(`${base}/healthz`);
      expect(health.headers.get('cache-control')).toBe('no-store');
      expect(await health.json()).toEqual({ ok: true });
      expect((await fetch(`${base}/no-such-file`)).status).toBe(404);
    });

    it('accepts a valid token: siteverify gets the secret, the site key and the demo action', async () => {
      const api = fakeApi(ok);
      const base = await start({ fetch: api.fetch });
      const res = await submit(
        base,
        new URLSearchParams({ 'bc-response': 'tok-1', comment: 'hi' }),
      );
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      const body = await res.json();
      expect(body.accepted).toBe(true);
      expect(body.verify).toMatchObject({ success: true, score: 0.9, hostname: 'localhost' });
      expect(api.calls).toHaveLength(1);
      expect(api.calls[0]?.url).toBe('http://api.test/api/v1/siteverify');
      expect(api.calls[0]?.body).toMatchObject({
        secret: SECRET,
        response: 'tok-1',
        sitekey: SITEKEY,
        action: 'demo',
      });
      expect(JSON.stringify(body)).not.toContain(SECRET);
    });

    it('passes a refusal through as 400 with the API codes (a replay)', async () => {
      const base = await start({ fetch: fakeApi(spent).fetch });
      const res = await submit(base, new URLSearchParams({ 'bc-response': 'tok-1' }));
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.accepted).toBe(false);
      expect(body.verify.error_codes).toEqual(['timeout-or-duplicate']);
      expect(JSON.stringify(body)).not.toContain(SECRET);
    });

    it('fails closed with 503 when the API cannot be reached', async () => {
      const down = fakeApi(() => Promise.reject(new TypeError('fetch failed')));
      const base = await start({ fetch: down.fetch });
      const res = await submit(base, new URLSearchParams({ 'bc-response': 'tok-1' }));
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.accepted).toBe(false);
      expect(body.verify).toMatchObject({
        unavailable: true,
        error_codes: ['captcha-unavailable'],
      });
    });

    it('refuses a form without a usable token without calling the API', async () => {
      const api = fakeApi(ok);
      const base = await start({ fetch: api.fetch });
      const forms: [string, BodyInit, string?][] = [
        ['empty form', ''],
        ['no token', new URLSearchParams({ comment: 'x' })],
        ['empty token', new URLSearchParams({ 'bc-response': '' })],
        ['oversized token', new URLSearchParams({ 'bc-response': 'x'.repeat(4097) })],
        ['token twice', 'bc-response=a&bc-response=b'],
        ['JSON body', JSON.stringify({ 'bc-response': 'tok-1' }), 'application/json'],
        ['text body', 'bc-response=tok-1', 'text/plain'],
      ];
      for (const [what, body, type] of forms) {
        const res = await submit(base, body, type);
        expect(res.status, what).toBe(400);
        expect(await res.json(), what).toEqual({ accepted: false, error: 'missing-token' });
      }
      expect(api.calls).toHaveLength(0);
    });

    it('refuses a body over 16 KB with 413, without calling the API', async () => {
      const api = fakeApi(ok);
      const base = await start({ fetch: api.fetch });
      const big = new URLSearchParams({ 'bc-response': 'tok-1', comment: 'x'.repeat(20_000) });
      const res = await submit(base, big);
      expect(res.status).toBe(413);
      expect(api.calls).toHaveLength(0);
    });
  });
}
