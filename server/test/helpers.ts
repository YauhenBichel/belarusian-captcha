// Test fixtures for the server: a site config with a tiny proof-of-work, the synthetic pack, an
// in-memory store and a hand-driven clock.

import { readFileSync } from 'node:fs';
import {
  type ChallengeResponse,
  encodePowSolution,
  hexToBytes,
  KeyRing,
  randomBytes,
  sha256Hex,
  solvePow,
} from '@belarusian-captcha/shared';
import { type AppDeps, buildApp } from '../src/app.js';
import type { SiteConfig } from '../src/config.js';
import { createMetrics } from '../src/metrics.js';
import { type ContentPack, parsePack } from '../src/pack.js';
import { RateLimiter } from '../src/rate.js';
import { type SpentStore, SqliteSpentStore } from '../src/store.js';

export const PACK_TEXT = readFileSync(
  new URL('./fixtures/synthetic-pack.json', import.meta.url),
  'utf8',
);
export const PACK = parsePack(PACK_TEXT);
export const SECRET = 'test-secret-not-real';
export const ORIGIN = 'https://site-a.test';

export async function site(overrides: Partial<SiteConfig> = {}): Promise<SiteConfig> {
  return {
    sitekey: 'sitekey-aaaa',
    secretSha256: hexToBytes(await sha256Hex(SECRET)),
    hostnames: ['site-a.test'],
    types: { proverb: 1 },
    script: 'cyrl',
    // Far below the production minimum (1000), so tests solve the proof-of-work quickly.
    pow: { base: 50, maxLevel: 6 },
    rate: { r0PerMin: 10, hardPerMin: 120, siteverifyPerMin: 600 },
    tokenTtlS: 300,
    challengeTtlS: 600,
    ...overrides,
  };
}

export function testRing(): KeyRing {
  return new KeyRing('k1', new Map([['k1', randomBytes(32)]]));
}

export class Clock {
  t = Date.UTC(2026, 10, 20, 12, 0, 0);
  now = () => this.t;
  advance(ms: number) {
    this.t += ms;
  }
}

export interface Harness {
  app: ReturnType<typeof buildApp>;
  deps: AppDeps;
  clock: Clock;
  logs: string[];
}

export async function harness(
  opts: {
    sites?: SiteConfig[];
    store?: SpentStore;
    pack?: ContentPack;
    ring?: KeyRing;
    clock?: Clock;
  } = {},
): Promise<Harness> {
  const clock = opts.clock ?? new Clock();
  const logs: string[] = [];
  const sites = opts.sites ?? [await site()];
  const deps: AppDeps = {
    sites: new Map(sites.map((s) => [s.sitekey, s])),
    ring: opts.ring ?? testRing(),
    store: opts.store ?? new SqliteSpentStore(':memory:'),
    pack: opts.pack ?? PACK,
    limiter: new RateLimiter({ now: clock.now }),
    metrics: createMetrics(),
    now: clock.now,
    logLevel: 'info',
    logStream: { write: (line) => void logs.push(line) },
  };
  return { app: buildApp(deps), deps, clock, logs };
}

export async function getChallenge(
  h: Harness,
  sitekey = 'sitekey-aaaa',
  origin = ORIGIN,
  remoteAddress = '203.0.113.7',
  query = '',
) {
  return h.app.inject({
    method: 'GET',
    url: `/api/v1/challenge?sitekey=${sitekey}${query}`,
    headers: { origin },
    remoteAddress,
  });
}

/** The option ids of the right answers, found through the pack (cut -> ending). */
export function rightAnswer(c: ChallengeResponse, pack: ContentPack = PACK): string[] {
  return c.display.questions.map((q) => {
    const item = pack.live.find((x) => x.cut === q.prompt);
    const opt = q.options.find((o) => o.text === item?.ending);
    if (!opt) throw new Error('right option not found');
    return opt.id;
  });
}

export function wrongAnswer(c: ChallengeResponse): string[] {
  const right = rightAnswer(c);
  return c.display.questions.map((q, i) => {
    const opt = q.options.find((o) => o.id !== right[i]);
    if (!opt) throw new Error('no wrong option');
    return opt.id;
  });
}

export async function powFor(c: ChallengeResponse): Promise<string> {
  const solved = await solvePow(c.pow);
  if (!solved) throw new Error('pow not solvable');
  return encodePowSolution({
    algorithm: c.pow.algorithm,
    challenge: c.pow.challenge,
    number: solved.number,
    salt: c.pow.salt,
    signature: c.pow.signature,
  });
}

export async function solve(
  h: Harness,
  c: ChallengeResponse,
  opts: { answer?: string[]; pow?: string; origin?: string; remoteAddress?: string } = {},
) {
  return h.app.inject({
    method: 'POST',
    url: '/api/v1/solve',
    headers: { origin: opts.origin ?? ORIGIN },
    remoteAddress: opts.remoteAddress ?? '203.0.113.7',
    payload: {
      sealed: c.sealed,
      answer: opts.answer ?? rightAnswer(c),
      pow: opts.pow ?? (await powFor(c)),
    },
  });
}

export async function siteverify(
  h: Harness,
  response: string,
  secret = SECRET,
  extra: Record<string, string> = {},
) {
  return h.app.inject({
    method: 'POST',
    url: '/api/v1/siteverify',
    payload: { secret, response, ...extra },
  });
}
