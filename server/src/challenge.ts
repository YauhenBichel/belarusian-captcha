// Builds a proverb challenge (docs/DESIGN.md sections 3.4, 4.2, 4.3): pick the item(s), draw
// distractors from the endings of other live items, shuffle under random option ids, seal the
// answer and attach an ALTCHA-compatible proof-of-work bound to the challenge id.

import {
  type ChallengeResponse,
  createPowChallenge,
  type KeyRing,
  normaliseAnswer,
  type ProverbQuestion,
  randomId,
  randomInt,
  seal,
  sha256Hex,
} from '@belarusian-captcha/shared';
import type { SiteConfig } from './config.js';
import type { ContentPack, Difficulty, ProverbItem } from './pack.js';
import { powMaxNumber } from './rate.js';

export const OPTIONS_PER_QUESTION = 4;
export const TWO_QUESTION_LEVEL = 4;

/** What travels inside the seal. Short keys: it goes to the browser and back. */
export interface SealedChallenge {
  v: 1;
  cid: string;
  sk: string;
  t: 'proverb';
  /** sha256(cid | option ids of the right answers, in question order). */
  ah: string;
  lvl: number;
  /** Item ids, for per-item metrics. */
  items: string[];
  /** Bucket of the client that asked, for failure counting. */
  b: string;
  act: string;
  /** Unix ms. */
  iat: number;
  exp: number;
}

export function isSealedChallenge(v: unknown): v is SealedChallenge {
  if (typeof v !== 'object' || v === null) return false;
  const c = v as Record<string, unknown>;
  return (
    c.v === 1 &&
    typeof c.cid === 'string' &&
    typeof c.sk === 'string' &&
    c.t === 'proverb' &&
    typeof c.ah === 'string' &&
    typeof c.lvl === 'number' &&
    Array.isArray(c.items) &&
    typeof c.b === 'string' &&
    typeof c.act === 'string' &&
    typeof c.iat === 'number' &&
    typeof c.exp === 'number'
  );
}

export function answerHash(cid: string, optionIds: readonly string[]): Promise<string> {
  return sha256Hex(`${cid}|${optionIds.join(',')}`);
}

function shuffle<T>(xs: T[]): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i);
    [a[i], a[j]] = [a[j] as T, a[i] as T];
  }
  return a;
}

function pickOne<T>(xs: readonly T[]): T {
  return xs[randomInt(xs.length - 1)] as T;
}

const words = (s: string) => s.trim().split(/\s+/u).length;

export function difficultyFor(level: number): Difficulty {
  return level >= 2 ? 'normal' : 'easy';
}

/** Picks the items to ask: from the level's difficulty when there are any, avoiding recent ones. */
export function pickItems(
  pack: ContentPack,
  level: number,
  recent: ReadonlySet<string>,
): ProverbItem[] {
  const count = level >= TWO_QUESTION_LEVEL ? 2 : 1;
  const wanted = difficultyFor(level);
  const byDifficulty = pack.live.filter((x) => x.difficulty === wanted);
  const pool = byDifficulty.length >= count ? byDifficulty : pack.live;
  const fresh = pool.filter((x) => !recent.has(x.id));
  const chosen: ProverbItem[] = [];
  for (let k = 0; k < count; k++) {
    const families = new Set(chosen.map((x) => x.family));
    const candidates = (fresh.length >= count ? fresh : pool).filter(
      (x) => !families.has(x.family),
    );
    chosen.push(pickOne(candidates.length ? candidates : pack.live));
  }
  return chosen;
}

/**
 * Three distractors: endings of live items from other families, preferring the same length in
 * words (within one), so the right ending is not the only one that fits; never the same text.
 */
export function pickDistractors(pack: ContentPack, item: ProverbItem): string[] {
  const right = normaliseAnswer(item.ending);
  const others = pack.live.filter(
    (x) => x.family !== item.family && normaliseAnswer(x.ending) !== right,
  );
  const n = words(item.ending);
  const similar = shuffle(others.filter((x) => Math.abs(words(x.ending) - n) <= 1));
  const rest = shuffle(others.filter((x) => Math.abs(words(x.ending) - n) > 1));
  const out: string[] = [];
  const seen = new Set([right]);
  for (const x of [...similar, ...rest]) {
    const key = normaliseAnswer(x.ending);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(x.ending);
    if (out.length === OPTIONS_PER_QUESTION - 1) break;
  }
  if (out.length < OPTIONS_PER_QUESTION - 1) throw new Error('not enough distinct distractors');
  return out;
}

export interface BuildChallengeInput {
  ring: KeyRing;
  pack: ContentPack;
  site: SiteConfig;
  level: number;
  bucket: string;
  action: string;
  recent: ReadonlySet<string>;
  nowMs: number;
}

export async function buildProverbChallenge(
  input: BuildChallengeInput,
): Promise<{ response: ChallengeResponse; itemIds: string[] }> {
  const { ring, pack, site, level, nowMs } = input;
  const items = pickItems(pack, level, input.recent);
  const cid = randomId(16);
  const questions: ProverbQuestion[] = [];
  const rightIds: string[] = [];
  for (const item of items) {
    const right = { id: randomId(6), text: item.ending };
    const wrong = pickDistractors(pack, item).map((text) => ({ id: randomId(6), text }));
    questions.push({ prompt: item.cut, options: shuffle([right, ...wrong]) });
    rightIds.push(right.id);
  }
  const exp = nowMs + site.challengeTtlS * 1000;
  const sealedValue: SealedChallenge = {
    v: 1,
    cid,
    sk: site.sitekey,
    t: 'proverb',
    ah: await answerHash(cid, rightIds),
    lvl: level,
    items: items.map((x) => x.id),
    b: input.bucket,
    act: input.action,
    iat: nowMs,
    exp,
  };
  const keys = await ring.keys(ring.active);
  if (!keys) throw new Error('active key missing');
  const pow = await createPowChallenge({
    hmacKey: keys.pow,
    maxnumber: powMaxNumber(site, level),
    expiresAt: exp,
    params: { cid },
  });
  return {
    response: {
      sealed: await seal(ring, sealedValue),
      type: 'proverb',
      display: { questions },
      pow,
      expires: exp,
    },
    itemIds: sealedValue.items,
  };
}
