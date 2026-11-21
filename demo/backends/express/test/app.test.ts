// The Express demo backend against a recorded siteverify: what it sends, what it answers, and
// that the secret never comes back. The real API is exercised by scripts/compose-smoke.ts.

import { mkdtempSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type DemoConfig, SUBMIT_PATH } from '../src/app.js';

const SECRET = 'demo-test-secret-not-real';
const SITEKEY = 'demo-sitekey-0001';

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

let server: Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
});

async function start(over: Partial<DemoConfig> = {}): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'bc-demo-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>demo</title>');
  const app = createApp({
    secret: SECRET,
    apiUrl: 'http://api.test',
    sitekey: SITEKEY,
    staticDir: dir,
    ...over,
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server?.once('listening', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const submit = (base: string, form: Record<string, string>) =>
  fetch(base + SUBMIT_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form),
  });

describe('Express demo backend', () => {
  it('serves the demo page and a health check', async () => {
    const base = await start();
    const page = await fetch(`${base}/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<title>demo</title>');
    expect(page.headers.get('x-powered-by')).toBeNull();
    expect(page.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await (await fetch(`${base}/healthz`)).json()).toEqual({ ok: true });
  });

  it('accepts a valid token: siteverify gets the secret, the site key and the demo action', async () => {
    const api = fakeApi(ok);
    const base = await start({ fetch: api.fetch });
    const res = await submit(base, { 'bc-response': 'tok-1', comment: 'hello' });
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
    const res = await submit(base, { 'bc-response': 'tok-1' });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.accepted).toBe(false);
    expect(body.verify.error_codes).toEqual(['timeout-or-duplicate']);
    expect(JSON.stringify(body)).not.toContain(SECRET);
  });

  it('fails closed with 503 when the API cannot be reached', async () => {
    const down = fakeApi(() => Promise.reject(new TypeError('fetch failed')));
    const base = await start({ fetch: down.fetch });
    const res = await submit(base, { 'bc-response': 'tok-1' });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.accepted).toBe(false);
    expect(body.verify).toMatchObject({ unavailable: true, error_codes: ['captcha-unavailable'] });
  });

  it('refuses a form without a token, or with an oversized one, without calling the API', async () => {
    const api = fakeApi(ok);
    const base = await start({ fetch: api.fetch });
    for (const form of [
      {},
      { comment: 'x' },
      { 'bc-response': '' },
      { 'bc-response': 'x'.repeat(4097) },
    ]) {
      const res = await submit(base, form);
      expect(res.status, JSON.stringify(form).slice(0, 40)).toBe(400);
      expect(await res.json()).toEqual({ accepted: false, error: 'missing-token' });
    }
    const json = await fetch(base + SUBMIT_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ 'bc-response': 'tok-1' }),
    });
    expect(json.status).toBe(400);
    expect(api.calls).toHaveLength(0);
  });
});
