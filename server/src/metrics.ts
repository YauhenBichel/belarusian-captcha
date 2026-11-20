// Prometheus metrics (docs/DESIGN.md section 5.5), served on a separate port.

import { Counter, collectDefaultMetrics, Histogram, Registry } from 'prom-client';

export interface Metrics {
  registry: Registry;
  challenges: Counter<'site' | 'type' | 'level'>;
  solves: Counter<'site' | 'type' | 'result'>;
  siteverify: Counter<'site' | 'result'>;
  rateLimited: Counter<'site'>;
  powLevel: Histogram<'site'>;
  solveSeconds: Histogram<'site' | 'type'>;
  renderSeconds: Histogram<'type'>;
  itemAnswers: Counter<'item' | 'result'>;
  /**
   * The `item` label for an item id: the id itself for the first `maxItemLabels` distinct ids,
   * then "other". Keeps bc_item_answers_total bounded however large the pack grows, while the
   * design's per-item wrong-answer rate (section 11) stays available for a pack of normal size.
   */
  itemLabel(item: string): string;
}

/** Default cap on distinct `item` label values (two results each, so twice as many series). */
export const MAX_ITEM_LABELS = 500;

export function createMetrics(opts: { defaults?: boolean; maxItemLabels?: number } = {}): Metrics {
  const registry = new Registry();
  const maxItemLabels = opts.maxItemLabels ?? MAX_ITEM_LABELS;
  const labelled = new Set<string>();
  if (opts.defaults) collectDefaultMetrics({ register: registry, prefix: 'bc_' });
  const registers = [registry];
  return {
    registry,
    challenges: new Counter({
      name: 'bc_challenges_total',
      help: 'Challenges issued',
      labelNames: ['site', 'type', 'level'],
      registers,
    }),
    solves: new Counter({
      name: 'bc_solves_total',
      help: 'Solve attempts by result (ok or an error code)',
      labelNames: ['site', 'type', 'result'],
      registers,
    }),
    siteverify: new Counter({
      name: 'bc_siteverify_total',
      help: 'siteverify calls by result (ok or an error code)',
      labelNames: ['site', 'result'],
      registers,
    }),
    rateLimited: new Counter({
      name: 'bc_rate_limited_total',
      help: 'Challenge requests refused over the hard limit',
      labelNames: ['site'],
      registers,
    }),
    powLevel: new Histogram({
      name: 'bc_pow_level',
      help: 'Level of issued challenges',
      labelNames: ['site'],
      buckets: [0, 1, 2, 3, 4, 5, 6, 8, 10],
      registers,
    }),
    solveSeconds: new Histogram({
      name: 'bc_solve_seconds',
      help: 'Time from challenge issue to solve',
      labelNames: ['site', 'type'],
      buckets: [1, 2, 3, 5, 8, 13, 21, 34, 60, 120, 300, 600],
      registers,
    }),
    renderSeconds: new Histogram({
      name: 'bc_render_seconds',
      help: 'Time to build a challenge',
      labelNames: ['type'],
      buckets: [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25],
      registers,
    }),
    itemAnswers: new Counter({
      name: 'bc_item_answers_total',
      help: `Answers per content item (right or wrong-answer), to retire items people fail; item="other" past ${maxItemLabels} distinct items`,
      labelNames: ['item', 'result'],
      registers,
    }),
    itemLabel(item: string): string {
      if (labelled.has(item)) return item;
      if (labelled.size >= maxItemLabels) return 'other';
      labelled.add(item);
      return item;
    },
  };
}
