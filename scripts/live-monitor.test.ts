// The live monitor against a real server on a loopback port (the same app the image runs, built
// from the test harness: tiny proof-of-work, synthetic pack, in-memory store).

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { harness, PACK_TEXT, SECRET, site } from '../server/test/helpers.js';
import {
  answerKey,
  configFromEnv,
  DEFAULT_ORIGIN,
  type MonitorConfig,
  main,
  pickAnswers,
  runMonitor,
  StepError,
} from './live-monitor.js';

const MONITOR_HOST = new URL(DEFAULT_ORIGIN).hostname;
const SITEKEY = 'live-monitor-0001';

const servers: Array<{ close(): Promise<unknown> }> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function serve(opts: Parameters<typeof harness>[0] = {}) {
  const sites = opts.sites ?? [await site({ sitekey: SITEKEY, hostnames: [MONITOR_HOST] })];
  const h = await harness({ ...opts, sites });
  await h.app.listen({ port: 0, host: '127.0.0.1' });
  servers.push(h.app);
  const { port } = h.app.server.address() as AddressInfo;
  return { h, url: `http://127.0.0.1:${port}` };
}

function config(url: string, over: Partial<MonitorConfig> = {}): MonitorConfig {
  return {
    baseUrl: url,
    sitekey: SITEKEY,
    secret: SECRET,
    origin: DEFAULT_ORIGIN,
    answers: answerKey(PACK_TEXT),
    timeoutMs: 5_000,
    ...over,
  };
}

describe('runMonitor', () => {
  it('passes every step against a healthy server', async () => {
    const { url } = await serve();
    const lines: string[] = [];
    const r = await runMonitor(config(url), (l) => lines.push(l));
    expect(r.ok).toBe(true);
    expect(r.failed).toBeUndefined();
    expect(r.steps.map((s) => s.step)).toEqual([
      'healthz',
      'challenge',
      'answer',
      'pow',
      'solve',
      'siteverify',
    ]);
    expect(r.packVersion).toMatch(/^synthetic-0\+[0-9a-f]{12}$/);
    expect(lines.at(-1)).toContain(`hostname ${MONITOR_HOST}`);
  });

  it('never writes the secret or the pass token to its log or result', async () => {
    const { url } = await serve();
    const tokens: string[] = [];
    const realFetch = globalThis.fetch;
    // Record every pass token the server hands out, to look for it in the output afterwards.
    globalThis.fetch = async (input, init) => {
      const res = await realFetch(input, init);
      if (String(input).endsWith('/solve')) {
        const body = (await res.clone().json()) as { token?: string };
        if (body.token) tokens.push(body.token);
      }
      return res;
    };
    const lines: string[] = [];
    try {
      const r = await runMonitor(config(url), (l) => lines.push(l));
      expect(r.ok).toBe(true);
      lines.push(JSON.stringify(r));
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(tokens).toHaveLength(1);
    const out = lines.join('\n');
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain(tokens[0]);
  });

  it('fails at siteverify with a wrong secret', async () => {
    const { url } = await serve();
    const r = await runMonitor(config(url, { secret: 'not-the-secret' }));
    expect(r.ok).toBe(false);
    expect(r.failed).toBe('siteverify');
    expect(r.steps.at(-1)?.detail).toContain('invalid-secret');
  });

  it('fails at challenge when the Origin is not one of the site hostnames', async () => {
    const { url } = await serve();
    const r = await runMonitor(config(url, { origin: 'https://elsewhere.invalid' }));
    expect(r.failed).toBe('challenge');
    expect(r.steps.at(-1)?.detail).toContain('HTTP 403: invalid-sitekey');
  });

  it('fails at challenge for an unknown site key', async () => {
    const { url } = await serve();
    const r = await runMonitor(config(url, { sitekey: 'no-such-sitekey' }));
    expect(r.failed).toBe('challenge');
  });

  it('fails at answer when the server runs a pack the monitor cannot read', async () => {
    const { url } = await serve();
    const r = await runMonitor(config(url, { answers: new Map([['another prompt', 'x']]) }));
    expect(r.failed).toBe('answer');
    expect(r.steps.at(-1)?.detail).toContain('not in the answer key');
  });

  it('fails at healthz when the spent store is down', async () => {
    const { url } = await serve({
      store: {
        name: 'down',
        spend: () => Promise.reject(new Error('down')),
        prune: () => Promise.resolve(0),
        healthy: () => Promise.resolve(false),
        close: () => {},
      },
    });
    const r = await runMonitor(config(url));
    expect(r.failed).toBe('healthz');
    expect(r.steps.at(-1)?.detail).toContain('HTTP 503');
  });

  it('fails at healthz when nothing answers', async () => {
    const { url, h } = await serve();
    await h.app.close();
    const r = await runMonitor(config(url, { timeoutMs: 2_000 }));
    expect(r.failed).toBe('healthz');
    expect(r.steps.at(-1)?.detail).toContain('request failed');
  });
});

describe('answerKey and pickAnswers', () => {
  it('maps every live cut to its ending, and skips items that are not live', () => {
    const key = answerKey(
      JSON.stringify({
        items: [
          { cut: 'a ...', ending: 'A', status: 'live' },
          { cut: 'b ...', ending: 'B', status: 'draft' },
        ],
      }),
    );
    expect([...key]).toEqual([['a ...', 'A']]);
  });

  it('refuses a pack without live items', () => {
    expect(() => answerKey('{"items":[]}')).toThrow('no live items');
  });

  it('throws an answer StepError when the right ending is not offered', () => {
    const c = {
      display: { questions: [{ prompt: 'a ...', options: [{ id: 'x', text: 'B' }] }] },
    } as unknown as Parameters<typeof pickAnswers>[0];
    expect(() => pickAnswers(c, new Map([['a ...', 'A']]))).toThrow(StepError);
  });
});

describe('configFromEnv and main', () => {
  const readPack = () => PACK_TEXT;

  it('names the missing variables, never their values', () => {
    expect(() => configFromEnv({ BC_MONITOR_SECRET: 'hidden-value' }, readPack as never)).toThrow(
      'missing BC_LIVE_URL, BC_MONITOR_SITEKEY',
    );
  });

  it('trims a trailing slash and defaults the Origin', () => {
    const cfg = configFromEnv(
      {
        BC_LIVE_URL: 'https://captcha.example.org/',
        BC_MONITOR_SITEKEY: SITEKEY,
        BC_MONITOR_SECRET: 's',
      },
      readPack as never,
    );
    expect(cfg.baseUrl).toBe('https://captcha.example.org');
    expect(cfg.origin).toBe(DEFAULT_ORIGIN);
    expect(cfg.answers.size).toBeGreaterThan(0);
  });

  it('refuses a URL that is not http or https', () => {
    expect(() =>
      configFromEnv(
        { BC_LIVE_URL: 'ftp://x', BC_MONITOR_SITEKEY: SITEKEY, BC_MONITOR_SECRET: 's' },
        readPack as never,
      ),
    ).toThrow('http or https');
  });

  it('returns 0 for a good pass and 1 for a missing setting', async () => {
    const { url } = await serve();
    const quiet = console.log;
    console.log = () => {};
    try {
      expect(
        await main({ BC_LIVE_URL: url, BC_MONITOR_SITEKEY: SITEKEY, BC_MONITOR_SECRET: SECRET }),
      ).toBe(0);
      expect(await main({})).toBe(1);
    } finally {
      console.log = quiet;
    }
  });
});

// The workflow runs the file with plain `node` (type stripping, no build step for scripts/), so
// it must load that way: no TypeScript-only syntax such as parameter properties or enums. It
// imports shared/ from its dist, which `npm run typecheck` (tsc -b) builds first in CI.
const SCRIPT = fileURLToPath(new URL('./live-monitor.ts', import.meta.url));
const SHARED_DIST = fileURLToPath(new URL('../shared/dist/index.js', import.meta.url));

describe('node scripts/live-monitor.ts', () => {
  it.skipIf(!existsSync(SHARED_DIST))(
    'loads under plain node and reports a missing setting',
    async () => {
      const r = await new Promise<{ code: number | null; out: string }>((resolve) => {
        execFile(
          process.execPath,
          [SCRIPT],
          { env: { PATH: process.env.PATH } },
          (err, stdout, stderr) =>
            resolve({
              code: err ? ((err as { code?: number }).code ?? 1) : 0,
              out: stdout + stderr,
            }),
        );
      });
      expect(r.out).toContain('FAIL  config  missing BC_LIVE_URL');
      expect(r.out).not.toContain('ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX');
      expect(r.code).toBe(1);
    },
  );
});
