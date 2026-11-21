// Pass tokens: `<kid>.<base64url(JSON payload)>.<base64url(HMAC-SHA-256)>`.
// Signed, not encrypted: the payload holds nothing secret and a site may read it.
// Single use is enforced by the server's spent store (the `tid`), not here.

import { hmacSha256 } from './crypto.js';
import { base64urlDecode, base64urlEncode, fromUtf8, timingSafeEqual, utf8 } from './encoding.js';
import { type KeyRing, KID_PATTERN } from './keys.js';

export const MAX_TOKEN_LENGTH = 2048;

export interface PassTokenPayload {
  v: 1;
  /** Token id, spent once at siteverify. */
  tid: string;
  sitekey: string;
  hostname: string;
  action: string;
  /** 1 for a solved language challenge; FALLBACK_SCORE for the PoW-only fallback. */
  score: number;
  /** Present and true only for a fallback pass. Absent in tokens issued before it existed. */
  fallback?: true;
  /** Issued at, unix seconds. */
  iat: number;
  /** Expires at, unix seconds. */
  exp: number;
}

export type TokenVerifyResult =
  | { ok: true; payload: PassTokenPayload }
  | { ok: false; error: 'invalid-input-response' }
  /** Authentic but expired: the payload is returned so the caller can check the secret first. */
  | { ok: false; error: 'timeout-or-duplicate'; payload: PassTokenPayload };

function signingInput(kid: string, body: string): Uint8Array<ArrayBuffer> {
  return utf8(`belarusian-captcha token v1:${kid}.${body}`);
}

export async function issuePassToken(ring: KeyRing, payload: PassTokenPayload): Promise<string> {
  const kid = ring.active;
  const keys = await (ring.keys(kid) as NonNullable<ReturnType<KeyRing['keys']>>);
  const body = base64urlEncode(utf8(JSON.stringify(payload)));
  const mac = await hmacSha256(keys.token, signingInput(kid, body));
  return `${kid}.${body}.${base64urlEncode(mac)}`;
}

function isPayload(v: unknown): v is PassTokenPayload {
  if (typeof v !== 'object' || v === null) return false;
  const p = v as Record<string, unknown>;
  return (
    p.v === 1 &&
    typeof p.tid === 'string' &&
    typeof p.sitekey === 'string' &&
    typeof p.hostname === 'string' &&
    typeof p.action === 'string' &&
    typeof p.score === 'number' &&
    (p.fallback === undefined || p.fallback === true) &&
    Number.isSafeInteger(p.iat) &&
    Number.isSafeInteger(p.exp)
  );
}

/** Checks format, kid, signature (constant time) and expiry. Does not spend the token. */
export async function verifyPassToken(
  ring: KeyRing,
  token: string,
  nowMs: number,
): Promise<TokenVerifyResult> {
  const bad = { ok: false, error: 'invalid-input-response' } as const;
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH)
    return bad;
  const parts = token.split('.');
  if (parts.length !== 3) return bad;
  const [kid, body, macText] = parts as [string, string, string];
  if (!KID_PATTERN.test(kid)) return bad;
  const keysPromise = ring.keys(kid);
  if (!keysPromise) return bad;
  let mac: Uint8Array<ArrayBuffer>;
  try {
    mac = base64urlDecode(macText);
  } catch {
    return bad;
  }
  const keys = await keysPromise;
  const expected = await hmacSha256(keys.token, signingInput(kid, body));
  if (!timingSafeEqual(mac, expected)) return bad;
  let payload: unknown;
  try {
    payload = JSON.parse(fromUtf8(base64urlDecode(body)));
  } catch {
    return bad;
  }
  if (!isPayload(payload)) return bad;
  if (payload.exp * 1000 <= nowMs) return { ok: false, error: 'timeout-or-duplicate', payload };
  return { ok: true, payload };
}
