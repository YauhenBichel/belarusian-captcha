// The widget served by the API (docs/DESIGN.md section 5.1): loading and checking the build, and
// GET/HEAD /widget.js and /widget.worker.js with their cache, ETag and cross-origin headers.

import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  etagMatches,
  loadWidgetAssets,
  sri384,
  WIDGET_CACHE_CONTROL,
  type WidgetAssets,
} from '../src/widget-assets.js';
import { type Harness, harness } from './helpers.js';

const JS = 'console.log("widget");';
const WORKER = 'self.onmessage = () => {};';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A widget build in a temporary folder; `sri` overrides hashes written to sri.json. */
function build(sri: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'bc-widget-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'widget.js'), JS);
  writeFileSync(join(dir, 'widget.worker.js'), WORKER);
  const manifest = {
    'widget.js': { bytes: JS.length, sri: sri['widget.js'] ?? sri384(Buffer.from(JS)) },
    'widget.worker.js': { sri: sri['widget.worker.js'] ?? sri384(Buffer.from(WORKER)) },
  };
  writeFileSync(join(dir, 'sri.json'), JSON.stringify(manifest));
  return dir;
}

describe('loadWidgetAssets', () => {
  it('loads the two files and their hashes', () => {
    const assets = loadWidgetAssets(build());
    expect([...assets.keys()]).toEqual(['widget.js', 'widget.worker.js']);
    expect(assets.get('widget.js')?.body.toString()).toBe(JS);
    expect(assets.get('widget.worker.js')?.sri).toBe(sri384(Buffer.from(WORKER)));
    expect(assets.get('widget.js')?.etag).toBe(`"${sri384(Buffer.from(JS))}"`);
  });

  it('refuses a file whose hash is not the one in sri.json (a stale build)', () => {
    expect(() => loadWidgetAssets(build({ 'widget.js': 'sha384-stale' }))).toThrow(
      /widget\.js does not match/,
    );
  });

  it('refuses a build without sri.json, or with a file missing', () => {
    const noManifest = build();
    unlinkSync(join(noManifest, 'sri.json'));
    expect(() => loadWidgetAssets(noManifest)).toThrow(/sri\.json/);
    const noWorker = build();
    unlinkSync(join(noWorker, 'widget.worker.js'));
    expect(() => loadWidgetAssets(noWorker)).toThrow(/widget\.worker\.js/);
    expect(() => loadWidgetAssets(join(tmpdir(), 'bc-widget-does-not-exist'))).toThrow();
  });
});

describe('etagMatches', () => {
  it.each([
    [undefined, false],
    ['', false],
    ['"abc"', true],
    ['W/"abc"', true],
    ['"xyz", W/"abc"', true],
    ['*', true],
    ['"xyz"', false],
    ['abc', false],
  ])('%j -> %s', (header, expected) => {
    expect(etagMatches(header, '"abc"')).toBe(expected);
  });
});

describe('GET /widget.js and /widget.worker.js', () => {
  let assets: WidgetAssets;
  let h: Harness;
  const etag = `"${sri384(Buffer.from(JS))}"`;

  beforeEach(async () => {
    assets = loadWidgetAssets(build());
    h = await harness({ widget: assets });
  });

  it('serves the widget as JavaScript, cacheable, readable from any origin', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/widget.js' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(JS);
    expect(res.headers).toMatchObject({
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': WIDGET_CACHE_CONTROL,
      etag,
      'access-control-allow-origin': '*',
      'cross-origin-resource-policy': 'cross-origin',
      'x-content-type-options': 'nosniff',
    });
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    // The bytes match the published hash, so integrity="sha384-…" holds.
    expect(sri384(res.rawPayload)).toBe(assets.get('widget.js')?.sri);
  });

  it('serves the worker with its own body and ETag', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/widget.worker.js' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(WORKER);
    expect(res.headers.etag).toBe(assets.get('widget.worker.js')?.etag);
  });

  it('answers HEAD with the headers and no body', async () => {
    const res = await h.app.inject({ method: 'HEAD', url: '/widget.js' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('');
    expect(res.headers.etag).toBe(etag);
    expect(res.headers['content-type']).toBe('text/javascript; charset=utf-8');
  });

  it('answers 304 with no body to a matching If-None-Match, strong or weak', async () => {
    for (const inm of [etag, `W/${etag}`, `"other", ${etag}`]) {
      const res = await h.app.inject({
        method: 'GET',
        url: '/widget.js',
        headers: { 'if-none-match': inm },
      });
      expect(res.statusCode, inm).toBe(304);
      expect(res.body).toBe('');
      expect(res.headers.etag).toBe(etag);
      expect(res.headers['cache-control']).toBe(WIDGET_CACHE_CONTROL);
    }
  });

  it('answers 200 to an If-None-Match for another version', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/widget.js',
      headers: { 'if-none-match': '"sha384-older"' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(JS);
  });

  it('does not serve widget.mjs or sri.json', async () => {
    for (const url of ['/widget.mjs', '/sri.json']) {
      expect((await h.app.inject({ method: 'GET', url })).statusCode, url).toBe(404);
    }
  });

  it('logs the request without the address, like every endpoint', async () => {
    await h.app.inject({ method: 'GET', url: '/widget.js', remoteAddress: '203.0.113.7' });
    const line = h.logs.find((l) => l.includes('"endpoint":"/widget.js"'));
    expect(line).toBeDefined();
    expect(line).not.toContain('203.0.113.7');
  });
});

describe('without a widget build', () => {
  it('serves neither file', async () => {
    const h = await harness();
    for (const url of ['/widget.js', '/widget.worker.js']) {
      expect((await h.app.inject({ method: 'GET', url })).statusCode, url).toBe(404);
    }
  });
});
