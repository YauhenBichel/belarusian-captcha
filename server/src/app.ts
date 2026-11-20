// The verify API (docs/DESIGN.md section 5): /api/v1/challenge, /api/v1/solve,
// /api/v1/siteverify and /healthz. Metrics are served separately (see main.ts).

import {
  API_PREFIX,
  type ChallengeResponse,
  type ErrorCode,
  issuePassToken,
  type KeyRing,
  randomId,
  SealError,
  type SiteverifyResponse,
  type SolveRequest,
  sha256,
  timingSafeEqual,
  timingSafeEqualString,
  unseal,
  utf8,
  verifyPassToken,
  verifyPowSolution,
} from '@belarusian-captcha/shared';
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  LogController,
} from 'fastify';
import { answerHash, buildProverbChallenge, isSealedChallenge } from './challenge.js';
import { entryHost, matchOrigin, type SiteConfig, type Sites } from './config.js';
import type { Metrics } from './metrics.js';
import type { ContentPack } from './pack.js';
import type { RateLimiter } from './rate.js';
import type { SpentStore } from './store.js';

export interface AppDeps {
  sites: Sites;
  ring: KeyRing;
  store: SpentStore;
  pack: ContentPack;
  limiter: RateLimiter;
  metrics: Metrics;
  now?: () => number;
  logLevel?: string;
  /** Passed to Fastify: true, a hop count, or a list of trusted proxy addresses. */
  trustProxy?: boolean | number | string | string[];
  /** Where log lines go (default stdout); tests capture them here. */
  logStream?: { write(line: string): void };
}

interface LogContext {
  site?: string;
  result?: string;
  level?: number;
}

declare module 'fastify' {
  interface FastifyRequest {
    bc: LogContext;
  }
}

const ACTION = '^[A-Za-z0-9_/-]{0,32}$';

export function buildApp(deps: AppDeps): FastifyInstance {
  const now = deps.now ?? Date.now;
  const { sites, ring, store, pack, limiter, metrics } = deps;
  /** Every `host[:port]` entry of every site: who may preflight, and who may read an error. */
  const allOrigins = new Set([...sites.values()].flatMap((s) => s.hostnames));
  const widgetRoutes = new Set([`${API_PREFIX}/challenge`, `${API_PREFIX}/solve`]);

  const app = Fastify({
    bodyLimit: 16 * 1024,
    trustProxy:
      typeof deps.trustProxy === 'number'
        ? (() => {
            const hops = deps.trustProxy;
            return (_addr: string, hop: number) => hop < hops;
          })()
        : (deps.trustProxy ?? false),
    // Fastify's own per-request lines carry the URL and address; the onResponse hook logs instead.
    logController: new LogController({ disableRequestLogging: true }),
    logger: {
      level: deps.logLevel ?? 'info',
      ...(deps.logStream ? { stream: deps.logStream } : {}),
      // Privacy (section 5.4): no IP address, user agent, query string or body in any log line.
      serializers: { req: (req) => ({ method: req.method }), res: () => ({}) },
    },
  });

  app.decorateRequest('bc', null as unknown as LogContext);
  app.addHook('onRequest', async (req) => {
    req.bc = {};
  });
  app.addHook('onResponse', async (req, reply) => {
    req.log.info(
      {
        endpoint: req.routeOptions.url ?? 'unknown',
        site: req.bc.site,
        code: reply.statusCode,
        result: req.bc.result,
        level: req.bc.level,
        ms: Math.round(reply.elapsedTime),
      },
      'request',
    );
  });

  // A 4xx/5xx from a widget endpoint is readable by any configured origin, so the widget can show
  // the error code (bad-request, rate-limited, hostname-mismatch, ...) instead of an opaque CORS
  // failure. Successful answers still carry CORS only for the site's own origins (allowOrigin).
  app.addHook('onSend', async (req, reply, payload) => {
    if (
      reply.statusCode >= 400 &&
      req.method !== 'OPTIONS' &&
      widgetRoutes.has(req.routeOptions.url ?? '') &&
      !reply.hasHeader('access-control-allow-origin')
    ) {
      allowOrigin(req, reply, allOrigins);
    }
    return payload;
  });

  // siteverify takes form posts as well as JSON (reCAPTCHA-shaped clients send forms).
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_req, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(body as string)));
    },
  );

  /** CORS for the widget endpoints: only the origins listed for a site (see matchOrigin). */
  function allowOrigin(req: FastifyRequest, reply: FastifyReply, entries: Iterable<string>) {
    const origin = req.headers.origin;
    const host = matchOrigin(origin, entries);
    if (!origin || !host) return undefined;
    reply.header('access-control-allow-origin', origin);
    reply.header('vary', 'Origin');
    return host;
  }

  function fail(req: FastifyRequest, reply: FastifyReply, status: number, error: ErrorCode) {
    req.bc.result = error;
    return reply.code(status).send({ error });
  }

  async function newChallenge(
    req: FastifyRequest,
    site: SiteConfig,
    action: string,
  ): Promise<{ limited: true } | { limited: false; challenge: ChallengeResponse }> {
    const bucket = await limiter.bucketFor(req.ip);
    const d = limiter.hit(site, bucket);
    if (d.limited) {
      metrics.rateLimited.inc({ site: site.sitekey });
      return { limited: true };
    }
    const t0 = performance.now();
    const { response, itemIds } = await buildProverbChallenge({
      ring,
      pack,
      site,
      level: d.level,
      bucket,
      action,
      recent: limiter.recentItems(site, bucket),
      nowMs: now(),
    });
    metrics.renderSeconds.observe({ type: 'proverb' }, (performance.now() - t0) / 1000);
    limiter.shown(site, bucket, itemIds);
    metrics.challenges.inc({ site: site.sitekey, type: 'proverb', level: String(d.level) });
    metrics.powLevel.observe({ site: site.sitekey }, d.level);
    req.bc.level = d.level;
    return { limited: false, challenge: response };
  }

  // Preflight for the widget endpoints. The solve body (and so its site) is not known yet, so
  // any configured host name may preflight; the real request is checked against its own site.
  app.options(`${API_PREFIX}/challenge`, preflight);
  app.options(`${API_PREFIX}/solve`, preflight);
  async function preflight(req: FastifyRequest, reply: FastifyReply) {
    if (!allowOrigin(req, reply, allOrigins)) return reply.code(403).send();
    reply.header('access-control-allow-methods', 'GET, POST');
    reply.header('access-control-allow-headers', 'content-type');
    reply.header('access-control-max-age', '600');
    return reply.code(204).send();
  }

  app.get<{ Querystring: { sitekey: string; lang?: string; script?: string; action?: string } }>(
    `${API_PREFIX}/challenge`,
    {
      schema: {
        querystring: {
          type: 'object',
          required: ['sitekey'],
          properties: {
            sitekey: { type: 'string', maxLength: 64 },
            lang: { type: 'string', enum: ['be', 'be-Latn', 'ru', 'en'] },
            script: { type: 'string', enum: ['cyrl'] },
            types: { type: 'string', maxLength: 64 },
            action: { type: 'string', pattern: ACTION },
          },
        },
      },
    },
    async (req, reply) => {
      const site = sites.get(req.query.sitekey);
      if (!site) return fail(req, reply, 403, 'invalid-sitekey');
      req.bc.site = site.sitekey;
      if (!allowOrigin(req, reply, site.hostnames)) return fail(req, reply, 403, 'invalid-sitekey');
      const r = await newChallenge(req, site, req.query.action ?? '');
      if (r.limited) {
        reply.header('retry-after', '60');
        return fail(req, reply, 429, 'rate-limited');
      }
      req.bc.result = 'ok';
      reply.header('cache-control', 'no-store');
      return r.challenge;
    },
  );

  app.post<{ Body: SolveRequest }>(
    `${API_PREFIX}/solve`,
    {
      schema: {
        body: {
          type: 'object',
          required: ['sealed', 'answer', 'pow'],
          additionalProperties: false,
          properties: {
            sealed: { type: 'string', maxLength: 4096 },
            answer: {
              type: 'array',
              minItems: 1,
              maxItems: 2,
              items: { type: 'string', maxLength: 32 },
            },
            pow: { type: 'string', maxLength: 2048 },
          },
        },
      },
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      // 1. Open the seal.
      let opened: unknown;
      try {
        opened = await unseal(ring, req.body.sealed);
      } catch (e) {
        if (e instanceof SealError) return fail(req, reply, 400, 'invalid-input-response');
        throw e;
      }
      if (!isSealedChallenge(opened)) return fail(req, reply, 400, 'invalid-input-response');
      const c = opened;
      const site = sites.get(c.sk);
      if (!site) return fail(req, reply, 403, 'invalid-sitekey');
      req.bc.site = site.sitekey;
      req.bc.level = c.lvl;
      // 2. The browser origin must be one of the site's origins (scheme and port included).
      const hostname = allowOrigin(req, reply, site.hostnames);
      if (!hostname) return fail(req, reply, 403, 'hostname-mismatch');

      const rejectWithNext = async (error: ErrorCode, countFailure: boolean) => {
        if (countFailure) limiter.fail(site, c.b);
        metrics.solves.inc({ site: site.sitekey, type: c.t, result: error });
        req.bc.result = error;
        const next = await newChallenge(req, site, c.act);
        if (next.limited) {
          reply.header('retry-after', '60');
          return reply.code(429).send({ error: 'rate-limited' });
        }
        return reply.code(422).send({ error, next: next.challenge });
      };

      // 3. Expiry, by the server's clock only.
      if (now() > c.exp) return rejectWithNext('timeout-or-duplicate', false);
      // 4. The proof-of-work, bound to this challenge id.
      const sealKid = req.body.sealed.split('.', 1)[0] as string;
      const keys = await ring.keys(sealKid);
      if (!keys) return fail(req, reply, 400, 'invalid-input-response');
      const pow = await verifyPowSolution(req.body.pow, keys.pow, now());
      if (
        !pow.ok ||
        pow.params.cid === undefined ||
        !timingSafeEqualString(pow.params.cid, c.cid)
      ) {
        return rejectWithNext('bad-pow', true);
      }
      // 5. Spend the challenge id: one answer per challenge. Fail closed if the store is down.
      let first: boolean;
      try {
        first = await store.spend('challenge', c.cid, c.exp);
      } catch (err) {
        req.log.error({ err: String(err) }, 'spent store unavailable');
        metrics.solves.inc({ site: site.sitekey, type: c.t, result: 'store-unavailable' });
        return fail(req, reply, 503, 'store-unavailable');
      }
      if (!first) return rejectWithNext('timeout-or-duplicate', false);
      // 6. The answer.
      const right =
        req.body.answer.length === c.items.length &&
        timingSafeEqualString(await answerHash(c.cid, req.body.answer), c.ah);
      for (const item of c.items) {
        metrics.itemAnswers.inc({
          item: metrics.itemLabel(String(item)),
          result: right ? 'right' : 'wrong-answer',
        });
      }
      if (!right) return rejectWithNext('wrong-answer', true);
      // 7. The pass token.
      const iat = now();
      const exp = iat + site.tokenTtlS * 1000;
      const token = await issuePassToken(ring, {
        v: 1,
        tid: randomId(16),
        sitekey: site.sitekey,
        hostname,
        action: c.act,
        score: 1,
        iat: Math.floor(iat / 1000),
        exp: Math.floor(exp / 1000),
      });
      metrics.solves.inc({ site: site.sitekey, type: c.t, result: 'ok' });
      metrics.solveSeconds.observe({ site: site.sitekey, type: c.t }, (iat - c.iat) / 1000);
      req.bc.result = 'ok';
      return { token, expires: Math.floor(exp / 1000) * 1000 };
    },
  );

  // Server to server only: no CORS headers. reCAPTCHA-shaped answers, HTTP 200 for a refusal.
  app.post<{ Body: Record<string, unknown> }>(
    `${API_PREFIX}/siteverify`,
    async (req, reply): Promise<SiteverifyResponse> => {
      reply.header('cache-control', 'no-store');
      const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<
        string,
        unknown
      >;
      const refuse = (code: ErrorCode, site = 'unknown'): SiteverifyResponse => {
        metrics.siteverify.inc({ site, result: code });
        req.bc.result = code;
        return { success: false, 'error-codes': [code] };
      };
      const secret = typeof body.secret === 'string' ? body.secret : '';
      const response = typeof body.response === 'string' ? body.response : '';
      if (!secret || secret.length > 256) return refuse('invalid-secret');
      if (!response) return refuse('invalid-input-response');

      // Signature first; an authentic but expired token still names its site.
      const v = await verifyPassToken(ring, response, now());
      if (!v.ok && v.error === 'invalid-input-response') return refuse('invalid-input-response');
      const payload = v.ok ? v.payload : v.error === 'timeout-or-duplicate' ? v.payload : undefined;
      if (!payload) return refuse('invalid-input-response');
      const site = sites.get(payload.sitekey);
      if (!site) return refuse('invalid-sitekey');
      req.bc.site = site.sitekey;
      // The secret is checked before anything is spent, so a wrong secret cannot burn a token.
      if (!timingSafeEqual(await sha256(utf8(secret)), site.secretSha256)) {
        return refuse('invalid-secret', site.sitekey);
      }
      if (typeof body.sitekey === 'string' && body.sitekey !== site.sitekey) {
        return refuse('invalid-sitekey', site.sitekey);
      }
      // Rate limit per secret key (design section 1.3, item 5). Counted only once the secret is
      // right, so someone holding a token but not the secret cannot use up the site's budget.
      if (limiter.overLimit('siteverify', site.sitekey, site.rate.siteverifyPerMin)) {
        reply.code(429);
        reply.header('retry-after', '60');
        return refuse('rate-limited', site.sitekey);
      }
      if (!v.ok) return refuse('timeout-or-duplicate', site.sitekey);
      if (!site.hostnames.some((e) => entryHost(e) === payload.hostname)) {
        return refuse('hostname-mismatch', site.sitekey);
      }
      // Optional: the action the site expects. A mismatch is refused before the token is spent,
      // like a wrong site key, so it cannot burn a token meant for another form.
      if (body.action !== undefined && body.action !== payload.action) {
        return refuse('action-mismatch', site.sitekey);
      }
      let first: boolean;
      try {
        first = await store.spend('token', payload.tid, payload.exp * 1000);
      } catch (err) {
        req.log.error({ err: String(err) }, 'spent store unavailable');
        reply.code(503);
        return refuse('store-unavailable', site.sitekey);
      }
      if (!first) return refuse('timeout-or-duplicate', site.sitekey);
      metrics.siteverify.inc({ site: site.sitekey, result: 'ok' });
      req.bc.result = 'ok';
      return {
        success: true,
        challenge_ts: new Date(payload.iat * 1000).toISOString(),
        hostname: payload.hostname,
        score: payload.score,
        action: payload.action,
        'error-codes': [],
      };
    },
  );

  app.get('/healthz', async (_req, reply) => {
    const ok = await store.healthy().catch(() => false);
    reply.code(ok ? 200 : 503);
    return { ok, pack_version: `${pack.version}+${pack.checksum}`, store: ok ? 'ok' : 'error' };
  });

  app.setErrorHandler((err: { statusCode?: number; validation?: unknown }, req, reply) => {
    if (err.validation) return fail(req, reply, 400, 'bad-request');
    if (err.statusCode && err.statusCode < 500)
      return fail(req, reply, err.statusCode, 'bad-request');
    req.log.error({ err: String(err) }, 'unhandled error');
    req.bc.result = 'internal-error';
    return reply.code(500).send({ error: 'internal-error' });
  });

  return app;
}
