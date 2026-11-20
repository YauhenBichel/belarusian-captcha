// Thin wrappers over WebCrypto (globalThis.crypto), available in Node 24 and every browser.

import { base64urlEncode, bytesToHex, utf8 } from './encoding.js';

const subtle = globalThis.crypto.subtle;

export function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  return globalThis.crypto.getRandomValues(new Uint8Array(length));
}

/** A random URL-safe id: 16 bytes (128 bits) by default. */
export function randomId(bytes = 16): string {
  return base64urlEncode(randomBytes(bytes));
}

/** A uniformly random integer in [0, max] (inclusive), by rejection sampling. */
export function randomInt(max: number): number {
  if (!Number.isSafeInteger(max) || max < 0 || max > 0xffffffff) throw new RangeError('max');
  const range = max + 1;
  const limit = Math.floor(0x100000000 / range) * range;
  const buf = new Uint32Array(1);
  for (;;) {
    globalThis.crypto.getRandomValues(buf);
    const v = buf[0] as number;
    if (v < limit) return v % range;
  }
}

export async function sha256(
  data: Uint8Array<ArrayBuffer> | string,
): Promise<Uint8Array<ArrayBuffer>> {
  const bytes = typeof data === 'string' ? utf8(data) : data;
  return new Uint8Array(await subtle.digest('SHA-256', bytes));
}

export async function sha256Hex(data: Uint8Array<ArrayBuffer> | string): Promise<string> {
  return bytesToHex(await sha256(data));
}

export async function hmacSha256(
  key: Uint8Array<ArrayBuffer>,
  data: Uint8Array<ArrayBuffer> | string,
): Promise<Uint8Array<ArrayBuffer>> {
  const k = await subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bytes = typeof data === 'string' ? utf8(data) : data;
  return new Uint8Array(await subtle.sign('HMAC', k, bytes));
}

/** HKDF-SHA-256 with an empty salt: derives one purpose key from a master key. */
export async function hkdf(
  master: Uint8Array<ArrayBuffer>,
  info: string,
  length = 32,
): Promise<Uint8Array<ArrayBuffer>> {
  const k = await subtle.importKey('raw', master, 'HKDF', false, ['deriveBits']);
  const bits = await subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: utf8(info) },
    k,
    length * 8,
  );
  return new Uint8Array(bits);
}
