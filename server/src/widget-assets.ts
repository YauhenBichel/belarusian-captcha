// The widget files the API serves (docs/DESIGN.md section 5.1): GET /widget.js and
// /widget.worker.js, read once at start from the widget build (`widget/dist`, in the image at
// /app/widget/dist). The build's sri.json is the published list of SRI hashes; every file is
// checked against it here, so a stale or partial build stops the start instead of serving bytes
// whose hash no site can match.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The files served, by URL path. widget.mjs is for bundlers and is not served. */
export const WIDGET_FILES = ['widget.js', 'widget.worker.js'] as const;

/**
 * Short on purpose: the URL is not versioned, so an API upgrade reaches browsers within ten
 * minutes, and the ETag makes the revalidation a 304. A page that pins the widget with an SRI hash
 * must update the hash when the API's widget changes (each release publishes them).
 */
export const WIDGET_CACHE_CONTROL = 'public, max-age=600';

export interface WidgetFile {
  body: Buffer;
  /** `sha384-<base64>`, as in an `integrity` attribute. */
  sri: string;
  /** A strong ETag made from the SRI hash. */
  etag: string;
}

export type WidgetAssets = ReadonlyMap<string, WidgetFile>;

export function sri384(bytes: Uint8Array): string {
  return `sha384-${createHash('sha384').update(bytes).digest('base64')}`;
}

/** Reads and checks the widget build in `dir`; throws with the file name on any problem. */
export function loadWidgetAssets(dir: string): WidgetAssets {
  let manifest: Record<string, { sri?: unknown } | undefined>;
  try {
    manifest = JSON.parse(readFileSync(join(dir, 'sri.json'), 'utf8'));
  } catch (err) {
    throw new Error(`widget: cannot read ${join(dir, 'sri.json')}: ${(err as Error).message}`);
  }
  const assets = new Map<string, WidgetFile>();
  for (const name of WIDGET_FILES) {
    const body = readFileSync(join(dir, name));
    const sri = sri384(body);
    const published = manifest[name]?.sri;
    if (published !== sri) {
      throw new Error(`widget: ${name} does not match its hash in sri.json (rebuild the widget)`);
    }
    // Base64 holds no quote or backslash, so the hash is a valid ETag value as it is.
    assets.set(name, { body, sri, etag: `"${sri}"` });
  }
  return assets;
}

/** True when an If-None-Match header names this ETag (weak comparison, RFC 9110 section 13.1.2). */
export function etagMatches(ifNoneMatch: string | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;
  if (ifNoneMatch.trim() === '*') return true;
  return ifNoneMatch
    .split(',')
    .map((t) => t.trim().replace(/^W\//, ''))
    .includes(etag);
}
