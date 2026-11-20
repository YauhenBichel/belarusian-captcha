import { randomBytes } from './crypto.js';
import { KeyRing } from './keys.js';

/** Fresh random 32-byte master keys for the given kids. */
export function testMasters(kids: string[]): Map<string, Uint8Array<ArrayBuffer>> {
  return new Map(kids.map((kid) => [kid, randomBytes(32)]));
}

/** A key ring with fresh random keys, for tests. */
export function testRing(active = 'k1', kids: string[] = [active]): KeyRing {
  return new KeyRing(active, testMasters(kids));
}
