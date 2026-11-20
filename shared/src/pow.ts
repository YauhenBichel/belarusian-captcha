// ALTCHA-compatible SHA-256 proof-of-work (the classic "v1" scheme of altcha-lib).
//
//   salt      = <hex random> "?" <url params, including expires=<unix s>> "&"
//   challenge = hex(SHA-256(salt + number)),   number secret in [0, maxnumber]
//   signature = hex(HMAC-SHA-256(key, challenge))      key: the UTF-8 string `key`
//   payload   = base64(JSON {algorithm, challenge, number, salt, signature, took})
//
// Any ALTCHA server library given the same key string can verify our payloads, and
// ALTCHA's own widget can solve our challenges. Unlike altcha-lib, verification here
// REQUIRES an expiry, and replay is stopped by the caller (the challenge id in the
// salt is spent once in the server's store).

import { hmacSha256, randomBytes, randomInt, sha256Hex } from './crypto.js';
import {
  base64Decode,
  base64Encode,
  bytesToHex,
  fromUtf8,
  timingSafeEqualString,
  utf8,
} from './encoding.js';

export const POW_ALGORITHM = 'SHA-256';
/** Largest payload accepted (base64 characters); a real one is about 400. */
export const MAX_POW_PAYLOAD_LENGTH = 2048;

export interface PowChallenge {
  algorithm: typeof POW_ALGORITHM;
  challenge: string;
  maxnumber: number;
  salt: string;
  signature: string;
}

export interface PowSolution {
  algorithm: string;
  challenge: string;
  number: number;
  salt: string;
  signature: string;
  took?: number;
}

export interface CreatePowOptions {
  /** HMAC key string (see KeyRing: DerivedKeys.pow). */
  hmacKey: string;
  maxnumber: number;
  /** Expiry, unix milliseconds; written into the salt as seconds. */
  expiresAt: number;
  /** Extra salt parameters, e.g. the challenge id. */
  params?: Record<string, string>;
  /** Only for tests: a fixed salt prefix and number. */
  salt?: string;
  number?: number;
}

export async function powHmacHex(hmacKey: string, challenge: string): Promise<string> {
  return bytesToHex(await hmacSha256(utf8(hmacKey), challenge));
}

export async function createPowChallenge(opts: CreatePowOptions): Promise<PowChallenge> {
  if (!Number.isSafeInteger(opts.maxnumber) || opts.maxnumber < 1)
    throw new RangeError('maxnumber');
  const params = new URLSearchParams(opts.params);
  params.set('expires', String(Math.floor(opts.expiresAt / 1000)));
  let salt = `${opts.salt ?? bytesToHex(randomBytes(12))}?${params.toString()}`;
  if (!salt.endsWith('&')) salt += '&'; // delimiter against parameter splicing, as altcha-lib
  const number = opts.number ?? randomInt(opts.maxnumber);
  const challenge = await sha256Hex(salt + number);
  return {
    algorithm: POW_ALGORITHM,
    challenge,
    maxnumber: opts.maxnumber,
    salt,
    signature: await powHmacHex(opts.hmacKey, challenge),
  };
}

/** Salt parameters (everything after the first "?"). */
export function powSaltParams(salt: string): Record<string, string> {
  const q = salt.indexOf('?');
  return q < 0 ? {} : Object.fromEntries(new URLSearchParams(salt.slice(q + 1)));
}

export function encodePowSolution(solution: PowSolution): string {
  return base64Encode(utf8(JSON.stringify(solution)));
}

export function decodePowSolution(payload: string): PowSolution | undefined {
  if (payload.length > MAX_POW_PAYLOAD_LENGTH) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(fromUtf8(base64Decode(payload)));
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if (
    typeof v.algorithm !== 'string' ||
    typeof v.challenge !== 'string' ||
    typeof v.salt !== 'string' ||
    typeof v.signature !== 'string' ||
    typeof v.number !== 'number'
  ) {
    return undefined;
  }
  return {
    algorithm: v.algorithm,
    challenge: v.challenge,
    number: v.number,
    salt: v.salt,
    signature: v.signature,
    ...(typeof v.took === 'number' ? { took: v.took } : {}),
  };
}

export type PowVerifyResult =
  | { ok: true; params: Record<string, string> }
  | {
      ok: false;
      reason: 'malformed' | 'algorithm' | 'expired' | 'no-expiry' | 'hash' | 'signature';
    };

/**
 * Checks a solution: algorithm, a required unexpired `expires` salt parameter, the
 * hash of salt + number, and the HMAC signature (both compared in constant time).
 */
export async function verifyPowSolution(
  input: string | PowSolution,
  hmacKey: string,
  nowMs: number,
): Promise<PowVerifyResult> {
  const s = typeof input === 'string' ? decodePowSolution(input) : input;
  if (!s) return { ok: false, reason: 'malformed' };
  if (s.algorithm !== POW_ALGORITHM) return { ok: false, reason: 'algorithm' };
  if (!Number.isSafeInteger(s.number) || s.number < 0) return { ok: false, reason: 'malformed' };
  if (!/^[0-9a-f]{64}$/.test(s.challenge) || !/^[0-9a-f]{64}$/.test(s.signature)) {
    return { ok: false, reason: 'malformed' };
  }
  const params = powSaltParams(s.salt);
  const expires = Number.parseInt(params.expires ?? '', 10);
  if (!Number.isFinite(expires)) return { ok: false, reason: 'no-expiry' };
  if (expires * 1000 < nowMs) return { ok: false, reason: 'expired' };
  const hash = await sha256Hex(s.salt + s.number);
  if (!timingSafeEqualString(hash, s.challenge)) return { ok: false, reason: 'hash' };
  const sig = await powHmacHex(hmacKey, s.challenge);
  if (!timingSafeEqualString(sig, s.signature)) return { ok: false, reason: 'signature' };
  return { ok: true, params };
}

/**
 * Brute-force solver (reference and tests; the widget runs the same loop in a Web Worker).
 * Returns null when no number up to `max` matches.
 */
export async function solvePow(
  challenge: Pick<PowChallenge, 'challenge' | 'salt' | 'maxnumber'>,
  start = 0,
): Promise<{ number: number; took: number } | null> {
  const t0 = Date.now();
  for (let n = start; n <= challenge.maxnumber; n++) {
    if ((await sha256Hex(challenge.salt + n)) === challenge.challenge) {
      return { number: n, took: Date.now() - t0 };
    }
  }
  return null;
}
