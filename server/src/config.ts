// sites.yaml (docs/DESIGN.md section 5.2): one entry per site key. Mounted read-only; secrets
// are stored only as SHA-256 hashes.

import { hexToBytes } from '@belarusian-captcha/shared';
import { parse } from 'yaml';

export interface SiteConfig {
  sitekey: string;
  secretSha256: Uint8Array<ArrayBuffer>;
  /** Lower-case host names allowed as the browser Origin and as the token hostname. */
  hostnames: string[];
  types: { proverb: number };
  script: 'cyrl';
  pow: { base: number; maxLevel: number };
  rate: { r0PerMin: number; hardPerMin: number };
  tokenTtlS: number;
  challengeTtlS: number;
}

export type Sites = ReadonlyMap<string, SiteConfig>;

const SITEKEY = /^[A-Za-z0-9_-]{8,64}$/;
const HOSTNAME =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

export class ConfigError extends Error {
  override name = 'ConfigError';
}

function num(v: unknown, def: number, min: number, max: number, what: string): number {
  if (v === undefined) return def;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    throw new ConfigError(`${what} must be an integer in [${min}, ${max}]`);
  }
  return v;
}

function obj(v: unknown, what: string): Record<string, unknown> {
  if (v === undefined) return {};
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new ConfigError(`${what} must be a mapping`);
  }
  return v as Record<string, unknown>;
}

export function parseSites(yamlText: string): Map<string, SiteConfig> {
  const doc = obj(parse(yamlText), 'sites.yaml');
  if (!Array.isArray(doc.sites) || doc.sites.length === 0) {
    throw new ConfigError('sites.yaml: "sites" must be a non-empty list');
  }
  const out = new Map<string, SiteConfig>();
  for (const [i, raw] of doc.sites.entries()) {
    const s = obj(raw, `sites[${i}]`);
    const where = `sites[${i}]`;
    if (typeof s.sitekey !== 'string' || !SITEKEY.test(s.sitekey)) {
      throw new ConfigError(`${where}.sitekey must match ${SITEKEY}`);
    }
    if (out.has(s.sitekey)) throw new ConfigError(`${where}: duplicate sitekey`);
    if (typeof s.secret_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(s.secret_sha256)) {
      throw new ConfigError(`${where}.secret_sha256 must be 64 lower-case hex characters`);
    }
    if (!Array.isArray(s.hostnames) || s.hostnames.length === 0) {
      throw new ConfigError(`${where}.hostnames must be a non-empty list`);
    }
    const hostnames = s.hostnames.map((h: unknown) => {
      const host = typeof h === 'string' ? h.toLowerCase() : '';
      if (!HOSTNAME.test(host)) throw new ConfigError(`${where}.hostnames: invalid "${String(h)}"`);
      return host;
    });
    const types = obj(s.types, `${where}.types`);
    for (const t of Object.keys(types)) {
      if (t !== 'proverb' && types[t] !== 0) {
        throw new ConfigError(`${where}.types.${t}: not available yet (only proverb in phase 1)`);
      }
    }
    const proverb = num(types.proverb, 1, 0, 100, `${where}.types.proverb`);
    if (proverb === 0) throw new ConfigError(`${where}: no challenge type enabled`);
    if (s.script !== undefined && s.script !== 'cyrl') {
      throw new ConfigError(`${where}.script: only "cyrl" in phase 1 (Łacinka is phase 3)`);
    }
    const pow = obj(s.pow, `${where}.pow`);
    const rate = obj(s.rate, `${where}.rate`);
    const site: SiteConfig = {
      sitekey: s.sitekey,
      secretSha256: hexToBytes(s.secret_sha256),
      hostnames,
      types: { proverb },
      script: 'cyrl',
      pow: {
        base: num(pow.base, 50_000, 1_000, 10_000_000, `${where}.pow.base`),
        maxLevel: num(pow.max_level, 6, 0, 10, `${where}.pow.max_level`),
      },
      rate: {
        r0PerMin: num(rate.r0_per_min, 10, 1, 100_000, `${where}.rate.r0_per_min`),
        hardPerMin: num(rate.hard_per_min, 120, 1, 1_000_000, `${where}.rate.hard_per_min`),
      },
      tokenTtlS: num(s.token_ttl_s, 300, 30, 3600, `${where}.token_ttl_s`),
      challengeTtlS: num(s.challenge_ttl_s, 600, 60, 3600, `${where}.challenge_ttl_s`),
    };
    if (site.pow.base * 2 ** site.pow.maxLevel > 0xffffffff) {
      throw new ConfigError(`${where}.pow: base x 2^max_level must stay below 2^32`);
    }
    out.set(site.sitekey, site);
  }
  return out;
}

/** The host name of an Origin header value, or undefined when it is missing or not http(s). */
export function originHostname(origin: string | undefined): string | undefined {
  if (!origin) return undefined;
  try {
    const u = new URL(origin);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return undefined;
    return u.hostname.toLowerCase();
  } catch {
    return undefined;
  }
}
