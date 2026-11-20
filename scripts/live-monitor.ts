// The live monitor: one full pass through a running verify API, the way a site and its visitor
// use it. GET /healthz, GET /challenge (with the monitor site's Origin), answer the proverb from
// the content pack, solve the proof-of-work, POST /solve, then POST /siteverify with the monitor
// site's secret. Any step that fails stops the pass and names itself.
//
// .github/workflows/smoke.yml runs it every 15 minutes against the public URL. Locally, after
// `npm run build` (it imports shared/ from its dist):
//
//   BC_LIVE_URL=https://captcha.example.org BC_MONITOR_SITEKEY=... BC_MONITOR_SECRET=... \
//     node scripts/live-monitor.ts
//
//   BC_LIVE_URL          base URL of the API, no trailing path               (required)
//   BC_MONITOR_SITEKEY   the monitor site's key                              (required)
//   BC_MONITOR_SECRET    the monitor site's siteverify secret                (required; never printed)
//   BC_MONITOR_ORIGIN    the Origin sent to /challenge and /solve; must be one of the site's hostnames
//                        (default https://live-monitor.belarusian-captcha.invalid)
//   BC_MONITOR_PACK      the content pack the server runs, as the answer key
//                        (default server/test/fixtures/synthetic-pack.json)
//   BC_MONITOR_TIMEOUT_MS  per request (default 15000)
//
// The answer key is the pack itself, so this works only while the server runs a pack the monitor
// can read (today the synthetic one). The output is one line per step and a final JSON line; the
// secret and the pass token never appear in it.

import { readFileSync } from 'node:fs';
import {
  API_PREFIX,
  type ChallengeResponse,
  encodePowSolution,
  type SiteverifyResponse,
  type SolveOk,
  solvePow,
} from '@belarusian-captcha/shared';

export const DEFAULT_ORIGIN = 'https://live-monitor.belarusian-captcha.invalid';
export const DEFAULT_PACK = 'server/test/fixtures/synthetic-pack.json';

export interface MonitorConfig {
  baseUrl: string;
  sitekey: string;
  secret: string;
  origin: string;
  /** prompt (the item's `cut`) -> the right ending. */
  answers: ReadonlyMap<string, string>;
  timeoutMs: number;
}

export type Step = 'config' | 'healthz' | 'challenge' | 'answer' | 'pow' | 'solve' | 'siteverify';

export interface StepResult {
  step: Step;
  ok: boolean;
  ms: number;
  detail: string;
}

export interface MonitorResult {
  ok: boolean;
  /** The step that failed, when one did. */
  failed?: Step;
  steps: StepResult[];
  packVersion?: string;
}

export class StepError extends Error {
  override name = 'StepError';
  // A plain field, not a parameter property: node runs this file by stripping types only.
  readonly step: Step;
  constructor(step: Step, message: string) {
    super(message);
    this.step = step;
  }
}

/** The answer key from a bc-pack-json-v1 file: every live item's cut -> its ending. */
export function answerKey(packText: string): Map<string, string> {
  const doc = JSON.parse(packText) as { items?: unknown };
  if (!Array.isArray(doc.items)) throw new Error('pack has no items');
  const key = new Map<string, string>();
  for (const raw of doc.items) {
    const it = raw as Record<string, unknown>;
    if (it.status === 'live' && typeof it.cut === 'string' && typeof it.ending === 'string') {
      key.set(it.cut, it.ending);
    }
  }
  if (key.size === 0) throw new Error('pack has no live items');
  return key;
}

/** The option id of the right ending for each question, in order. */
export function pickAnswers(c: ChallengeResponse, answers: ReadonlyMap<string, string>): string[] {
  return c.display.questions.map((q, i) => {
    const ending = answers.get(q.prompt);
    if (ending === undefined) {
      throw new StepError('answer', `question ${i + 1}: prompt not in the answer key`);
    }
    const opt = q.options.find((o) => o.text === ending);
    if (!opt)
      throw new StepError('answer', `question ${i + 1}: right ending not among the options`);
    return opt.id;
  });
}

/** Reads the configuration from the environment; missing values are reported by name only. */
export function configFromEnv(env: NodeJS.ProcessEnv, readFile = readFileSync): MonitorConfig {
  const missing = ['BC_LIVE_URL', 'BC_MONITOR_SITEKEY', 'BC_MONITOR_SECRET'].filter((k) => !env[k]);
  if (missing.length) throw new StepError('config', `missing ${missing.join(', ')}`);
  let base: URL;
  try {
    base = new URL(env.BC_LIVE_URL as string);
  } catch {
    throw new StepError('config', 'BC_LIVE_URL is not a URL');
  }
  if (base.protocol !== 'https:' && base.protocol !== 'http:') {
    throw new StepError('config', 'BC_LIVE_URL must be http or https');
  }
  const timeoutMs = Number(env.BC_MONITOR_TIMEOUT_MS ?? 15_000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new StepError('config', 'BC_MONITOR_TIMEOUT_MS must be a positive integer');
  }
  return {
    baseUrl: base.origin + base.pathname.replace(/\/+$/, ''),
    sitekey: env.BC_MONITOR_SITEKEY as string,
    secret: env.BC_MONITOR_SECRET as string,
    origin: env.BC_MONITOR_ORIGIN || DEFAULT_ORIGIN,
    answers: answerKey(readFile(env.BC_MONITOR_PACK || DEFAULT_PACK, 'utf8') as string),
    timeoutMs,
  };
}

async function call(
  step: Step,
  cfg: MonitorConfig,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: unknown }> {
  let res: Response;
  try {
    res = await fetch(cfg.baseUrl + path, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
  } catch (e) {
    const why =
      e instanceof Error ? (e.name === 'TimeoutError' ? 'timed out' : e.message) : 'error';
    throw new StepError(step, `request failed: ${why}`);
  }
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new StepError(step, `HTTP ${res.status}, not JSON`);
  }
  return { status: res.status, body };
}

function errorCode(body: unknown): string {
  const b = body as { error?: unknown; 'error-codes'?: unknown };
  if (typeof b?.error === 'string') return b.error;
  if (Array.isArray(b?.['error-codes'])) return b['error-codes'].join(',') || 'none';
  return 'no error code';
}

/** One full pass. Never throws: a failure is a result with `ok: false` and the failed step. */
export async function runMonitor(
  cfg: MonitorConfig,
  log: (line: string) => void = () => {},
): Promise<MonitorResult> {
  const steps: StepResult[] = [];
  const result: MonitorResult = { ok: false, steps };
  let t0 = performance.now();
  const done = (step: Step, detail: string) => {
    const ms = Math.round(performance.now() - t0);
    steps.push({ step, ok: true, ms, detail });
    log(`ok    ${step.padEnd(10)} ${String(ms).padStart(6)} ms  ${detail}`);
    t0 = performance.now();
  };

  try {
    const health = await call('healthz', cfg, '/healthz');
    const h = health.body as { ok?: unknown; pack_version?: unknown };
    if (health.status !== 200 || h.ok !== true) {
      throw new StepError('healthz', `HTTP ${health.status}, ok=${String(h.ok)}`);
    }
    if (typeof h.pack_version === 'string') result.packVersion = h.pack_version;
    done('healthz', `pack ${result.packVersion ?? 'unknown'}`);

    const q = new URLSearchParams({ sitekey: cfg.sitekey, action: 'live-monitor' });
    const ch = await call('challenge', cfg, `${API_PREFIX}/challenge?${q}`, {
      headers: { origin: cfg.origin },
    });
    if (ch.status !== 200) {
      throw new StepError('challenge', `HTTP ${ch.status}: ${errorCode(ch.body)}`);
    }
    const challenge = ch.body as ChallengeResponse;
    if (!challenge.sealed || !challenge.pow || !challenge.display?.questions?.length) {
      throw new StepError('challenge', 'response is missing sealed, pow or questions');
    }
    done('challenge', `${challenge.display.questions.length} question(s)`);

    const answer = pickAnswers(challenge, cfg.answers);
    done('answer', `${answer.length} answer(s) from the pack`);

    const solved = await solvePow(challenge.pow);
    if (!solved) throw new StepError('pow', `no solution up to ${challenge.pow.maxnumber}`);
    const pow = encodePowSolution({
      algorithm: challenge.pow.algorithm,
      challenge: challenge.pow.challenge,
      number: solved.number,
      salt: challenge.pow.salt,
      signature: challenge.pow.signature,
      took: solved.took,
    });
    done('pow', `maxnumber ${challenge.pow.maxnumber}`);

    const sv = await call('solve', cfg, `${API_PREFIX}/solve`, {
      method: 'POST',
      headers: { origin: cfg.origin, 'content-type': 'application/json' },
      body: JSON.stringify({ sealed: challenge.sealed, answer, pow }),
    });
    if (sv.status !== 200) throw new StepError('solve', `HTTP ${sv.status}: ${errorCode(sv.body)}`);
    const token = (sv.body as SolveOk).token;
    if (typeof token !== 'string' || !token) throw new StepError('solve', 'no token in the answer');
    done('solve', 'pass token issued');

    const vr = await call('siteverify', cfg, `${API_PREFIX}/siteverify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        secret: cfg.secret,
        response: token,
        sitekey: cfg.sitekey,
        action: 'live-monitor',
      }),
    });
    const v = vr.body as SiteverifyResponse;
    if (vr.status !== 200 || v.success !== true) {
      throw new StepError('siteverify', `HTTP ${vr.status}: ${errorCode(vr.body)}`);
    }
    const expected = new URL(cfg.origin).hostname;
    if (v.hostname !== expected) {
      throw new StepError('siteverify', `hostname ${String(v.hostname)}, expected ${expected}`);
    }
    done('siteverify', `success, hostname ${v.hostname}`);
    result.ok = true;
  } catch (e) {
    const step = e instanceof StepError ? e.step : 'config';
    const detail = e instanceof Error ? e.message : String(e);
    const ms = Math.round(performance.now() - t0);
    steps.push({ step, ok: false, ms, detail });
    log(`FAIL  ${step.padEnd(10)} ${String(ms).padStart(6)} ms  ${detail}`);
    result.failed = step;
  }
  return result;
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  let cfg: MonitorConfig;
  try {
    cfg = configFromEnv(env);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.log(`FAIL  config  ${detail}`);
    console.log(JSON.stringify({ ok: false, failed: 'config', steps: [] }));
    return 1;
  }
  console.log(`live monitor: ${cfg.baseUrl} (site ${cfg.sitekey})`);
  const r = await runMonitor(cfg, (line) => console.log(line));
  console.log(JSON.stringify(r));
  return r.ok ? 0 : 1;
}

if (import.meta.main) {
  process.exitCode = await main();
}
