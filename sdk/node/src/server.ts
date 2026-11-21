// belarusian-captcha/server: verify a pass token from the site's backend (design section 6.4).
//
// One call, POST /api/v1/siteverify, with no runtime dependencies: Node 24's fetch and
// AbortSignal. The secret goes only into the request body; it is never logged, never put in an
// error message and never sent after a redirect.

/** Error codes the verify API returns (kept in step with `ErrorCode` in shared/src/protocol.ts). */
export type ApiErrorCode =
  | 'invalid-sitekey'
  | 'invalid-secret'
  | 'invalid-input-response'
  | 'timeout-or-duplicate'
  | 'hostname-mismatch'
  | 'rate-limited'
  | 'bad-pow'
  | 'wrong-answer'
  | 'bad-request'
  | 'action-mismatch'
  | 'store-unavailable';

/**
 * Codes the SDK adds itself:
 * - `captcha-unavailable`: the API could not be reached, timed out, answered 5xx or something
 *   that is not a siteverify answer. With `failOpen` the result is still `success: true`.
 * - `score-below-threshold`: the API accepted the token but its score is under `minScore`.
 */
export type SdkErrorCode = 'captcha-unavailable' | 'score-below-threshold';

export type VerifyErrorCode = ApiErrorCode | SdkErrorCode;

export interface VerifyOptions {
  /** The site's secret key. Keep it in the environment, never in code. */
  secret: string;
  /** Base URL of the captcha API, e.g. `https://captcha.example.by` (no `/api/v1`). */
  url: string;
  /** The visitor's IP, forwarded to the API (optional). */
  remoteip?: string;
  /** If given, the token must have been issued for this site key. */
  sitekey?: string;
  /** If given, the token's action must equal it (checked by the API before the token is spent). */
  action?: string;
  /** Lowest accepted score, 0..1. A lower score gives `success: false`. Default: no threshold. */
  minScore?: number;
  /**
   * What to answer when the API is unavailable: `false` (the default, D11) refuses the form;
   * `true` lets it through with `unavailable: true` so the site can send it to moderation.
   */
  failOpen?: boolean;
  /** Request timeout in milliseconds. Default 3000. */
  timeout?: number;
  /** Abort the request from outside (e.g. the client hung up). */
  signal?: AbortSignal;
  /** A fetch implementation, for tests or a custom agent. Default: the global fetch. */
  fetch?: typeof fetch;
}

export interface VerifyResult {
  /** True only if the token is valid, unspent, for this site, and at or above `minScore`. */
  success: boolean;
  /** 0..1, from the token; absent when the API did not accept the token. */
  score?: number;
  /** The hostname the challenge was solved on. */
  hostname?: string;
  action?: string;
  /** ISO 8601 time the challenge was solved. */
  challenge_ts?: string;
  /**
   * True when the visitor took the accessible way through ("I cannot do this challenge"): no
   * question was answered, only a harder proof-of-work, and the score is low (0.3). Present
   * whenever the API accepted the token; false for an API that predates the fallback.
   */
  fallback?: boolean;
  error_codes: VerifyErrorCode[];
  /** True when the API could not give an answer (see `failOpen`). */
  unavailable: boolean;
}

export const DEFAULT_TIMEOUT_MS = 3000;
const SITEVERIFY_PATH = '/api/v1/siteverify';

/**
 * Checks a pass token (the `bc-response` form field) with the captcha API.
 *
 * Never throws for anything the visitor or the network does: a bad token, a refusal, a timeout
 * or a broken API all come back as a result. It throws `TypeError` only for wrong options
 * (no secret, a bad URL, a bad `minScore` or `timeout`), which are bugs in the calling code.
 */
export async function verify(
  token: string | null | undefined,
  options: VerifyOptions,
): Promise<VerifyResult> {
  const endpoint = checkOptions(options);
  if (typeof token !== 'string' || token === '' || token.length > 4096) {
    return refused(['invalid-input-response']);
  }

  const body: Record<string, string> = { secret: options.secret, response: token };
  if (options.remoteip !== undefined) body.remoteip = options.remoteip;
  if (options.sitekey !== undefined) body.sitekey = options.sitekey;
  if (options.action !== undefined) body.action = options.action;

  const timeout = AbortSignal.timeout(options.timeout ?? DEFAULT_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
  const doFetch = options.fetch ?? globalThis.fetch;

  let status: number;
  let data: unknown;
  try {
    const res = await doFetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
      // A redirect would carry the secret to a URL the site did not configure.
      redirect: 'error',
      signal,
    });
    status = res.status;
    data = await res.json().catch(() => undefined);
  } catch {
    return unavailable(options);
  }

  // 5xx (including 503 store-unavailable) means the API could not decide: that is the
  // fail-open / fail-closed case. 2xx and 429 carry a real siteverify answer.
  if (status >= 500 || !isSiteverifyAnswer(data)) return unavailable(options);

  if (!data.success) {
    const codes = data['error-codes'].filter((c): c is ApiErrorCode => typeof c === 'string');
    return refused(codes.length > 0 ? codes : ['invalid-input-response']);
  }

  const result: VerifyResult = { success: true, error_codes: [], unavailable: false };
  if (typeof data.score === 'number') result.score = data.score;
  if (typeof data.hostname === 'string') result.hostname = data.hostname;
  if (typeof data.action === 'string') result.action = data.action;
  if (typeof data.challenge_ts === 'string') result.challenge_ts = data.challenge_ts;
  result.fallback = data.fallback === true;

  if (options.minScore !== undefined && (result.score ?? 0) < options.minScore) {
    result.success = false;
    result.error_codes = ['score-below-threshold'];
  }
  return result;
}

function checkOptions(options: VerifyOptions): string {
  if (!options || typeof options.secret !== 'string' || options.secret === '') {
    throw new TypeError('belarusian-captcha: options.secret is required');
  }
  let base: URL;
  try {
    base = new URL(options.url);
  } catch {
    throw new TypeError('belarusian-captcha: options.url must be an absolute URL');
  }
  if (base.protocol !== 'https:' && base.protocol !== 'http:') {
    throw new TypeError('belarusian-captcha: options.url must be http or https');
  }
  if (base.username || base.password || base.search || base.hash) {
    throw new TypeError('belarusian-captcha: options.url must be a plain base URL');
  }
  const { minScore, timeout } = options;
  if (minScore !== undefined && !(minScore >= 0 && minScore <= 1)) {
    throw new TypeError('belarusian-captcha: options.minScore must be between 0 and 1');
  }
  if (timeout !== undefined && !(Number.isFinite(timeout) && timeout > 0)) {
    throw new TypeError('belarusian-captcha: options.timeout must be a positive number of ms');
  }
  return base.origin + base.pathname.replace(/\/+$/, '') + SITEVERIFY_PATH;
}

interface SiteverifyAnswer {
  success: boolean;
  score?: unknown;
  hostname?: unknown;
  action?: unknown;
  challenge_ts?: unknown;
  fallback?: unknown;
  'error-codes': unknown[];
}

function isSiteverifyAnswer(data: unknown): data is SiteverifyAnswer {
  if (!data || typeof data !== 'object') return false;
  const d = data as Record<string, unknown>;
  return typeof d.success === 'boolean' && Array.isArray(d['error-codes']);
}

function refused(codes: VerifyErrorCode[]): VerifyResult {
  return { success: false, error_codes: codes, unavailable: false };
}

function unavailable(options: VerifyOptions): VerifyResult {
  return {
    success: options.failOpen === true,
    error_codes: ['captcha-unavailable'],
    unavailable: true,
  };
}
