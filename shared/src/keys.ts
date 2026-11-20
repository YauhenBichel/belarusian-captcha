// Master keys with key ids (kid), and the purpose keys derived from each by HKDF.
// Two keys can be active during a rotation: new seals and tokens use `active`,
// and any listed kid is still accepted until it is removed.

import { hkdf } from './crypto.js';
import { base64Decode, bytesToHex } from './encoding.js';

export const KID_PATTERN = /^[A-Za-z0-9_-]{1,16}$/;
export const MIN_KEY_BYTES = 32;

export interface DerivedKeys {
  /** AES-256-GCM key for sealed challenges. */
  seal: CryptoKey;
  /** HMAC-SHA-256 key bytes for pass tokens. */
  token: Uint8Array<ArrayBuffer>;
  /** HMAC key for the ALTCHA proof-of-work, as the hex string ALTCHA libraries take. */
  pow: string;
  /** HMAC key for daily rate buckets is NOT derived here: it must not survive a restart. */
}

export interface KeyFile {
  active: string;
  keys: Record<string, string>;
}

export class KeyRing {
  readonly active: string;
  readonly #masters: Map<string, Uint8Array<ArrayBuffer>>;
  readonly #derived = new Map<string, Promise<DerivedKeys>>();

  constructor(active: string, masters: Map<string, Uint8Array<ArrayBuffer>>) {
    if (!masters.has(active)) throw new Error(`active key id "${active}" is not in keys`);
    for (const [kid, key] of masters) {
      if (!KID_PATTERN.test(kid)) throw new Error(`invalid key id "${kid}"`);
      if (key.length < MIN_KEY_BYTES) throw new Error(`key "${kid}" is shorter than 32 bytes`);
    }
    this.active = active;
    this.#masters = masters;
  }

  /** Parses `{"active":"k2","keys":{"k1":"<base64>","k2":"<base64>"}}`. */
  static fromJson(json: string): KeyRing {
    const parsed = JSON.parse(json) as Partial<KeyFile>;
    if (typeof parsed.active !== 'string' || typeof parsed.keys !== 'object' || !parsed.keys) {
      throw new Error('key file must be {"active": "<kid>", "keys": {"<kid>": "<base64>"}}');
    }
    const masters = new Map<string, Uint8Array<ArrayBuffer>>();
    for (const [kid, value] of Object.entries(parsed.keys)) {
      if (typeof value !== 'string') throw new Error(`key "${kid}" must be a base64 string`);
      masters.set(kid, base64Decode(value));
    }
    return new KeyRing(parsed.active, masters);
  }

  has(kid: string): boolean {
    return this.#masters.has(kid);
  }

  /** Purpose keys for a kid, or undefined when the kid is unknown. */
  keys(kid: string): Promise<DerivedKeys> | undefined {
    const master = this.#masters.get(kid);
    if (!master) return undefined;
    let d = this.#derived.get(kid);
    if (!d) {
      d = derive(master);
      this.#derived.set(kid, d);
    }
    return d;
  }
}

async function derive(master: Uint8Array<ArrayBuffer>): Promise<DerivedKeys> {
  const [sealRaw, token, pow] = await Promise.all([
    hkdf(master, 'belarusian-captcha seal v1'),
    hkdf(master, 'belarusian-captcha token v1'),
    hkdf(master, 'belarusian-captcha pow v1'),
  ]);
  const seal = await globalThis.crypto.subtle.importKey('raw', sealRaw, 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);
  return { seal, token, pow: bytesToHex(pow) };
}
