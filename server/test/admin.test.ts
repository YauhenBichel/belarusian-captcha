import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KeyRing, sha256Hex } from '@belarusian-captcha/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nextKid, run, writeAtomic } from '../src/admin.js';
import { parseSites } from '../src/config.js';
import { getChallenge, harness, solve } from './helpers.js';

let dir: string;
let out: string[];
let err: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bc-admin-'));
  out = [];
  err = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const io = (env: NodeJS.ProcessEnv = {}) => ({
  out: (l: string) => void out.push(l),
  err: (l: string) => void err.push(l),
  env,
});
const admin = (...argv: string[]) => run(argv, io());
const sitesFile = () => join(dir, 'sites.yaml');
const keysFile = () => join(dir, 'bc-keys.json');
const printed = (prefix: string) =>
  out
    .find((l) => l.startsWith(prefix))
    ?.slice(prefix.length)
    .trim() ?? '';

const EXAMPLE = readFileSync(new URL('../sites.example.yaml', import.meta.url), 'utf8');

describe('bc-admin site add', () => {
  it('adds a site, prints the secret once and stores only its hash', async () => {
    const code = await admin(
      'site',
      'add',
      '--sites',
      sitesFile(),
      '--host',
      'Example.BY',
      '--host',
      'www.example.by',
    );
    expect(code).toBe(0);
    const sitekey = printed('sitekey:');
    const secret = printed('secret:');
    expect(sitekey).toMatch(/^bc_pk_[A-Za-z0-9_-]{22}$/);
    expect(secret).toMatch(/^bc_sk_[A-Za-z0-9_-]{43}$/);

    const text = readFileSync(sitesFile(), 'utf8');
    expect(text).not.toContain(secret);
    expect(err.join('\n')).not.toContain(secret);
    const site = parseSites(text).get(sitekey);
    expect(site?.hostnames).toEqual(['example.by', 'www.example.by']);
    expect(Buffer.from(site?.secretSha256 ?? []).toString('hex')).toBe(await sha256Hex(secret));
  });

  it('keeps the comments and the other sites of an existing file', async () => {
    writeFileSync(sitesFile(), EXAMPLE);
    expect(
      await admin(
        'site',
        'add',
        '--sites',
        sitesFile(),
        '--host',
        'example.by',
        '--sitekey',
        'my-site-0002',
      ),
    ).toBe(0);
    const text = readFileSync(sitesFile(), 'utf8');
    expect(text).toContain('# Example sites.yaml');
    expect(text).toContain('# Where the widget runs.');
    expect([...parseSites(text).keys()]).toEqual(['example-sitekey-0001', 'my-site-0002']);
  });

  it('refuses a duplicate site key, a bad host and no host, without writing', async () => {
    writeFileSync(sitesFile(), EXAMPLE);
    expect(
      await admin(
        'site',
        'add',
        '--sites',
        sitesFile(),
        '--host',
        'a.by',
        '--sitekey',
        'example-sitekey-0001',
      ),
    ).toBe(1);
    expect(err.join('\n')).toContain('duplicate sitekey');
    expect(await admin('site', 'add', '--sites', sitesFile(), '--host', 'https://a.by/')).toBe(1);
    expect(err.join('\n')).toContain('invalid "https://a.by/"');
    expect(await admin('site', 'add', '--sites', sitesFile())).toBe(2);
    expect(readFileSync(sitesFile(), 'utf8')).toBe(EXAMPLE);
    expect(out.some((l) => l.startsWith('secret:'))).toBe(false);
  });

  it('--dry-run prints the entry, writes nothing and issues no secret', async () => {
    writeFileSync(sitesFile(), EXAMPLE);
    expect(await admin('site', 'add', '--sites', sitesFile(), '--host', 'a.by', '--dry-run')).toBe(
      0,
    );
    expect(out[0]).toContain('dry run: would add');
    expect(out.join('\n')).toContain('secret_sha256:');
    expect(out.some((l) => l.startsWith('secret:'))).toBe(false);
    expect(readFileSync(sitesFile(), 'utf8')).toBe(EXAMPLE);
  });

  it('uses BC_SITES when --sites is not given', async () => {
    const code = await run(['site', 'add', '--host', 'a.by'], io({ BC_SITES: sitesFile() }));
    expect(code).toBe(0);
    expect(existsSync(sitesFile())).toBe(true);
  });

  it('gives a site that the API accepts end to end with the printed secret', async () => {
    await admin(
      'site',
      'add',
      '--sites',
      sitesFile(),
      '--host',
      'site-a.test',
      '--sitekey',
      'sitekey-aaaa',
    );
    const secret = printed('secret:');
    const site = parseSites(readFileSync(sitesFile(), 'utf8')).get('sitekey-aaaa');
    if (!site) throw new Error('site missing');
    // The tests' tiny proof-of-work, so the solve is quick.
    const h = await harness({ sites: [{ ...site, pow: { base: 50, maxLevel: 6 } }] });
    const token = (await solve(h, (await getChallenge(h)).json())).json().token as string;
    const ok = await h.app.inject({
      method: 'POST',
      url: '/api/v1/siteverify',
      payload: { secret, response: token },
    });
    expect(ok.json().success).toBe(true);
  });
});

describe('bc-admin site rotate-secret and list', () => {
  it('replaces only the hash of that site and prints the new secret', async () => {
    writeFileSync(sitesFile(), EXAMPLE);
    expect(
      await admin('site', 'rotate-secret', 'example-sitekey-0001', '--sites', sitesFile()),
    ).toBe(0);
    const secret = printed('secret:');
    const site = parseSites(readFileSync(sitesFile(), 'utf8')).get('example-sitekey-0001');
    expect(Buffer.from(site?.secretSha256 ?? []).toString('hex')).toBe(await sha256Hex(secret));
    expect(readFileSync(sitesFile(), 'utf8')).toContain('# Where the widget runs.');
  });

  it('refuses an unknown site key', async () => {
    writeFileSync(sitesFile(), EXAMPLE);
    expect(await admin('site', 'rotate-secret', 'nope-nope-nope', '--sites', sitesFile())).toBe(1);
    expect(readFileSync(sitesFile(), 'utf8')).toBe(EXAMPLE);
  });

  it('lists site keys and hosts', async () => {
    writeFileSync(sitesFile(), EXAMPLE);
    expect(await admin('site', 'list', '--sites', sitesFile())).toBe(0);
    expect(out).toEqual(['example-sitekey-0001  example.org, www.example.org']);
  });
});

describe('bc-admin keys', () => {
  const keyValues = () =>
    Object.values(JSON.parse(readFileSync(keysFile(), 'utf8')).keys as Record<string, string>);

  it('init creates an owner-only key file the server accepts, and never prints the key', async () => {
    expect(await admin('keys', 'init', '--keys', keysFile())).toBe(0);
    const ring = KeyRing.fromJson(readFileSync(keysFile(), 'utf8'));
    expect(ring.active).toBe('k1');
    expect(statSync(keysFile()).mode & 0o777).toBe(0o600);
    const [key] = keyValues();
    expect([...out, ...err].join('\n')).not.toContain(key);
  });

  it('init refuses to overwrite an existing file', async () => {
    await admin('keys', 'init', '--keys', keysFile());
    const before = readFileSync(keysFile(), 'utf8');
    expect(await admin('keys', 'init', '--keys', keysFile())).toBe(1);
    expect(readFileSync(keysFile(), 'utf8')).toBe(before);
  });

  it('rotate adds an active key and keeps the old ones; remove drops an inactive one', async () => {
    await admin('keys', 'init', '--keys', keysFile());
    expect(await admin('keys', 'rotate', '--keys', keysFile())).toBe(0);
    let ring = KeyRing.fromJson(readFileSync(keysFile(), 'utf8'));
    expect(ring.active).toBe('k2');
    expect(ring.has('k1')).toBe(true);
    expect(statSync(keysFile()).mode & 0o777).toBe(0o600);
    expect(err.join('\n')).toContain('bc-admin keys remove k1');

    expect(await admin('keys', 'remove', 'k2', '--keys', keysFile())).toBe(1);
    expect(err.join('\n')).toContain('is active');
    expect(await admin('keys', 'remove', 'k1', '--keys', keysFile())).toBe(0);
    ring = KeyRing.fromJson(readFileSync(keysFile(), 'utf8'));
    expect(ring.has('k1')).toBe(false);
    expect(ring.active).toBe('k2');
    for (const key of keyValues()) expect([...out, ...err].join('\n')).not.toContain(key);
  });

  it('rotate --dry-run and remove --dry-run change nothing', async () => {
    await admin('keys', 'init', '--keys', keysFile());
    await admin('keys', 'rotate', '--keys', keysFile());
    const before = readFileSync(keysFile(), 'utf8');
    expect(await admin('keys', 'rotate', '--keys', keysFile(), '--dry-run')).toBe(0);
    expect(await admin('keys', 'remove', 'k1', '--keys', keysFile(), '--dry-run')).toBe(0);
    expect(readFileSync(keysFile(), 'utf8')).toBe(before);
  });

  it('refuses a broken key file without quoting it', async () => {
    writeFileSync(keysFile(), '{"active":"k1","keys":{"k1":"c2VjcmV0LWtleS1tYXRlcmlhbA"');
    expect(await admin('keys', 'rotate', '--keys', keysFile())).toBe(1);
    expect(err.join('\n')).toContain('not valid JSON');
    expect(err.join('\n')).not.toContain('c2VjcmV0');
  });

  it('lists key ids and marks the active one', async () => {
    await admin('keys', 'init', '--keys', keysFile(), '--kid', 'a');
    await admin('keys', 'rotate', '--keys', keysFile(), '--kid', 'b');
    out = [];
    expect(await admin('keys', 'list', '--keys', keysFile())).toBe(0);
    expect(out).toEqual(['a', 'b (active)']);
  });

  it('needs --keys or BC_KEYS_FILE', async () => {
    expect(await admin('keys', 'list')).toBe(2);
    expect(await run(['keys', 'init'], io({ BC_KEYS_FILE: keysFile() }))).toBe(0);
  });

  it('nextKid counts past the highest kN', () => {
    expect(nextKid(['k1'])).toBe('k2');
    expect(nextKid(['k1', 'k7', 'x'])).toBe('k8');
    expect(nextKid(['a', 'b'])).toBe('k1');
  });
});

describe('bc-admin command line', () => {
  it('prints usage with exit 2 for no command, an unknown command or an unknown option', async () => {
    expect(await admin()).toBe(2);
    expect(await admin('site', 'remove', 'x')).toBe(2);
    expect(await admin('site', 'list', '--bogus')).toBe(2);
    expect(err.join('\n')).toContain('usage: bc-admin');
  });

  it('--help prints usage with exit 0', async () => {
    expect(await admin('--help')).toBe(0);
    expect(out.join('\n')).toContain('keys rotate');
  });
});

describe('writeAtomic', () => {
  it('keeps the mode of the file it replaces and leaves no temporary file', () => {
    const p = join(dir, 'f.txt');
    writeFileSync(p, 'old', { mode: 0o640 });
    writeAtomic(p, 'new', 0o600);
    expect(readFileSync(p, 'utf8')).toBe('new');
    expect(statSync(p).mode & 0o777).toBe(0o640);
    expect(readFileSync(p, 'utf8')).toBe('new');
    expect(existsSync(join(dir, `.f.txt.${process.pid}.tmp`))).toBe(false);
  });
});
