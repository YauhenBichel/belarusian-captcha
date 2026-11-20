// Entry point: reads the environment, refuses to start without valid sites, keys and a content
// pack (fail closed), serves the API, and serves /metrics on a separate, internal port.
//
//   BC_SITES          sites.yaml path               (default /etc/bc/sites.yaml)
//   BC_KEYS_FILE      key file path, or BC_KEYS with the JSON itself
//   BC_STORE          spent store                   (default sqlite:/data/bc.sqlite)
//   BC_PACK           content pack path             (required)
//   BC_PORT/BC_HOST   API listener                  (default 8080 on 0.0.0.0)
//   BC_METRICS_PORT/BC_METRICS_HOST                 (default 9464 on 127.0.0.1; port 0 = off)
//   BC_LOG_LEVEL      pino level                    (default info)
//   BC_TRUST_PROXY    "true", a hop count, or a comma-separated list of proxy addresses

import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { KeyRing } from '@belarusian-captcha/shared';
import { buildApp } from './app.js';
import { parseSites } from './config.js';
import { createMetrics } from './metrics.js';
import { parsePack } from './pack.js';
import { RateLimiter } from './rate.js';
import { openStore } from './store.js';

const SWEEP_MS = 60_000;

export function parseTrustProxy(v: string | undefined): boolean | number | string[] {
  if (!v || v === 'false') return false;
  if (v === 'true') return true;
  if (/^\d+$/.test(v)) return Number(v);
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function port(v: string | undefined, def: number, name: string): number {
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`${name} must be a port number`);
  return n;
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const sites = parseSites(readFileSync(env.BC_SITES ?? '/etc/bc/sites.yaml', 'utf8'));
  const keysJson = env.BC_KEYS_FILE ? readFileSync(env.BC_KEYS_FILE, 'utf8') : env.BC_KEYS;
  if (!keysJson) throw new Error('BC_KEYS_FILE or BC_KEYS is required');
  const ring = KeyRing.fromJson(keysJson);
  if (!env.BC_PACK) throw new Error('BC_PACK is required');
  const pack = parsePack(readFileSync(env.BC_PACK, 'utf8'));
  const store = openStore(env.BC_STORE ?? 'sqlite:/data/bc.sqlite');
  const metrics = createMetrics({ defaults: true });
  const limiter = new RateLimiter({ now: Date.now });

  const app = buildApp({
    sites,
    ring,
    store,
    pack,
    limiter,
    metrics,
    logLevel: env.BC_LOG_LEVEL ?? 'info',
    trustProxy: parseTrustProxy(env.BC_TRUST_PROXY),
  });

  const timer = setInterval(() => {
    limiter.sweep();
    store.prune(Date.now()).catch((err) => app.log.warn({ err: String(err) }, 'prune failed'));
  }, SWEEP_MS);
  timer.unref();

  let metricsServer: Server | undefined;
  const metricsPort = port(env.BC_METRICS_PORT, 9464, 'BC_METRICS_PORT');
  if (metricsPort !== 0) {
    metricsServer = createServer((req, res) => {
      if (req.method !== 'GET' || req.url !== '/metrics') {
        res.writeHead(404).end();
        return;
      }
      metrics.registry.metrics().then(
        (body) => res.writeHead(200, { 'content-type': metrics.registry.contentType }).end(body),
        () => res.writeHead(500).end(),
      );
    });
    metricsServer.listen(metricsPort, env.BC_METRICS_HOST ?? '127.0.0.1');
  }

  await app.listen({ port: port(env.BC_PORT, 8080, 'BC_PORT'), host: env.BC_HOST ?? '0.0.0.0' });
  app.log.info(
    { sites: sites.size, pack: `${pack.version}+${pack.checksum}`, store: store.name },
    'belarusian-captcha server started',
  );

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    clearInterval(timer);
    metricsServer?.close();
    await app.close();
    store.close();
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    // Configuration errors name the setting; they never contain key material.
    console.error(`belarusian-captcha: cannot start: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
