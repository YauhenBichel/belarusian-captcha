// Smoke test of the compose demo stack (compose.yaml), the way a visitor and the demo site use it:
// the demo page is served, a pass token is earned from the API (challenge, answer from the
// synthetic pack, proof-of-work, solve) with the demo page's Origin, the demo backend accepts the
// token once through siteverify, and refuses the same token a second time.
//
//   docker compose up -d --build --wait
//   npx tsc -b --builders 1 shared && node scripts/compose-smoke.ts
//
//   BC_DEMO_URL  the demo backend (default http://localhost:3000, Express; Fastify :3001,
//                Flask :3002, FastAPI :3003).
//                CI runs this once per backend.
//   BC_API_URL   the verify API as the browser reaches it (default http://localhost:8080)
//
// Prints one line per step; exits 1 on the first failure. The token is never printed.

import { readFileSync } from 'node:fs';
import {
  API_PREFIX,
  type ChallengeResponse,
  encodePowSolution,
  type SolveOk,
  solvePow,
} from '@belarusian-captcha/shared';
import { answerKey, DEFAULT_PACK, pickAnswers } from './live-monitor.ts';

const demo = (process.env.BC_DEMO_URL || 'http://localhost:3000').replace(/\/+$/, '');
const api = (process.env.BC_API_URL || 'http://localhost:8080').replace(/\/+$/, '');
const origin = new URL(demo).origin;
const SITEKEY = 'demo-sitekey-0001';

function fail(step: string, why: string): never {
  console.log(`FAIL  ${step}: ${why}`);
  process.exit(1);
}

/** fetch, with a failure to connect reported as the step's failure. */
async function request(step: string, url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(15_000) });
  } catch (e) {
    return fail(step, `request failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function json(res: Response, step: string): Promise<Record<string, unknown>> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return fail(step, `HTTP ${res.status}, not JSON`);
  }
}

const page = await request('page', `${demo}/`);
const html = await page.text();
if (page.status !== 200 || !html.includes('<meta name="bc-demo-backend" content="/demo/submit">')) {
  fail('page', `HTTP ${page.status}, or the page is not built for the demo backend`);
}
console.log('ok    page        the demo page is served, its form posts to /demo/submit');

const q = new URLSearchParams({ sitekey: SITEKEY, action: 'demo' });
const ch = await request('challenge', `${api}${API_PREFIX}/challenge?${q}`, {
  headers: { origin },
});
const challenge = (await json(ch, 'challenge')) as unknown as ChallengeResponse;
if (ch.status !== 200) fail('challenge', `HTTP ${ch.status}: ${JSON.stringify(challenge)}`);
const answer = pickAnswers(challenge, answerKey(readFileSync(DEFAULT_PACK, 'utf8')));
const solved = await solvePow(challenge.pow);
if (!solved) fail('pow', 'no solution');
const pow = encodePowSolution({
  algorithm: challenge.pow.algorithm,
  challenge: challenge.pow.challenge,
  number: solved.number,
  salt: challenge.pow.salt,
  signature: challenge.pow.signature,
  took: solved.took,
});
const sv = await request('solve', `${api}${API_PREFIX}/solve`, {
  method: 'POST',
  headers: { origin, 'content-type': 'application/json' },
  body: JSON.stringify({ sealed: challenge.sealed, answer, pow }),
});
const solvedBody = (await json(sv, 'solve')) as unknown as SolveOk;
if (sv.status !== 200 || !solvedBody.token) fail('solve', `HTTP ${sv.status}`);
console.log(`ok    solve       a pass token for ${origin}`);

const submit = (step: string) =>
  request(step, `${demo}/demo/submit`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ 'bc-response': solvedBody.token, comment: 'compose smoke' }),
  });

const first = await submit('submit');
const a = await json(first, 'submit');
const v = a.verify as { success?: boolean; hostname?: string; error_codes?: string[] } | undefined;
if (first.status !== 200 || a.accepted !== true || v?.hostname !== new URL(demo).hostname) {
  fail('submit', `HTTP ${first.status}: ${JSON.stringify(v ?? a)}`);
}
console.log(`ok    submit      the demo backend accepted the token (hostname ${v.hostname})`);

const again = await submit('replay');
const b = await json(again, 'replay');
const codes = (b.verify as { error_codes?: string[] } | undefined)?.error_codes ?? [];
if (again.status !== 400 || b.accepted !== false || !codes.includes('timeout-or-duplicate')) {
  fail('replay', `HTTP ${again.status}: ${JSON.stringify(b)}`);
}
console.log('ok    replay      the same token is refused: timeout-or-duplicate');
console.log('compose smoke test passed');
