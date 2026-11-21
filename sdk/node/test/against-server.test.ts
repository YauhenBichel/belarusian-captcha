// The SDK against the real verify API over HTTP: a challenge solved through the API, the token
// verified by the SDK once, then refused as a replay.

import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { getChallenge, harness, SECRET, solve } from '../../../server/test/helpers.js';
import { verify } from '../src/server.js';

type H = Awaited<ReturnType<typeof harness>>;
let current: H | undefined;

afterEach(async () => {
  await current?.app.close();
  current = undefined;
});

async function listening(): Promise<{ h: H; url: string }> {
  const h = await harness();
  current = h;
  await h.app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = h.app.server.address() as AddressInfo;
  return { h, url: `http://127.0.0.1:${port}` };
}

async function passToken(h: H): Promise<string> {
  const c = await getChallenge(h);
  expect(c.statusCode).toBe(200);
  const s = await solve(h, c.json());
  expect(s.statusCode).toBe(200);
  return s.json().token as string;
}

describe('verify against the verify API', () => {
  it('accepts a fresh token once and refuses the replay', async () => {
    const { h, url } = await listening();
    const token = await passToken(h);

    const first = await verify(token, { secret: SECRET, url, sitekey: 'sitekey-aaaa' });
    expect(first.success).toBe(true);
    expect(first.unavailable).toBe(false);
    expect(first.hostname).toBe('site-a.test');
    expect(typeof first.score).toBe('number');
    expect(first.challenge_ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const replay = await verify(token, { secret: SECRET, url });
    expect(replay).toEqual({
      success: false,
      error_codes: ['timeout-or-duplicate'],
      unavailable: false,
    });
  });

  it('gets invalid-secret for a wrong secret, and the token stays usable', async () => {
    const { h, url } = await listening();
    const token = await passToken(h);
    const wrong = await verify(token, { secret: 'not-the-secret', url });
    expect(wrong.error_codes).toEqual(['invalid-secret']);
    expect((await verify(token, { secret: SECRET, url })).success).toBe(true);
  });

  it('gets invalid-input-response for a forged token', async () => {
    const { url } = await listening();
    const r = await verify('forged.token', { secret: SECRET, url });
    expect(r).toEqual({
      success: false,
      error_codes: ['invalid-input-response'],
      unavailable: false,
    });
  });

  it('reports unavailable when nothing listens at the URL', async () => {
    const { h, url } = await listening();
    await h.app.close();
    current = undefined;
    const r = await verify('tok', { secret: SECRET, url });
    expect(r).toEqual({ success: false, error_codes: ['captcha-unavailable'], unavailable: true });
  });
});
