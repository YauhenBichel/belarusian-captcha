# belarusian-captcha (Node SDK)

Verify a belarusian-captcha pass token from your backend. Node 24+, no runtime dependencies.

```ts
import { verify } from 'belarusian-captcha/server';

const r = await verify(req.body['bc-response'], {
  secret: process.env.BC_SECRET!,          // the site's secret key, from the environment
  url: 'https://captcha.example.by',       // base URL of your captcha API
  remoteip: req.ip,                        // optional
  action: 'login',                         // optional: must equal the token's action
  minScore: 0.5,                           // optional: lower scores give success: false
  failOpen: false,                         // default: refuse the form if the API is down
});
if (!r.success) return res.status(400).send('captcha');
```

`verify` returns `{ success, score, hostname, action, challenge_ts, fallback, error_codes,
unavailable }`.

| Situation | `success` | `error_codes` | `unavailable` |
|---|---|---|---|
| valid, unspent token | `true` | `[]` | `false` |
| refused by the API (replay, expired, wrong secret, wrong host, rate-limited, ...) | `false` | the API's codes, e.g. `timeout-or-duplicate` | `false` |
| accepted, but `score < minScore` | `false` | `score-below-threshold` | `false` |
| API unreachable, timed out (3 s default), 5xx, or a malformed answer | `failOpen` | `captcha-unavailable` | `true` |

### Fallback passes

The widget has an "I cannot do this challenge" button for anyone the language or the task
excludes, screen-reader users and people who do not read Belarusian among them. It earns a pass
with a harder proof-of-work alone: `fallback: true` and `score: 0.3`. A `minScore` above 0.3
refuses those passes, so decide what they may do. For a sign-up form or a comment you might
accept them and send the result to moderation:

```ts
const r = await verify(token, { secret, url });
if (!r.success) return res.status(400).send('captcha');
if (r.fallback) queueForReview(comment);   // or ask for an e-mail check, a slower limit, ...
```

### Errors

It never throws because of the visitor or the network. It throws `TypeError` only when the options
are wrong (no secret, a URL that is not a plain http(s) base URL, `minScore` outside 0..1).

The secret is sent only in the request body, never logged or put in an error, and the request
refuses redirects so the secret cannot follow one to another host. Prefer an `https` URL; plain
`http` is accepted for a private network between your backend and the API container.

Options also take `timeout` (ms), `signal` (an `AbortSignal`) and `fetch` (for tests or a custom
agent). The protocol is described in [`docs/DESIGN.md`](../../docs/DESIGN.md), section 5.

Licence: Apache-2.0.
