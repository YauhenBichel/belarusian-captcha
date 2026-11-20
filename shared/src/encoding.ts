// Byte and string encodings that work the same in Node 24 and in browsers (no Buffer).

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });

export function utf8(text: string): Uint8Array<ArrayBuffer> {
  return textEncoder.encode(text);
}

export function fromUtf8(bytes: Uint8Array): string {
  return textDecoder.decode(bytes);
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) throw new Error('invalid hex');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToBinary(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}

function binaryToBytes(bin: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Standard base64 (with padding), as ALTCHA uses for its payload. */
export function base64Encode(bytes: Uint8Array): string {
  return btoa(bytesToBinary(bytes));
}

export function base64Decode(text: string): Uint8Array<ArrayBuffer> {
  return binaryToBytes(atob(text));
}

export function base64urlEncode(bytes: Uint8Array): string {
  return base64Encode(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64urlDecode(text: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error('invalid base64url');
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  return base64Decode(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
}

/** Compares two byte arrays in time that depends only on their lengths. */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}

export function timingSafeEqualString(a: string, b: string): boolean {
  return timingSafeEqual(utf8(a), utf8(b));
}
