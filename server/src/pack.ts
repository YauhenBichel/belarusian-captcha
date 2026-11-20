// The content pack: read-only items the challenge generator draws from.
//
// Phase 1 core reads a JSON pack (format "bc-pack-json-v1"). The design's pack.sqlite, built by
// the Python content pipeline from reviewed YAML items, replaces this loader in a later pull
// request; the item shape is the same. Only items with status "live" are ever served, and the
// server refuses to start without enough of them (it fails closed).

import { createHash } from 'node:crypto';

export type Difficulty = 'easy' | 'normal' | 'hard';
export type ItemStatus = 'draft' | 'reviewed' | 'live' | 'retired';

export interface ProverbItem {
  id: string;
  /** Items that are variants of one saying share a family; never distractors for each other. */
  family: string;
  /** What the visitor sees. */
  cut: string;
  /** The right answer. */
  ending: string;
  difficulty: Difficulty;
  status: ItemStatus;
}

export interface ContentPack {
  version: string;
  /** sha256 of the pack file, first 12 hex characters. */
  checksum: string;
  live: ProverbItem[];
}

/** One right ending and three distractors from other families. */
export const MIN_LIVE_FAMILIES = 4;

export class PackError extends Error {
  override name = 'PackError';
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const DIFFICULTIES = new Set(['easy', 'normal', 'hard']);
const STATUSES = new Set(['draft', 'reviewed', 'live', 'retired']);

export function parsePack(text: string): ContentPack {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new PackError('pack is not valid JSON');
  }
  const d = doc as Record<string, unknown>;
  if (d?.format !== 'bc-pack-json-v1') throw new PackError('pack format must be bc-pack-json-v1');
  if (typeof d.version !== 'string' || !d.version) throw new PackError('pack version missing');
  if (!Array.isArray(d.items)) throw new PackError('pack items must be a list');
  const ids = new Set<string>();
  const live: ProverbItem[] = [];
  for (const [i, raw] of d.items.entries()) {
    const it = raw as Record<string, unknown>;
    const where = `items[${i}]`;
    for (const f of ['id', 'family', 'cut', 'ending', 'difficulty', 'status']) {
      if (typeof it?.[f] !== 'string' || !(it[f] as string).trim()) {
        throw new PackError(`${where}.${f} must be a non-empty string`);
      }
    }
    const item = it as unknown as ProverbItem;
    if (!ID.test(item.id) || !ID.test(item.family)) throw new PackError(`${where}: bad id/family`);
    if (ids.has(item.id)) throw new PackError(`${where}: duplicate id ${item.id}`);
    ids.add(item.id);
    if (!DIFFICULTIES.has(item.difficulty)) throw new PackError(`${where}.difficulty`);
    if (!STATUSES.has(item.status)) throw new PackError(`${where}.status`);
    if (item.cut.length > 200 || item.ending.length > 200)
      throw new PackError(`${where}: too long`);
    if (item.status === 'live') {
      live.push({
        id: item.id,
        family: item.family,
        cut: item.cut,
        ending: item.ending,
        difficulty: item.difficulty,
        status: item.status,
      });
    }
  }
  const families = new Set(live.map((x) => x.family));
  if (families.size < MIN_LIVE_FAMILIES) {
    throw new PackError(`pack needs live items from at least ${MIN_LIVE_FAMILIES} families`);
  }
  return {
    version: d.version,
    checksum: createHash('sha256').update(text).digest('hex').slice(0, 12),
    live,
  };
}
