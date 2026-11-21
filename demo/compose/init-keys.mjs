// compose.yaml's `keys` service: makes the sealing key file on the first `docker compose up` and
// leaves it alone after that, so tokens and challenges survive a restart of the stack.
//
// It runs in the server image (distroless: node, no shell) with bc-admin's own code, as uid 65532
// on the `data` volume, so the file is created 0600 and readable by the API (same uid) only.
// `docker compose down -v` deletes the volume and with it the keys.

import { existsSync } from 'node:fs';
import { run } from '/app/server/dist/admin.js';

const keys = process.env.BC_KEYS_FILE;
if (!keys) {
  console.error('init-keys: BC_KEYS_FILE is not set');
  process.exit(2);
}
if (existsSync(keys)) {
  console.log(`init-keys: ${keys} exists, kept`);
  process.exit(0);
}
process.exitCode = await run(['keys', 'init', '--keys', keys], {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
  env: process.env,
});
