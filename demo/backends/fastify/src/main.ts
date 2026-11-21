// Starts the Fastify demo backend. Configuration comes from the environment only, the same as
// the Express backend's:
//
//   BC_API_URL     base URL of the verify API as this backend reaches it      (required)
//   BC_SITEKEY     the demo site's key                                         (required)
//   BC_SECRET      the demo site's secret                                      (this or BC_SECRET_FILE)
//   BC_SECRET_FILE a file holding the secret (a Docker or Kubernetes secret)
//   BC_DEMO_DIR    the built demo page (default: demo/dist of this checkout)
//   HOST, PORT     where to listen (default 127.0.0.1:3001; compose sets HOST=0.0.0.0)

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';

function secretFromEnv(env: NodeJS.ProcessEnv): string {
  if (env.BC_SECRET) return env.BC_SECRET;
  if (env.BC_SECRET_FILE) return readFileSync(env.BC_SECRET_FILE, 'utf8').trim();
  throw new Error('BC_SECRET or BC_SECRET_FILE is required');
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

const env = process.env;
const app = createApp({
  secret: secretFromEnv(env),
  apiUrl: required(env, 'BC_API_URL'),
  sitekey: required(env, 'BC_SITEKEY'),
  staticDir: env.BC_DEMO_DIR || fileURLToPath(new URL('../../../dist/', import.meta.url)),
});
const host = env.HOST || '127.0.0.1';
const port = Number(env.PORT || 3001);

await app.listen({ host, port });
console.log(`demo backend (fastify) on http://${host}:${port}/`);
// Exec-form PID 1 in the container: stop on SIGTERM after the open requests finish.
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.once(sig, () => {
    app.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
}
