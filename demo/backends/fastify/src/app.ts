// The demo backend's app (Fastify): it serves the built demo page and answers its form. The same
// contract as the Express backend (demo/backends/contract.ts), so the demo page works with either.
//
// POST /demo/submit takes the form as application/x-www-form-urlencoded (`bc-response`, the pass
// token the widget put in the form, and `comment`) and checks the token with
// belarusian-captcha/server, the way a site's own backend would. The answer is JSON:
//
//   200 {accepted: true,  verify}   the token is valid, unspent and for this site and action
//   400 {accepted: false, verify}   the API refused it (replay, expired, wrong site, ...)
//   400 {accepted: false, error}    no usable token in the form
//   503 {accepted: false, verify}   the API could not be reached (fail closed, D11)
//
// `verify` is the SDK's result, shown on the page so a visitor sees what the site's backend sees.
// The secret is never logged or sent back; the token and the comment are not logged or stored.

import fastifyStatic from '@fastify/static';
import { type VerifyOptions, verify } from 'belarusian-captcha/server';
import Fastify, { type FastifyInstance } from 'fastify';

export const SUBMIT_PATH = '/demo/submit';
/** The action the demo page binds into its tokens (demo/src/demo.js). */
export const DEMO_ACTION = 'demo';
const MAX_TOKEN = 4096;
/** Body limit, as the Express backend's: a demo form is a token and a short comment. */
const BODY_LIMIT = 16 * 1024;

export interface DemoConfig {
  /** The demo site's secret key. */
  secret: string;
  /** Base URL of the verify API as this backend reaches it (in compose: http://api:8080). */
  apiUrl: string;
  /** The demo site's key: a token from another site is refused. */
  sitekey: string;
  /** The built demo page (demo/dist). */
  staticDir: string;
  /** For tests: the fetch the SDK uses. */
  fetch?: typeof fetch;
}

type Form = Record<string, string | string[]>;

/** A urlencoded body as fields; a field sent twice becomes an array, so it is not one token. */
function parseForm(text: string): Form {
  const form: Form = {};
  for (const [k, v] of new URLSearchParams(text)) {
    const prev = form[k];
    form[k] = prev === undefined ? v : [...(Array.isArray(prev) ? prev : [prev]), v];
  }
  return form;
}

export function createApp(cfg: DemoConfig): FastifyInstance {
  const app = Fastify({ bodyLimit: BODY_LIMIT, logger: false });

  // The form is the only body this backend reads: no JSON parser. Any other type parses to an
  // empty form, so it gets the same 400 as a form without a token.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_req, body, done) => done(null, parseForm(body as string)),
  );
  app.addContentTypeParser('*', { parseAs: 'string' }, (_req, _body, done) => done(null, {}));

  app.addHook('onRequest', async (_req, reply) => {
    reply.header('x-content-type-options', 'nosniff').header('referrer-policy', 'no-referrer');
  });

  app.get('/healthz', async (_req, reply) => {
    reply.header('cache-control', 'no-store');
    return { ok: true };
  });

  app.post(SUBMIT_PATH, async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const token = ((req.body ?? {}) as Form)['bc-response'];
    if (typeof token !== 'string' || token === '' || token.length > MAX_TOKEN) {
      return reply.code(400).send({ accepted: false, error: 'missing-token' });
    }
    const opts: VerifyOptions = {
      secret: cfg.secret,
      url: cfg.apiUrl,
      sitekey: cfg.sitekey,
      action: DEMO_ACTION,
    };
    if (cfg.fetch) opts.fetch = cfg.fetch;
    const result = await verify(token, opts);
    const status = result.success ? 200 : result.unavailable ? 503 : 400;
    return reply.code(status).send({ accepted: result.success, verify: result });
  });

  app.register(fastifyStatic, { root: cfg.staticDir, index: 'index.html', cacheControl: false });
  return app;
}
