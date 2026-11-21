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
//   BC_WIDGET_DIR     the widget build (widget/dist) to serve at /widget.js and /widget.worker.js
//                     (unset: not served; the image sets /app/widget/dist)
//   BC_SHUTDOWN_TIMEOUT_MS  how long SIGTERM/SIGINT wait for in-flight requests (default 10000;
//                     keep it below the pod's terminationGracePeriodSeconds, 30 s by default)

import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { KeyRing } from '@belarusian-captcha/shared';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { parseSites } from './config.js';
import { isEntryPoint } from './entry.js';
import { createMetrics } from './metrics.js';
import { parsePack } from './pack.js';
import { RateLimiter } from './rate.js';
import { openStore, type SpentStore } from './store.js';
import { loadWidgetAssets } from './widget-assets.js';

export { isEntryPoint };

const SWEEP_MS = 60_000;
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

export function parseTrustProxy(v: string | undefined): boolean | number | string[] {
  if (!v || v === 'false') return false;
  if (v === 'true') return true;
  if (/^\d+$/.test(v)) return Number(v);
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface Running {
  app: FastifyInstance;
  store: SpentStore;
  metricsServer?: Server | undefined;
  timer?: NodeJS.Timeout | undefined;
}

/**
 * Stops taking new connections and waits up to `timeoutMs` for in-flight requests to finish
 * (Fastify's close() drains them; keep-alive sockets are closed as they turn idle). After the timeout
 * the remaining connections are cut. Returns 'drained' or 'timeout'; the caller picks the exit code.
 */
export async function drain(r: Running, timeoutMs: number): Promise<'drained' | 'timeout'> {
  if (r.timer) clearInterval(r.timer);
  r.metricsServer?.close();
  r.metricsServer?.closeAllConnections();
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
    timer.unref();
  });
  // server.close() closes the sockets that are idle when it starts; a keep-alive socket whose
  // request finishes later would hold the close open until its keep-alive timeout, so idle
  // sockets are closed again while draining.
  const reaper = setInterval(() => r.app.server.closeIdleConnections(), 50);
  const result = await Promise.race([r.app.close().then(() => 'drained' as const), timedOut]);
  clearInterval(reaper);
  clearTimeout(timer);
  if (result === 'timeout') r.app.server.closeAllConnections();
  r.store.close();
  return result;
}

function port(v: string | undefined, def: number, name: string): number {
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`${name} must be a port number`);
  return n;
}

function positiveInt(v: string | undefined, def: number, name: string): number {
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a positive integer`);
  return n;
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const sites = parseSites(readFileSync(env.BC_SITES ?? '/etc/bc/sites.yaml', 'utf8'));
  const keysJson = env.BC_KEYS_FILE ? readFileSync(env.BC_KEYS_FILE, 'utf8') : env.BC_KEYS;
  if (!keysJson) throw new Error('BC_KEYS_FILE or BC_KEYS is required');
  const ring = KeyRing.fromJson(keysJson);
  if (!env.BC_PACK) throw new Error('BC_PACK is required');
  const pack = parsePack(readFileSync(env.BC_PACK, 'utf8'));
  const widget = env.BC_WIDGET_DIR ? loadWidgetAssets(env.BC_WIDGET_DIR) : undefined;
  const shutdownTimeoutMs = positiveInt(
    env.BC_SHUTDOWN_TIMEOUT_MS,
    DEFAULT_SHUTDOWN_TIMEOUT_MS,
    'BC_SHUTDOWN_TIMEOUT_MS',
  );
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
    ...(widget && { widget }),
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
    // A metrics port that cannot be bound stops the start; a later error is logged, not thrown.
    const ms = metricsServer;
    await new Promise<void>((resolve, reject) => {
      ms.once('error', reject);
      ms.listen(metricsPort, env.BC_METRICS_HOST ?? '127.0.0.1', () => {
        ms.off('error', reject);
        resolve();
      });
    });
    ms.on('error', (err) => app.log.error({ err: String(err) }, 'metrics server error'));
  }

  await app.listen({ port: port(env.BC_PORT, 8080, 'BC_PORT'), host: env.BC_HOST ?? '0.0.0.0' });
  app.log.info(
    { sites: sites.size, pack: `${pack.version}+${pack.checksum}`, store: store.name },
    'belarusian-captcha server started',
  );

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) {
      // A second signal while draining: stop now.
      app.log.warn({ signal }, 'second signal, exiting without waiting');
      process.exit(1);
    }
    stopping = true;
    app.log.info({ signal, timeoutMs: shutdownTimeoutMs }, 'shutting down, draining requests');
    try {
      const result = await drain({ app, store, metricsServer, timer }, shutdownTimeoutMs);
      if (result === 'timeout') app.log.warn('drain timed out; open connections were cut');
      process.exit(result === 'drained' ? 0 : 1);
    } catch (err) {
      app.log.error({ err: String(err) }, 'shutdown failed');
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

if (isEntryPoint(import.meta.url, process.argv[1])) {
  // A promise nobody awaited failed: the process state is unknown, so log it and exit non-zero
  // (the orchestrator restarts the pod) rather than keep serving.
  process.on('unhandledRejection', (reason: unknown) => {
    console.error(
      `belarusian-captcha: unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`,
    );
    process.exit(1);
  });
  main().catch((err: unknown) => {
    // Configuration errors name the setting; they never contain key material.
    console.error(`belarusian-captcha: cannot start: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
