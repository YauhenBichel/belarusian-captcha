import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import { buildProverbChallenge, pickDistractors, pickItems } from '../src/challenge.js';
import { ConfigError, originHostname, parseSites } from '../src/config.js';
import { parseTrustProxy } from '../src/main.js';
import { PackError, parsePack } from '../src/pack.js';
import { ipPrefix, powMaxNumber, RateLimiter } from '../src/rate.js';
import { openStore, SqliteSpentStore } from '../src/store.js';
import { Clock, PACK, PACK_TEXT, site, testRing } from './helpers.js';

const HASH = 'a'.repeat(64);

describe('parseSites', () => {
  it('applies the design defaults', () => {
    const sites = parseSites(
      `sites:\n  - sitekey: example-0001\n    secret_sha256: "${HASH}"\n    hostnames: [Example.ORG]\n`,
    );
    const s = sites.get('example-0001');
    expect(s?.hostnames).toEqual(['example.org']);
    expect(s?.pow).toEqual({ base: 50_000, maxLevel: 6 });
    expect(s?.rate).toEqual({ r0PerMin: 10, hardPerMin: 120 });
    expect(s?.tokenTtlS).toBe(300);
    expect(s?.challengeTtlS).toBe(600);
    expect(s?.secretSha256).toHaveLength(32);
  });

  it.each([
    ['sites: []', /non-empty/],
    [`sites:\n  - sitekey: short\n    secret_sha256: "${HASH}"\n    hostnames: [a.org]`, /sitekey/],
    [
      `sites:\n  - sitekey: example-0001\n    secret_sha256: "abc"\n    hostnames: [a.org]`,
      /secret_sha256/,
    ],
    [
      `sites:\n  - sitekey: example-0001\n    secret_sha256: "${HASH}"\n    hostnames: ["http://a.org"]`,
      /hostnames/,
    ],
    [
      `sites:\n  - sitekey: example-0001\n    secret_sha256: "${HASH}"\n    hostnames: [a.org]\n    types: { image: 1 }`,
      /not available yet/,
    ],
    [
      `sites:\n  - sitekey: example-0001\n    secret_sha256: "${HASH}"\n    hostnames: [a.org]\n    script: latn`,
      /script/,
    ],
    [
      `sites:\n  - sitekey: example-0001\n    secret_sha256: "${HASH}"\n    hostnames: [a.org]\n    pow: { base: 10 }`,
      /pow.base/,
    ],
    [
      `sites:\n  - sitekey: example-0001\n    secret_sha256: "${HASH}"\n    hostnames: [a.org]\n  - sitekey: example-0001\n    secret_sha256: "${HASH}"\n    hostnames: [a.org]`,
      /duplicate/,
    ],
  ])('rejects %s', (yaml, msg) => {
    expect(() => parseSites(yaml)).toThrow(ConfigError);
    expect(() => parseSites(yaml)).toThrow(msg);
  });

  it('parses the example file shipped with the server', async () => {
    const { readFileSync } = await import('node:fs');
    const text = readFileSync(new URL('../sites.example.yaml', import.meta.url), 'utf8');
    expect(parseSites(text).has('example-sitekey-0001')).toBe(true);
  });

  it('reads origins', () => {
    expect(originHostname('https://Site-A.test:8443')).toBe('site-a.test');
    expect(originHostname('null')).toBeUndefined();
    expect(originHostname('file:///x')).toBeUndefined();
    expect(originHostname(undefined)).toBeUndefined();
  });
});

describe('parsePack', () => {
  it('serves live items only and checksums the file', () => {
    expect(PACK.version).toBe('synthetic-0');
    expect(PACK.live.map((x) => x.id)).not.toContain('syn-g1');
    expect(PACK.live.map((x) => x.id)).not.toContain('syn-h1');
    expect(PACK.live).toHaveLength(10);
    expect(PACK.checksum).toMatch(/^[0-9a-f]{12}$/);
  });

  it('refuses a pack that cannot fill four options from other families', () => {
    const doc = JSON.parse(PACK_TEXT);
    doc.items = doc.items.filter((x: { family: string }) =>
      ['fam-a', 'fam-b', 'fam-c'].includes(x.family),
    );
    expect(() => parsePack(JSON.stringify(doc))).toThrow(/at least 4 families/);
  });

  it.each([
    ['not json', /JSON/],
    ['{"format":"other"}', /format/],
    ['{"format":"bc-pack-json-v1","version":"1","items":[{"id":"x"}]}', /family/],
  ])('rejects %s', (text, msg) => {
    expect(() => parsePack(text)).toThrow(PackError);
    expect(() => parsePack(text)).toThrow(msg);
  });

  it('rejects duplicate ids', () => {
    const doc = JSON.parse(PACK_TEXT);
    doc.items.push(doc.items[0]);
    expect(() => parsePack(JSON.stringify(doc))).toThrow(/duplicate/);
  });
});

describe('challenge building', () => {
  it('draws distractors from other families, never the right text', () => {
    for (const item of PACK.live) {
      for (let i = 0; i < 10; i++) {
        const d = pickDistractors(PACK, item);
        expect(d).toHaveLength(3);
        expect(new Set(d).size).toBe(3);
        expect(d).not.toContain(item.ending);
        const families = d.map((text) => PACK.live.find((x) => x.ending === text)?.family);
        expect(families).not.toContain(item.family);
      }
    }
  });

  it('asks easy items below level 2, two questions from two families at level 4', () => {
    for (let i = 0; i < 20; i++) {
      expect(pickItems(PACK, 0, new Set()).map((x) => x.difficulty)).toEqual(['easy']);
      const two = pickItems(PACK, 4, new Set());
      expect(two).toHaveLength(2);
      expect(two[0]?.family).not.toBe(two[1]?.family);
      expect(two.every((x) => x.difficulty === 'normal')).toBe(true);
    }
  });

  it('avoids items the client saw recently while others are left', () => {
    const easy = PACK.live.filter((x) => x.difficulty === 'easy');
    const recent = new Set(easy.slice(1).map((x) => x.id));
    for (let i = 0; i < 10; i++) expect(pickItems(PACK, 0, recent)[0]?.id).toBe(easy[0]?.id);
  });

  it('builds a two-question challenge at level 4 with a 16x proof-of-work', async () => {
    const s = await site();
    const { response, itemIds } = await buildProverbChallenge({
      ring: testRing(),
      pack: PACK,
      site: s,
      level: 4,
      bucket: 'b',
      action: 'login',
      recent: new Set(),
      nowMs: 1_000_000,
    });
    expect(response.display.questions).toHaveLength(2);
    expect(itemIds).toHaveLength(2);
    expect(response.pow.maxnumber).toBe(powMaxNumber(s, 4));
    expect(response.pow.maxnumber).toBe(800);
  });
});

describe('rate levels', () => {
  it('cuts IPv6 to /64 and keeps IPv4 whole', () => {
    expect(ipPrefix('192.0.2.1')).toBe('192.0.2.1');
    expect(ipPrefix('::ffff:192.0.2.1')).toBe('192.0.2.1');
    expect(ipPrefix('2001:db8:1:2:3:4:5:6')).toBe('2001:db8:1:2::/64');
    expect(ipPrefix('2001:db8:1:2::9')).toBe('2001:db8:1:2::/64');
    expect(ipPrefix('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(ipPrefix('::1')).toBe('0:0:0:0::/64');
  });

  it('puts one /64 in one bucket and changes buckets daily', async () => {
    const clock = new Clock();
    const r = new RateLimiter({ now: clock.now });
    const a = await r.bucketFor('2001:db8:1:2::1');
    expect(await r.bucketFor('2001:db8:1:2:ffff::9')).toBe(a);
    expect(await r.bucketFor('2001:db8:1:3::1')).not.toBe(a);
    expect(a).not.toContain('2001');
    clock.advance(24 * 3600_000);
    expect(await r.bucketFor('2001:db8:1:2::1')).not.toBe(a);
  });

  it('follows level = floor(log2(r / r0)) + f + s, capped at max_level', async () => {
    const clock = new Clock();
    const s = await site({
      rate: { r0PerMin: 2, hardPerMin: 1000 },
      pow: { base: 50, maxLevel: 3 },
    });
    const r = new RateLimiter({ now: clock.now });
    const levels = [];
    for (let i = 1; i <= 8; i++) levels.push(r.hit(s, 'b').level);
    expect(levels).toEqual([0, 0, 0, 1, 1, 1, 1, 2]);
    r.fail(s, 'b');
    expect(r.hit(s, 'b').level).toBe(3);
    r.fail(s, 'b');
    expect(r.hit(s, 'b')).toMatchObject({ level: 3, f: 2 }); // capped
    // A minute later the requests have aged out; the failures (10 minutes) have not.
    clock.advance(61_000);
    expect(r.hit(s, 'b')).toMatchObject({ r: 1, f: 2, level: 2 });
    clock.advance(10 * 60_000);
    expect(r.hit(s, 'b')).toMatchObject({ r: 1, f: 0, level: 0 });
  });

  it('limits over the hard limit per bucket', async () => {
    const clock = new Clock();
    const s = await site({ rate: { r0PerMin: 10, hardPerMin: 5 } });
    const r = new RateLimiter({ now: clock.now });
    for (let i = 0; i < 5; i++) expect(r.hit(s, 'b').limited).toBe(false);
    expect(r.hit(s, 'b').limited).toBe(true);
    expect(r.hit(s, 'other').limited).toBe(false);
    clock.advance(60_001);
    expect(r.hit(s, 'b').limited).toBe(false);
  });

  it('adds a site-wide surge level', async () => {
    const clock = new Clock();
    const s = await site({ rate: { r0PerMin: 1, hardPerMin: 1000 } });
    const r = new RateLimiter({ now: clock.now });
    // Baseline floor is 2 x r0 = 2/min; more than 8 requests in a minute is a surge (s = 1),
    // more than 32 is s = 2. Spread over buckets so the per-bucket term stays 0.
    const ss = [];
    for (let i = 0; i < 40; i++) ss.push(r.hit(s, `b${i}`).s);
    expect(ss[7]).toBe(0);
    expect(ss[8]).toBe(1);
    expect(ss[39]).toBe(2);
  });

  it('caps and sweeps buckets', async () => {
    const clock = new Clock();
    const s = await site();
    const r = new RateLimiter({ now: clock.now, maxBuckets: 3 });
    for (const b of ['a', 'b', 'c', 'd']) r.hit(s, b);
    expect(r.size).toBe(3);
    clock.advance(11 * 60_000);
    expect(r.sweep()).toBe(3);
    expect(r.size).toBe(0);
  });

  it('remembers recently shown items per bucket', async () => {
    const s = await site();
    const r = new RateLimiter({ now: Date.now });
    r.shown(s, 'b', ['x', 'y']);
    expect([...r.recentItems(s, 'b')]).toEqual(['x', 'y']);
    expect(r.recentItems(s, 'other').size).toBe(0);
  });
});

describe('spent store', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bc-store-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('spends an id once and prunes after expiry plus grace', async () => {
    const st = new SqliteSpentStore(':memory:');
    expect(await st.spend('challenge', 'x', 1000)).toBe(true);
    expect(await st.spend('challenge', 'x', 1000)).toBe(false);
    expect(await st.spend('token', 'x', 1000)).toBe(true); // kinds are separate
    expect(await st.prune(1000 + 60_000)).toBe(0);
    expect(await st.prune(1001 + 60_000)).toBe(2);
    expect(await st.spend('challenge', 'x', 5000)).toBe(true);
    expect(await st.healthy()).toBe(true);
    st.close();
    expect(await st.healthy()).toBe(false);
  });

  it('two connections to one file: exactly one spend wins', async () => {
    const path = join(dir, 'bc.sqlite');
    const a = openStore(`sqlite:${path}`);
    const b = openStore(`sqlite:${path}`);
    for (let i = 0; i < 50; i++) {
      const wins = await Promise.all([
        a.spend('token', `t${i}`, 1e13),
        b.spend('token', `t${i}`, 1e13),
      ]);
      expect(wins.filter(Boolean)).toHaveLength(1);
    }
    a.close();
    b.close();
  });

  it('two processes racing on one file: every id is won exactly once', async () => {
    const path = join(dir, 'race.sqlite');
    new SqliteSpentStore(path).close(); // create the schema first
    // Each worker inserts the same 300 ids through the same statement the store uses.
    const worker = `
      const Database = require('better-sqlite3');
      const db = new Database(process.argv[1]);
      db.pragma('journal_mode = WAL');
      db.pragma('busy_timeout = 5000');
      const ins = db.prepare('INSERT INTO spent (id, exp) VALUES (?, ?) ON CONFLICT (id) DO NOTHING');
      let won = 0;
      for (let i = 0; i < 300; i++) won += ins.run('token:race' + i, 1e13).changes;
      console.log(won);`;
    const run = () =>
      promisify(execFile)(process.execPath, ['-e', worker, path], {
        cwd: new URL('..', import.meta.url).pathname,
      });
    const outs = await Promise.all([run(), run()]);
    const total = outs.reduce((n, o) => n + Number(o.stdout.trim()), 0);
    expect(total).toBe(300);
  });

  it('refuses unknown store kinds', () => {
    expect(() => openStore('redis://x')).toThrow(/only sqlite/);
  });
});

describe('main helpers', () => {
  it('parses BC_TRUST_PROXY', () => {
    expect(parseTrustProxy(undefined)).toBe(false);
    expect(parseTrustProxy('true')).toBe(true);
    expect(parseTrustProxy('2')).toBe(2);
    expect(parseTrustProxy('10.0.0.1, 10.0.0.2')).toEqual(['10.0.0.1', '10.0.0.2']);
  });
});
