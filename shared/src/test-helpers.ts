import { randomBytes } from './crypto.js';
import { base64urlDecode, base64urlEncode } from './encoding.js';
import { KeyRing } from './keys.js';

/**
 * Tampers with a dotted value (`kid.a.b`): flips one bit of the last segment's decoded bytes.
 * Editing the base64url text instead is not reliable: the last character of unpadded base64
 * carries only 2 or 4 real bits, so swapping it can decode to the same bytes (BACKLOG H4).
 */
export function flipLastByte(dotted: string): string {
  const cut = dotted.lastIndexOf('.') + 1;
  const bytes = base64urlDecode(dotted.slice(cut));
  bytes[bytes.length - 1] = (bytes[bytes.length - 1] as number) ^ 0x01;
  return dotted.slice(0, cut) + base64urlEncode(bytes);
}

/** Fresh random 32-byte master keys for the given kids. */
export function testMasters(kids: string[]): Map<string, Uint8Array<ArrayBuffer>> {
  return new Map(kids.map((kid) => [kid, randomBytes(32)]));
}

/** A key ring with fresh random keys, for tests. */
export function testRing(active = 'k1', kids: string[] = [active]): KeyRing {
  return new KeyRing(active, testMasters(kids));
}
