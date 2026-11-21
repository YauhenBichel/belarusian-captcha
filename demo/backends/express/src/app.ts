// The demo backend's app (Express): it serves the built demo page and answers its form.
//
// POST /demo/submit takes the form as application/x-www-form-urlencoded (`bc-response`, the pass
// token the widget put in the form, and `comment`) and checks the token with
// belarusian-captcha/server, the way a site's own backend would. The answer is JSON:
//
//   200 {accepted: true,  verify}   the token is valid, unspent and for this site and action
//   400 {accepted: false, verify}   the API refused it (replay, expired, wrong site, ...)
//   400 {accepted: false, error}    no token in the form
//   503 {accepted: false, verify}   the API could not be reached (fail closed, D11)
//
// `verify` is the SDK's result, shown on the page so a visitor sees what the site's backend sees.
// The secret is never logged or sent back; the token and the comment are not logged or stored.

import { type VerifyOptions, verify } from 'belarusian-captcha/server';
import express, { type Express } from 'express';

export const SUBMIT_PATH = '/demo/submit';
/** The action the demo page binds into its tokens (demo/src/demo.js). */
export const DEMO_ACTION = 'demo';
const MAX_TOKEN = 4096;

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

export function createApp(cfg: DemoConfig): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.set({ 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
    next();
  });

  app.get('/healthz', (_req, res) => {
    res.set('cache-control', 'no-store').json({ ok: true });
  });

  app.post(
    SUBMIT_PATH,
    express.urlencoded({ extended: false, limit: '16kb', parameterLimit: 10 }),
    async (req, res) => {
      res.set('cache-control', 'no-store');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const token = body['bc-response'];
      if (typeof token !== 'string' || token === '' || token.length > MAX_TOKEN) {
        res.status(400).json({ accepted: false, error: 'missing-token' });
        return;
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
      res.status(status).json({ accepted: result.success, verify: result });
    },
  );

  app.use(express.static(cfg.staticDir, { index: 'index.html', cacheControl: false }));
  return app;
}
