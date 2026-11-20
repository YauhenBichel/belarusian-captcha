// Rate levels (docs/DESIGN.md section 4.2).
//
//   bucket = HMAC(daily key, IPv4 /32 or IPv6 /64)     the key lives only in memory
//   r      = requests in the last minute from the bucket, for the site
//   f      = wrong answers (and bad PoW) in the last 10 minutes from the bucket, capped at 3
//   s      = site-wide surge: 1 above 4x the site's baseline, 2 above 16x
//   level  = clamp(floor(log2(max(r / r0, 1))) + f + s, 0, max_level)
//   r > hard limit -> 429
//
// No IP address is kept: only the bucket, which cannot be linked across days.

import { isIPv4, isIPv6 } from 'node:net';
import { base64urlEncode, hmacSha256, randomBytes } from '@belarusian-captcha/shared';
import type { SiteConfig } from './config.js';

const MINUTE = 60_000;
const FAIL_WINDOW = 10 * MINUTE;
const MAX_FAIL_LEVELS = 3;
const RECENT_ITEMS = 16;
const DAY = 24 * 60 * MINUTE;

/** IPv4 as is; IPv6 cut to its /64; IPv4-mapped IPv6 as IPv4. */
export function ipPrefix(ip: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped?.[1]) return mapped[1];
  if (isIPv4(ip)) return ip;
  if (!isIPv6(ip)) return `other:${ip}`;
  const noZone = ip.split('%')[0] as string;
  const [head = '', tail = ''] = noZone.split('::') as [string?, string?];
  const h = head ? head.split(':') : [];
  const t = noZone.includes('::') && tail ? tail.split(':') : [];
  // An embedded IPv4 tail counts as two groups; only the first four groups matter here.
  const groups = noZone.includes('::')
    ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t]
    : h;
  return `${groups
    .slice(0, 4)
    .map((g) => Number.parseInt(g || '0', 16).toString(16))
    .join(':')}::/64`;
}

interface BucketState {
  requests: number[];
  fails: number[];
  recent: string[];
  touched: number;
}

const SLOT = 10_000;
const SLOTS = 6;

interface SiteState {
  /** Requests per 10-second slot over the last minute: slot ids and counts (a ring). */
  slotIds: number[];
  slotCounts: number[];
  baseline: number;
  minuteStart: number;
  minuteCount: number;
}

export interface RateDecision {
  limited: boolean;
  level: number;
  r: number;
  f: number;
  s: number;
}

export interface RateLimiterOptions {
  now: () => number;
  maxBuckets?: number;
}

export class RateLimiter {
  readonly #now: () => number;
  readonly #maxBuckets: number;
  readonly #buckets = new Map<string, BucketState>();
  readonly #sites = new Map<string, SiteState>();
  #dayKey: Uint8Array<ArrayBuffer> = randomBytes(32);
  #day = -1;

  constructor(opts: RateLimiterOptions) {
    this.#now = opts.now;
    this.#maxBuckets = opts.maxBuckets ?? 100_000;
  }

  /** The bucket of a client address; the key changes at every UTC midnight. */
  async bucketFor(ip: string): Promise<string> {
    const day = Math.floor(this.#now() / DAY);
    if (day !== this.#day) {
      this.#day = day;
      this.#dayKey = randomBytes(32);
    }
    return base64urlEncode((await hmacSha256(this.#dayKey, ipPrefix(ip))).slice(0, 16));
  }

  #bucket(site: string, bucket: string): BucketState {
    const key = `${site}|${bucket}`;
    let b = this.#buckets.get(key);
    if (b) {
      this.#buckets.delete(key); // keep Map order = least recently used first
    } else {
      b = { requests: [], fails: [], recent: [], touched: 0 };
      if (this.#buckets.size >= this.#maxBuckets) {
        const oldest = this.#buckets.keys().next().value;
        if (oldest !== undefined) this.#buckets.delete(oldest);
      }
    }
    b.touched = this.#now();
    this.#buckets.set(key, b);
    return b;
  }

  #site(site: SiteConfig): SiteState {
    let s = this.#sites.get(site.sitekey);
    if (!s) {
      s = {
        slotIds: Array(SLOTS).fill(-1),
        slotCounts: Array(SLOTS).fill(0),
        baseline: 0,
        minuteStart: this.#now(),
        minuteCount: 0,
      };
      this.#sites.set(site.sitekey, s);
    }
    return s;
  }

  /** Records one challenge request and returns the level (or that it is over the hard limit). */
  hit(site: SiteConfig, bucket: string): RateDecision {
    const now = this.#now();
    const b = this.#bucket(site.sitekey, bucket);
    b.requests = b.requests.filter((t) => t > now - MINUTE);
    b.requests.push(now);
    if (b.requests.length > site.rate.hardPerMin + 1) b.requests.shift();
    b.fails = b.fails.filter((t) => t > now - FAIL_WINDOW);

    const st = this.#site(site);
    while (now - st.minuteStart >= MINUTE) {
      // Exponentially weighted per-minute baseline, updated as each minute closes.
      st.baseline = st.baseline === 0 ? st.minuteCount : 0.9 * st.baseline + 0.1 * st.minuteCount;
      st.minuteCount = 0;
      st.minuteStart += MINUTE;
      if (now - st.minuteStart > 60 * MINUTE) st.minuteStart = now; // long idle: skip ahead
    }
    st.minuteCount++;
    const slot = Math.floor(now / SLOT);
    const i = slot % SLOTS;
    if (st.slotIds[i] !== slot) {
      st.slotIds[i] = slot;
      st.slotCounts[i] = 0;
    }
    st.slotCounts[i] = (st.slotCounts[i] as number) + 1;
    let siteRate = 0;
    for (let j = 0; j < SLOTS; j++) {
      if ((st.slotIds[j] as number) > slot - SLOTS) siteRate += st.slotCounts[j] as number;
    }

    const r = b.requests.length;
    const f = Math.min(b.fails.length, MAX_FAIL_LEVELS);
    // The baseline never falls below 2 x r0, so a quiet site's first visitors are not a surge.
    const base = Math.max(st.baseline, 2 * site.rate.r0PerMin);
    const s = siteRate > 16 * base ? 2 : siteRate > 4 * base ? 1 : 0;
    const level = Math.min(
      site.pow.maxLevel,
      Math.max(0, Math.floor(Math.log2(Math.max(r / site.rate.r0PerMin, 1))) + f + s),
    );
    return { limited: r > site.rate.hardPerMin, level, r, f, s };
  }

  /**
   * A plain per-minute limit for one key in one scope (siteverify: scope "siteverify", key the
   * site key, so the limit is per secret key). Shares the bucket map, so it is capped and swept
   * like the challenge buckets. True when this call is over `perMin`.
   */
  overLimit(scope: string, key: string, perMin: number): boolean {
    const now = this.#now();
    const b = this.#bucket(`${scope}:`, key);
    b.requests = b.requests.filter((t) => t > now - MINUTE);
    if (b.requests.length >= perMin) return true;
    b.requests.push(now);
    return false;
  }

  /** A wrong answer or a bad proof-of-work from this bucket. */
  fail(site: SiteConfig, bucket: string): void {
    this.#bucket(site.sitekey, bucket).fails.push(this.#now());
  }

  /** Item ids shown to this bucket lately, so the next pick can avoid them. */
  recentItems(site: SiteConfig, bucket: string): ReadonlySet<string> {
    return new Set(this.#buckets.get(`${site.sitekey}|${bucket}`)?.recent ?? []);
  }

  shown(site: SiteConfig, bucket: string, itemIds: string[]): void {
    const b = this.#bucket(site.sitekey, bucket);
    b.recent.push(...itemIds);
    if (b.recent.length > RECENT_ITEMS) b.recent.splice(0, b.recent.length - RECENT_ITEMS);
  }

  /** Drops buckets idle for longer than the failure window. */
  sweep(): number {
    const cutoff = this.#now() - FAIL_WINDOW;
    let n = 0;
    for (const [k, b] of this.#buckets) {
      if (b.touched < cutoff) {
        this.#buckets.delete(k);
        n++;
      }
    }
    return n;
  }

  get size(): number {
    return this.#buckets.size;
  }
}

/** maxnumber for a level: base x 2^level. */
export function powMaxNumber(site: SiteConfig, level: number): number {
  return site.pow.base * 2 ** level;
}
