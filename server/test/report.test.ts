// "Report this question" (docs/DESIGN.md section 11): POST /api/v1/report takes the seal the
// widget holds and the index of a question, and records only the item id from the seal.

import type { ChallengeResponse } from '@belarusian-captcha/shared';
import { describe, expect, it } from 'vitest';
import { buildProverbChallenge } from '../src/challenge.js';
import type { SpentStore } from '../src/store.js';
import { getChallenge, type Harness, harness, ORIGIN, PACK, site } from './helpers.js';

async function report(
  h: Harness,
  body: unknown,
  { origin = ORIGIN, remoteAddress = '203.0.113.7' } = {},
) {
  return h.app.inject({
    method: 'POST',
    url: '/api/v1/report',
    headers: { origin, 'content-type': 'application/json' },
    payload: JSON.stringify(body),
    remoteAddress,
  });
}

async function challenge(h: Harness): Promise<ChallengeResponse> {
  const res = await getChallenge(h);
  expect(res.statusCode).toBe(200);
  return res.json();
}

/** The pack item behind a question, found by its prompt. */
const itemOf = (c: ChallengeResponse, q = 0) =>
  PACK.live.find((x) => x.cut === c.display.questions[q]?.prompt)?.id;

async function reportsMetric(h: Harness): Promise<string[]> {
  const text = await h.deps.metrics.registry.metrics();
  return text.split('\n').filter((l) => l.startsWith('bc_item_reports_total{'));
}

describe('POST /api/v1/report', () => {
  it('counts the reported item, answers 204 with CORS for the site, logs only the item id', async () => {
    const h = await harness();
    const c = await challenge(h);
    const res = await report(h, { sealed: c.sealed, question: 0 });
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
    expect(res.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(res.headers['cache-control']).toBe('no-store');

    const item = itemOf(c);
    expect(item).toBeDefined();
    expect(await reportsMetric(h)).toEqual([`bc_item_reports_total{item="${item}"} 1`]);
    const line = h.logs.find((l) => l.includes('"endpoint":"/api/v1/report"'));
    expect(line).toContain(`"item":"${item}"`);
    expect(line).toContain('"result":"ok"');
    expect(line).not.toContain('203.0.113.7');
    expect(line).not.toContain(c.sealed);
  });

  it('counts a question once per challenge; a repeat is accepted and not counted', async () => {
    const h = await harness();
    const c = await challenge(h);
    for (let i = 0; i < 3; i++) {
      expect((await report(h, { sealed: c.sealed, question: 0 })).statusCode).toBe(204);
    }
    expect(await reportsMetric(h)).toEqual([`bc_item_reports_total{item="${itemOf(c)}"} 1`]);
    expect(h.logs.filter((l) => l.includes('"result":"duplicate"'))).toHaveLength(2);
  });

  it('reports either question of a two-question challenge', async () => {
    const h = await harness();
    const { response: c, itemIds } = await buildProverbChallenge({
      ring: h.deps.ring,
      pack: PACK,
      site: await site(),
      level: 4,
      bucket: 'b',
      action: '',
      recent: new Set(),
      nowMs: h.clock.now(),
    });
    expect(itemIds).toHaveLength(2);
    expect((await report(h, { sealed: c.sealed, question: 1 })).statusCode).toBe(204);
    expect(await reportsMetric(h)).toEqual([`bc_item_reports_total{item="${itemIds[1]}"} 1`]);
    expect((await report(h, { sealed: c.sealed, question: 0 })).statusCode).toBe(204);
    expect(await reportsMetric(h)).toHaveLength(2);
  });

  it('refuses a question the challenge does not have, and a fallback challenge', async () => {
    const h = await harness();
    const c = await challenge(h);
    const res = await report(h, { sealed: c.sealed, question: 1 });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'bad-request' });

    const fb = await h.app.inject({
      method: 'GET',
      url: '/api/v1/fallback?sitekey=sitekey-aaaa',
      headers: { origin: ORIGIN },
    });
    const none = await report(h, { sealed: fb.json().sealed, question: 0 });
    expect(none.statusCode).toBe(400);
    expect(await reportsMetric(h)).toEqual([]);
  });

  it('refuses a forged seal, a bad body, another origin and an expired challenge', async () => {
    const h = await harness();
    const c = await challenge(h);
    const forged = await report(h, { sealed: `${c.sealed}x`, question: 0 });
    expect(forged.statusCode).toBe(400);
    expect(forged.json()).toEqual({ error: 'invalid-input-response' });

    for (const body of [
      { sealed: c.sealed },
      { sealed: c.sealed, question: -1 },
      { sealed: c.sealed, question: 2 },
    ]) {
      expect((await report(h, body)).statusCode, JSON.stringify(body)).toBe(400);
    }

    const foreign = await report(
      h,
      { sealed: c.sealed, question: 0 },
      { origin: 'https://evil.test' },
    );
    expect(foreign.statusCode).toBe(403);
    expect(foreign.headers['access-control-allow-origin']).toBeUndefined();

    h.clock.advance(10 * 60_000 + 1);
    const late = await report(h, { sealed: c.sealed, question: 0 });
    expect(late.statusCode).toBe(400);
    expect(late.json()).toEqual({ error: 'timeout-or-duplicate' });
    expect(await reportsMetric(h)).toEqual([]);
  });

  it('fails closed when the store is down', async () => {
    const down: SpentStore = {
      name: 'down',
      spend: () => Promise.reject(new Error('down')),
      prune: () => Promise.resolve(0),
      healthy: () => Promise.resolve(false),
      close: () => {},
    };
    const h = await harness({ store: down });
    const c = await challenge(h);
    const res = await report(h, { sealed: c.sealed, question: 0 });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'store-unavailable' });
    expect(await reportsMetric(h)).toEqual([]);
  });

  it('answers the preflight for a site origin', async () => {
    const h = await harness();
    const res = await h.app.inject({
      method: 'OPTIONS',
      url: '/api/v1/report',
      headers: { origin: ORIGIN, 'access-control-request-method': 'POST' },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(ORIGIN);
  });
});
