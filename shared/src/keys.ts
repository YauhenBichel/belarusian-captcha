// Master keys with key ids (kid), and the purpose keys derived from each by HKDF.
// Two keys can be active during a rotation: new seals and tokens use `active`,
// and any listed kid is still accepted until it is removed.

import { hkdf } from './crypto.js';
import { base64Decode, base64urlDecode, bytesToHex } from './encoding.js';

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

/**
 * A key file that cannot be used. The message names the field or the kid, never key material
 * (not even a fragment of the file, which a JSON syntax error message would otherwise quote).
 */
export class KeyFileError extends Error {
  override name = 'KeyFileError';
  /** The key id the error is about, when there is one. */
  readonly kid: string | undefined;
  constructor(message: string, kid?: string) {
    super(message);
    this.kid = kid;
  }
}

/** Standard base64 or base64url, padding optional. */
const BASE64 = /^(?:[A-Za-z0-9+/]+|[A-Za-z0-9_-]+)={0,2}$/;

const SHAPE = 'key file must be {"active": "<kid>", "keys": {"<kid>": "<base64>", ...}}';

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

  /**
   * Parses `{"active":"k2","keys":{"k1":"<base64>","k2":"<base64>"}}` (docs/DESIGN.md section
   * 5.2) strictly: no other fields, a non-empty `keys` mapping, valid kids, base64 values of at
   * least 32 bytes, and `active` one of the kids. Throws KeyFileError.
   */
  static fromJson(json: string): KeyRing {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      throw new KeyFileError('key file is not valid JSON');
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new KeyFileError(SHAPE);
    }
    const file = parsed as Record<string, unknown>;
    const extra = Object.keys(file).filter((k) => k !== 'active' && k !== 'keys');
    if (extra.length > 0) throw new KeyFileError(`${SHAPE}; unknown field "${extra[0]}"`);
    const { active, keys } = file;
    if (typeof active !== 'string' || !KID_PATTERN.test(active)) {
      throw new KeyFileError(`${SHAPE}; "active" must be a key id matching ${KID_PATTERN}`);
    }
    if (typeof keys !== 'object' || keys === null || Array.isArray(keys)) {
      throw new KeyFileError(`${SHAPE}; "keys" must be a mapping`);
    }
    const entries = Object.entries(keys);
    if (entries.length === 0) throw new KeyFileError(`${SHAPE}; "keys" is empty`);
    const masters = new Map<string, Uint8Array<ArrayBuffer>>();
    for (const [kid, value] of entries) {
      if (!KID_PATTERN.test(kid)) throw new KeyFileError(`invalid key id "${kid}"`, kid);
      if (typeof value !== 'string') {
        throw new KeyFileError(`key "${kid}" must be a base64 string`, kid);
      }
      let bytes: Uint8Array<ArrayBuffer>;
      try {
        if (!BASE64.test(value)) throw new Error('not base64');
        bytes = /[-_]/.test(value)
          ? base64urlDecode(value.replace(/=+$/, ''))
          : base64Decode(value);
      } catch {
        throw new KeyFileError(`key "${kid}" is not valid base64`, kid);
      }
      if (bytes.length < MIN_KEY_BYTES) {
        throw new KeyFileError(`key "${kid}" is shorter than ${MIN_KEY_BYTES} bytes`, kid);
      }
      masters.set(kid, bytes);
    }
    if (!masters.has(active)) {
      throw new KeyFileError(`active key id "${active}" is not in keys`, active);
    }
    return new KeyRing(active, masters);
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
