#!/usr/bin/env node
// bc-admin (docs/DESIGN.md section 5.2): manages sites.yaml and the key file, so nobody edits
// secret hashes or key material by hand.
//
// A new site's secret is printed once on stdout and stored nowhere: sites.yaml keeps only its
// SHA-256. Key material is never printed. Every change is checked with the server's own parsers
// (parseSites, KeyRing.fromJson) before anything is written, so the server cannot be left with a
// file it refuses at start. The server reads both files at start: restart it after a change.

import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  base64Encode,
  KeyRing,
  KID_PATTERN,
  MIN_KEY_BYTES,
  randomBytes,
  randomId,
  sha256Hex,
} from '@belarusian-captcha/shared';
import { Document, isMap, isSeq, parseDocument, type YAMLMap } from 'yaml';
import { parseSites } from './config.js';
import { isEntryPoint } from './entry.js';

export const USAGE = `usage: bc-admin <command> [options]

  site add --host <host> [--host <host> ...] [--sitekey <id>] [--dry-run]
      add a site; prints its site key and its secret (once)
  site rotate-secret <sitekey> [--dry-run]
      give a site a new secret; the old one stops working when the server restarts
  site list
  keys init [--kid <id>]
      create a key file with one key (mode 0600)
  keys rotate [--kid <id>] [--dry-run]
      add a key and make it active; the old keys stay accepted until removed
  keys remove <kid> [--dry-run]
      remove a key that is no longer active
  keys list

  --sites <path>   sites.yaml (default: $BC_SITES, else /etc/bc/sites.yaml)
  --keys <path>    key file (default: $BC_KEYS_FILE)
`;

export interface Io {
  out: (line: string) => void;
  err: (line: string) => void;
  env: NodeJS.ProcessEnv;
}

/** A wrong command line: exit code 2 with the usage. */
export class UsageError extends Error {
  override name = 'UsageError';
}

/** A refused change (unknown site, active key, file exists ...): exit code 1. */
export class AdminError extends Error {
  override name = 'AdminError';
}

type Values = {
  sites?: string | undefined;
  keys?: string | undefined;
  host?: string[] | undefined;
  sitekey?: string | undefined;
  kid?: string | undefined;
  'dry-run'?: boolean | undefined;
  help?: boolean | undefined;
};

/** Runs one command; returns the exit code. Never throws. */
export async function run(argv: string[], io: Io): Promise<number> {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        sites: { type: 'string' },
        keys: { type: 'string' },
        host: { type: 'string', multiple: true },
        sitekey: { type: 'string' },
        kid: { type: 'string' },
        'dry-run': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    });
    if (values.help || positionals.length === 0) {
      io.out(USAGE);
      return values.help ? 0 : 2;
    }
    await dispatch(positionals, values, io);
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    io.err(`bc-admin: ${message}`);
    const usage =
      err instanceof UsageError ||
      String((err as { code?: unknown })?.code ?? '').startsWith('ERR_PARSE_ARGS');
    if (usage) io.err(USAGE);
    return usage ? 2 : 1;
  }
}

async function dispatch(pos: string[], v: Values, io: Io): Promise<void> {
  const [group, cmd, arg, ...rest] = pos;
  if (rest.length > 0) throw new UsageError(`unexpected argument "${rest[0]}"`);
  const one = (what: string): string => {
    if (!arg) throw new UsageError(`${group} ${cmd} needs ${what}`);
    return arg;
  };
  const none = () => {
    if (arg) throw new UsageError(`unexpected argument "${arg}"`);
  };
  const dry = v['dry-run'] === true;
  switch (`${group} ${cmd}`) {
    case 'site add':
      none();
      return siteAdd(sitesPath(v, io), v.host ?? [], v.sitekey, dry, io);
    case 'site rotate-secret':
      return siteRotateSecret(sitesPath(v, io), one('a site key'), dry, io);
    case 'site list':
      none();
      return siteList(sitesPath(v, io), io);
    case 'keys init':
      none();
      return keysInit(keysPath(v, io), v.kid ?? 'k1', dry, io);
    case 'keys rotate':
      none();
      return keysRotate(keysPath(v, io), v.kid, dry, io);
    case 'keys remove':
      return keysRemove(keysPath(v, io), one('a key id'), dry, io);
    case 'keys list':
      none();
      return keysList(keysPath(v, io), io);
    default:
      throw new UsageError(`unknown command "${pos.slice(0, 2).join(' ')}"`);
  }
}

function sitesPath(v: Values, io: Io): string {
  return v.sites ?? io.env.BC_SITES ?? '/etc/bc/sites.yaml';
}

function keysPath(v: Values, io: Io): string {
  const p = v.keys ?? io.env.BC_KEYS_FILE;
  if (!p) throw new UsageError('--keys or BC_KEYS_FILE is required');
  return p;
}

// ---- sites.yaml ------------------------------------------------------------------------------

/** sites.yaml as a YAML document, so comments and layout survive the edit. */
function readSitesDoc(path: string, create: boolean) {
  if (!existsSync(path)) {
    if (!create) throw new AdminError(`${path} does not exist`);
    return parseDocument('sites: []\n');
  }
  const doc = parseDocument(readFileSync(path, 'utf8'));
  if (doc.errors.length > 0) throw new AdminError(`${path}: ${doc.errors[0]?.message}`);
  if (!isMap(doc.contents)) throw new AdminError(`${path}: expected a mapping with "sites"`);
  if (!doc.has('sites')) doc.set('sites', doc.createNode([]));
  const seq = doc.get('sites');
  if (!isSeq(seq)) throw new AdminError(`${path}: "sites" must be a list`);
  return doc;
}

function sitesSeq(doc: Document) {
  const seq = doc.get('sites');
  if (!isSeq(seq)) throw new AdminError('"sites" must be a list');
  return seq;
}

async function newSecret(): Promise<{ secret: string; hash: string }> {
  // A prefix makes a leaked secret easy to recognise for secret scanners.
  const secret = `bc_sk_${randomId(32)}`;
  return { secret, hash: await sha256Hex(secret) };
}

async function siteAdd(
  path: string,
  hosts: string[],
  sitekeyArg: string | undefined,
  dry: boolean,
  io: Io,
): Promise<void> {
  if (hosts.length === 0) throw new UsageError('site add needs at least one --host');
  const doc = readSitesDoc(path, true);
  const seq = sitesSeq(doc);
  const sitekey = sitekeyArg ?? `bc_pk_${randomId(16)}`;
  const { secret, hash } = await newSecret();
  const entry = doc.createNode({
    sitekey,
    secret_sha256: hash,
    hostnames: hosts.map((h) => h.toLowerCase()),
    types: { proverb: 1 },
  }) as YAMLMap;
  const hostnames = entry.get('hostnames', true);
  if (isSeq(hostnames)) hostnames.flow = true;
  seq.flow = false;
  seq.items.push(entry);
  const text = doc.toString();
  parseSites(text); // the server's own check: host names, duplicate site keys ...

  if (dry) {
    io.out(`dry run: would add to ${path}:`);
    io.out(new Document([entry]).toString().trimEnd());
    io.err('dry run: nothing written and no secret issued');
    return;
  }
  writeAtomic(path, text, 0o644);
  io.out(`sitekey: ${sitekey}`);
  io.out(`secret:  ${secret}`);
  io.err(
    `added site ${sitekey} to ${path}. The secret is shown only now and stored only as a hash: ` +
      `give it to the site's backend (for siteverify). Restart the server to load the site.`,
  );
}

async function siteRotateSecret(path: string, sitekey: string, dry: boolean, io: Io) {
  const doc = readSitesDoc(path, false);
  const entry = sitesSeq(doc).items.find(
    (n): n is YAMLMap => isMap(n) && n.get('sitekey') === sitekey,
  );
  if (!entry) throw new AdminError(`no site "${sitekey}" in ${path}`);
  const { secret, hash } = await newSecret();
  entry.set('secret_sha256', hash);
  const text = doc.toString();
  parseSites(text);
  if (dry) {
    io.out(`dry run: would replace secret_sha256 of ${sitekey} in ${path}`);
    io.err('dry run: nothing written and no secret issued');
    return;
  }
  writeAtomic(path, text, 0o644);
  io.out(`sitekey: ${sitekey}`);
  io.out(`secret:  ${secret}`);
  io.err(
    `new secret for ${sitekey}, shown only now. The old secret works until the server restarts: ` +
      `update the site's backend, then restart the server.`,
  );
}

function siteList(path: string, io: Io): void {
  if (!existsSync(path)) throw new AdminError(`${path} does not exist`);
  for (const s of parseSites(readFileSync(path, 'utf8')).values()) {
    io.out(`${s.sitekey}  ${s.hostnames.join(', ')}`);
  }
}

// ---- the key file ----------------------------------------------------------------------------

interface KeyFileJson {
  active: string;
  keys: Record<string, string>;
}

function readKeys(path: string): KeyFileJson {
  if (!existsSync(path)) throw new AdminError(`${path} does not exist (create it with keys init)`);
  const text = readFileSync(path, 'utf8');
  KeyRing.fromJson(text); // strict check; its errors never contain key material
  return JSON.parse(text) as KeyFileJson;
}

function keyText(file: KeyFileJson): string {
  const text = `${JSON.stringify(file, null, 2)}\n`;
  KeyRing.fromJson(text);
  return text;
}

function newKey(): string {
  return base64Encode(randomBytes(MIN_KEY_BYTES));
}

function checkKid(kid: string): void {
  if (!KID_PATTERN.test(kid)) throw new UsageError(`key id must match ${KID_PATTERN}`);
}

/** k1, k2 ... : one more than the highest kN in use. */
export function nextKid(kids: string[]): string {
  let n = 0;
  for (const k of kids) {
    const m = /^k(\d+)$/.exec(k);
    if (m) n = Math.max(n, Number(m[1]));
  }
  let kid = `k${n + 1}`;
  while (kids.includes(kid)) kid = `k${++n + 1}`;
  return kid;
}

function keysInit(path: string, kid: string, dry: boolean, io: Io): void {
  checkKid(kid);
  if (existsSync(path)) throw new AdminError(`${path} already exists (use keys rotate)`);
  const text = keyText({ active: kid, keys: { [kid]: newKey() } });
  if (dry) {
    io.out(`dry run: would create ${path} with key ${kid} (active)`);
    return;
  }
  // Exclusive create, owner-only: the file holds the master keys.
  writeFileSync(path, text, { mode: 0o600, flag: 'wx' });
  chmodSync(path, 0o600);
  io.out(`created ${path} with key ${kid} (active)`);
  io.err(
    'The file holds the master keys: keep it out of git and images, readable only by the server ' +
      '(the container runs as uid 65532).',
  );
}

function keysRotate(path: string, kidArg: string | undefined, dry: boolean, io: Io): void {
  const file = readKeys(path);
  const kids = Object.keys(file.keys);
  const kid = kidArg ?? nextKid(kids);
  checkKid(kid);
  if (kids.includes(kid)) throw new AdminError(`key ${kid} already exists`);
  const previous = file.active;
  const text = keyText({ active: kid, keys: { ...file.keys, [kid]: newKey() } });
  if (!dry) writeAtomic(path, text, 0o600);
  io.out(
    `${dry ? 'dry run: would add' : 'added'} key ${kid} as the active key; ` +
      `still accepted: ${kids.join(', ')}`,
  );
  if (!dry) {
    io.err(
      `Restart every server with the new file. Then wait for the longest token_ttl_s and ` +
        `challenge_ttl_s (10 minutes by default) and remove the old key: bc-admin keys remove ${previous}`,
    );
  }
}

function keysRemove(path: string, kid: string, dry: boolean, io: Io): void {
  const file = readKeys(path);
  if (!(kid in file.keys)) throw new AdminError(`no key ${kid} in ${path}`);
  if (kid === file.active) {
    throw new AdminError(`key ${kid} is active; rotate to a new key before removing it`);
  }
  const keys = { ...file.keys };
  delete keys[kid];
  const text = keyText({ active: file.active, keys });
  if (dry) {
    io.out(`dry run: would remove key ${kid}; left: ${Object.keys(keys).join(', ')}`);
    return;
  }
  writeAtomic(path, text, 0o600);
  io.out(`removed key ${kid}; left: ${Object.keys(keys).join(', ')}`);
  io.err(`Restart the server: until then it still accepts seals and tokens made with ${kid}.`);
}

function keysList(path: string, io: Io): void {
  const file = readKeys(path);
  for (const kid of Object.keys(file.keys)) {
    io.out(kid === file.active ? `${kid} (active)` : kid);
  }
}

// ---- writing ---------------------------------------------------------------------------------

/**
 * Replaces a file through a temporary file and rename, keeping its mode, so a crash never leaves
 * half a file. A single-file bind mount (`docker -v ./sites.yaml:/etc/bc/sites.yaml`) cannot be
 * replaced by rename and sits in a read-only directory; there the file is written in place.
 */
export function writeAtomic(path: string, text: string, newFileMode: number): void {
  const mode = existsSync(path) ? statSync(path).mode & 0o777 : newFileMode;
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  try {
    writeFileSync(tmp, text, { mode, flag: 'wx' });
    chmodSync(tmp, mode);
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EBUSY' || code === 'EROFS' || code === 'EXDEV' || code === 'EACCES') {
      writeFileSync(path, text, { mode });
      return;
    }
    throw err;
  }
}

if (isEntryPoint(import.meta.url, process.argv[1])) {
  run(process.argv.slice(2), {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    env: process.env,
  }).then((code) => {
    process.exitCode = code;
  });
}
