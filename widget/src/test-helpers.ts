// A fake verify API for the widget tests: real ALTCHA challenges (small maxnumber, so the real
// solver finds them in milliseconds) and scripted /solve answers. No network.

import {
  type ChallengeResponse,
  createPowChallenge,
  decodePowSolution,
} from '@belarusian-captcha/shared';

export const TEST_POW_KEY = 'test-pow-key';

let counter = 0;

/** A challenge with `questions` questions of four options; the right option id is `r<q>`. */
export async function makeChallenge(questions = 1, maxnumber = 64): Promise<ChallengeResponse> {
  const n = ++counter;
  const expires = Date.now() + 600_000;
  return {
    sealed: `sealed-${n}`,
    type: 'proverb',
    display: {
      questions: Array.from({ length: questions }, (_, q) => ({
        prompt: `SYNTHETIC prompt ${n}.${q}`,
        options: [
          { id: `w${q}a`, text: `wrong ${q} a` },
          { id: `r${q}`, text: `right ${q}` },
          { id: `w${q}b`, text: `wrong ${q} b` },
          { id: `w${q}c`, text: `wrong ${q} c` },
        ],
      })),
    },
    pow: await createPowChallenge({
      hmacKey: TEST_POW_KEY,
      maxnumber,
      expiresAt: expires,
      params: { cid: `cid-${n}` },
      number: Math.floor(maxnumber / 2),
    }),
    expires,
  };
}

export interface Recorded {
  method: string;
  url: URL;
  body?: unknown;
}

export type Reply = { status: number; body?: unknown } | 'network-error';

/**
 * fetch() for /api/v1/challenge and /api/v1/solve. Each endpoint answers from its queue; an
 * empty challenge queue makes a fresh one-question challenge.
 */
export class FakeApi {
  readonly calls: Recorded[] = [];
  readonly challengeReplies: Reply[] = [];
  readonly solveReplies: Reply[] = [];

  readonly fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    this.calls.push({ method, url, body });
    let reply: Reply | undefined;
    if (url.pathname.endsWith('/challenge')) {
      reply = this.challengeReplies.shift() ?? { status: 200, body: await makeChallenge() };
    } else if (url.pathname.endsWith('/solve')) {
      reply = this.solveReplies.shift() ?? { status: 500, body: { error: 'bad-request' } };
    }
    if (!reply || reply === 'network-error') throw new TypeError('Failed to fetch');
    return new Response(JSON.stringify(reply.body ?? {}), {
      status: reply.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  solves(): Recorded[] {
    return this.calls.filter((c) => c.url.pathname.endsWith('/solve'));
  }

  challenges(): Recorded[] {
    return this.calls.filter((c) => c.url.pathname.endsWith('/challenge'));
  }
}

/** The PoW number in a recorded solve body. */
export function powNumber(body: unknown): number | undefined {
  const pow = (body as { pow?: string }).pow;
  return pow ? decodePowSolution(pow)?.number : undefined;
}

/** Waits until `check` is true (polling), or fails after `ms`. */
export async function until(check: () => boolean, ms = 2000): Promise<void> {
  const t0 = Date.now();
  while (!check()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
}
