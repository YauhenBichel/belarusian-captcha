// Sealed values: AES-256-GCM under the purpose key of a kid, as `<kid>.<iv>.<ciphertext+tag>`
// (base64url). The kid is bound as associated data, so a seal cannot be relabelled to another
// key. Used for challenges: the answer travels to the browser only in sealed form, and an
// unsolved challenge costs the server no storage.

import { randomBytes } from './crypto.js';
import { base64urlDecode, base64urlEncode, fromUtf8, utf8 } from './encoding.js';
import { type KeyRing, KID_PATTERN } from './keys.js';

export const MAX_SEALED_LENGTH = 4096;
const IV_BYTES = 12;

export class SealError extends Error {
  constructor(readonly reason: 'malformed' | 'unknown-kid' | 'bad-seal') {
    super(`seal: ${reason}`);
    this.name = 'SealError';
  }
}

function aad(kid: string): Uint8Array<ArrayBuffer> {
  return utf8(`belarusian-captcha seal v1:${kid}`);
}

export async function seal(ring: KeyRing, value: unknown): Promise<string> {
  const kid = ring.active;
  const keys = await (ring.keys(kid) as NonNullable<ReturnType<KeyRing['keys']>>);
  const iv = randomBytes(IV_BYTES);
  const ct = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad(kid) },
    keys.seal,
    utf8(JSON.stringify(value)),
  );
  return `${kid}.${base64urlEncode(iv)}.${base64urlEncode(new Uint8Array(ct))}`;
}

/** Opens a seal; throws SealError when it is malformed, from an unknown kid, or altered. */
export async function unseal(ring: KeyRing, sealed: string): Promise<unknown> {
  if (typeof sealed !== 'string' || sealed.length > MAX_SEALED_LENGTH) {
    throw new SealError('malformed');
  }
  const parts = sealed.split('.');
  if (parts.length !== 3) throw new SealError('malformed');
  const [kid, ivText, ctText] = parts as [string, string, string];
  if (!KID_PATTERN.test(kid)) throw new SealError('malformed');
  const keysPromise = ring.keys(kid);
  if (!keysPromise) throw new SealError('unknown-kid');
  let iv: Uint8Array<ArrayBuffer>;
  let ct: Uint8Array<ArrayBuffer>;
  try {
    iv = base64urlDecode(ivText);
    ct = base64urlDecode(ctText);
  } catch {
    throw new SealError('malformed');
  }
  if (iv.length !== IV_BYTES || ct.length < 16) throw new SealError('malformed');
  const keys = await keysPromise;
  let plain: ArrayBuffer;
  try {
    plain = await globalThis.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: aad(kid) },
      keys.seal,
      ct,
    );
  } catch {
    throw new SealError('bad-seal');
  }
  try {
    return JSON.parse(fromUtf8(new Uint8Array(plain)));
  } catch {
    throw new SealError('bad-seal');
  }
}

/** The kid a sealed value was made with (no check), or undefined. */
export function sealKid(sealed: string): string | undefined {
  const kid = sealed.split('.', 1)[0];
  return kid && KID_PATTERN.test(kid) ? kid : undefined;
}
