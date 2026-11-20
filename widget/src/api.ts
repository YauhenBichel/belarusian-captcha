// The widget's two calls to the verify API (docs/DESIGN.md section 5.1): GET /challenge and
// POST /solve. No cookies are sent. A network failure (the API cannot be reached, or CORS refused
// the answer) is told apart from an API error code, so the widget can say which one it was.

import {
  API_PREFIX,
  type ChallengeResponse,
  type ErrorCode,
  type SolveRequest,
} from '@belarusian-captcha/shared';

/** An error code from the API, or one of the widget's own. */
export type WidgetErrorCode = ErrorCode | 'network-error' | 'bad-response' | 'pow-failed';

export class ApiError extends Error {
  override name = 'ApiError';
  constructor(
    readonly code: WidgetErrorCode,
    readonly status = 0,
  ) {
    super(code);
  }
}

export type SolveResult =
  | { ok: true; token: string; expires: number }
  | { ok: false; error: WidgetErrorCode; next?: ChallengeResponse };

export interface ChallengeQuery {
  sitekey: string;
  lang?: string | undefined;
  script?: string | undefined;
  types?: string | undefined;
  action?: string | undefined;
}

export const REQUEST_TIMEOUT_MS = 15_000;

export class ApiClient {
  readonly #base: string;
  readonly #fetch: typeof fetch;

  /** `base` is the API origin, with an optional path prefix (no trailing slash needed). */
  constructor(base: string, fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)) {
    this.#base = base.replace(/\/+$/, '');
    this.#fetch = fetchImpl;
  }

  async challenge(q: ChallengeQuery): Promise<ChallengeResponse> {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v) params.set(k, v);
    const res = await this.#send(`${this.#base}${API_PREFIX}/challenge?${params}`, {
      method: 'GET',
    });
    const body = await readJson(res);
    if (!res.ok) throw new ApiError(errorCode(body), res.status);
    if (!isChallenge(body)) throw new ApiError('bad-response', res.status);
    return body;
  }

  async solve(req: SolveRequest): Promise<SolveResult> {
    const res = await this.#send(`${this.#base}${API_PREFIX}/solve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(req),
    });
    const body = await readJson(res);
    if (res.ok) {
      const b = body as { token?: unknown; expires?: unknown } | undefined;
      if (typeof b?.token !== 'string' || typeof b.expires !== 'number') {
        return { ok: false, error: 'bad-response' };
      }
      return { ok: true, token: b.token, expires: b.expires };
    }
    const next = (body as { next?: unknown } | undefined)?.next;
    return { ok: false, error: errorCode(body), ...(isChallenge(next) ? { next } : {}) };
  }

  async #send(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.#fetch(url, {
        ...init,
        credentials: 'omit',
        mode: 'cors',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new ApiError('network-error');
    }
  }
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

function errorCode(body: unknown): WidgetErrorCode {
  const e = (body as { error?: unknown } | undefined)?.error;
  return typeof e === 'string' && /^[a-z-]{1,40}$/.test(e) ? (e as ErrorCode) : 'bad-response';
}

export function isChallenge(v: unknown): v is ChallengeResponse {
  if (typeof v !== 'object' || v === null) return false;
  const c = v as Partial<ChallengeResponse>;
  return (
    typeof c.sealed === 'string' &&
    typeof c.expires === 'number' &&
    typeof c.pow?.challenge === 'string' &&
    typeof c.pow.salt === 'string' &&
    typeof c.pow.maxnumber === 'number' &&
    Array.isArray(c.display?.questions) &&
    c.display.questions.length > 0 &&
    c.display.questions.every(
      (q) =>
        typeof q?.prompt === 'string' &&
        Array.isArray(q.options) &&
        q.options.every((o) => typeof o?.id === 'string' && typeof o.text === 'string'),
    )
  );
}
