# Integration

How to protect a form on your site with belarusian-captcha. There are four steps: run the API,
register the site, put the widget in the form, check the token on your backend. The wire details
are in [`PROTOCOL.md`](PROTOCOL.md); what the captcha does and does not protect against is in
[`THREAT-MODEL.md`](THREAT-MODEL.md).

To see the whole thing working first, run the demo stack: `docker compose up` (README, "Try it").
Its Express backend, [`demo/backends/express/src/app.ts`](../demo/backends/express/src/app.ts), is
a complete integration in about 80 lines.

## 1. Run the API

The API is one container. The README's ["Run with Docker"](../README.md#run-with-docker) section
has the command and the environment variables. Points that matter for a real deployment:

- **Serve it over https**, behind your reverse proxy. Browsers call it from your pages.
- **Set `BC_TRUST_PROXY`** to the proxy's address or hop count (`true`, a number, or a
  comma-separated list). Without it, every visitor appears to come from the proxy, they all share
  one rate bucket, and the difficulty climbs for everyone at once.
- **Run one replica.** The spent-id store is SQLite on a volume and the rate counters live in
  memory; neither is shared between replicas yet (Redis is phase 3). Two replicas would let a token
  verify twice, once on each.
- **Keep the metrics port private.** It listens on 127.0.0.1:9464 by default; the image sets
  `0.0.0.0` for the container network, so do not publish that port.
- **Keep the keys file and `sites.yaml` out of the image and the repository**: mount them, or pass
  the keys in `BC_KEYS`.

## 2. Register the site

`bc-admin` makes the sealing keys and adds a site: see the README,
["Sites and keys: `bc-admin`"](../README.md#sites-and-keys-bc-admin). It prints the **site key**
(public, goes in your HTML) once and the **secret** (private, goes in your backend's environment)
once; `sites.yaml` keeps only the secret's SHA-256.

The site's `hostnames` are the origins your pages are served from: `example.org` for
`https://example.org`, `example.org:8443` for another port. Every origin the form appears on must
be listed, `www.` included; plain `http` is accepted only for `localhost` and `127.0.0.1`.

## 3. Put the widget in the form

```html
<form method="post" action="/comment">
  <!-- your fields -->
  <div class="belarusian-captcha" data-sitekey="YOUR-SITE-KEY" data-action="comment"></div>
  <button type="submit">Send</button>
</form>
<script src="https://captcha.example.org/widget.js" async defer></script>
```

When the visitor passes, the widget puts the token in a hidden field named **`bc-response`**
inside the form. Attributes (language, theme, callbacks), the JavaScript API
(`window.belarusianCaptcha`) and the events are in [`widget/README.md`](../widget/README.md); for
a bundler, `import { render } from 'belarusian-captcha'`.

Leave the submit button enabled, or enable it from `data-callback`: your backend must check the
token either way, because a bot does not run your JavaScript.

### Content Security Policy

If your pages send a CSP, allow the API's origin:

```text
script-src  'self' https://captcha.example.org;
connect-src 'self' https://captcha.example.org;
worker-src  'self';
```

- The proof-of-work runs in a Web Worker, and a worker script must be **same-origin with the
  page**. When `widget.js` comes from the API's origin, the widget runs the same work on the main
  thread in short slices instead. It works, but the page is less responsive during the work. To
  keep it in a worker, serve `widget.js` and `widget.worker.js` from your own origin, or point
  `data-worker` at a same-origin copy (`widget/README.md`, "The worker and the page's origin").
- The widget draws in a shadow root with a constructed stylesheet. Old browsers without
  constructed stylesheets fall back to an inline `<style>` element, which a `style-src` without
  `'unsafe-inline'` blocks. We have not tested the widget under a strict `style-src` yet.
- If you pin the script with `integrity`, the hash changes with each widget release; the release
  attaches `widget-sri.json`.

## 4. Check the token on your backend

On every submit, before you act on the form, send the token and your secret to
`POST /api/v1/siteverify`. **Never trust a form just because `bc-response` is present.**

Rules every integration follows, whatever the language:

1. **Verify from the server**, never from the browser: the secret must not reach a page.
2. **Each token verifies once.** A second check of the same token fails with
   `timeout-or-duplicate`, so verify once per submit and keep the result.
3. **Tokens expire** after `token_ttl_s` (default 5 minutes) from the solve.
4. **Check the action** if the site has several forms: pass `action` and the API refuses a token
   made for another form with `action-mismatch`.
5. **Fail closed.** If the API is down, times out or answers 5xx, refuse the form (or queue it for
   review). Fail open only for a form where spam costs less than lost submissions.
6. **Do not follow redirects** with the secret in the body.
7. **Keep the secret in the environment**, never in code, logs or error messages.

### Node

```ts
import { verify } from 'belarusian-captcha/server';

const r = await verify(req.body['bc-response'], {
  secret: process.env.BC_SECRET!,
  url: 'https://captcha.example.org',
  action: 'comment',
});
if (!r.success) return res.status(400).send('captcha');
```

Full options and the result table: [`sdk/node/README.md`](../sdk/node/README.md).

### Python

```python
import os
from belarusian_captcha import verify

r = verify(
    request.form.get("bc-response"),
    secret=os.environ["BC_SECRET"],
    url="https://captcha.example.org",
    action="comment",
)
if not r.success:
    abort(400)
```

Full options and the result table: [`sdk/python/README.md`](../sdk/python/README.md).

### Plain PHP

There is no PHP package yet (phase 5). The check is one HTTP call with curl, which PHP ships with:

```php
<?php
/**
 * Checks a belarusian-captcha token. Returns the API's answer on success, null otherwise.
 * Fails closed: an unreachable API, a timeout or a 5xx refuses the form.
 */
function bc_verify(?string $token, string $action): ?array
{
    if ($token === null || $token === '') {
        return null;
    }
    $secret = getenv('BC_SECRET');           // never hard-code the secret
    if ($secret === false || $secret === '') {
        throw new RuntimeException('BC_SECRET is not set');
    }
    $ch = curl_init('https://captcha.example.org/api/v1/siteverify');
    curl_setopt_array($ch, [
        CURLOPT_POST           => true,
        CURLOPT_POSTFIELDS     => http_build_query([
            'secret'   => $secret,
            'response' => $token,
            'action'   => $action,
        ]),
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_FOLLOWLOCATION => false,      // the secret must not follow a redirect
        CURLOPT_PROTOCOLS      => CURLPROTO_HTTPS,
        CURLOPT_CONNECTTIMEOUT => 2,
        CURLOPT_TIMEOUT        => 3,
    ]);
    $body = curl_exec($ch);
    $status = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    curl_close($ch);

    if ($body === false || $status !== 200) {
        error_log("captcha: siteverify unavailable (HTTP $status)");  // no secret, no token
        return null;                          // fail closed; 429 and 503 land here too
    }
    $r = json_decode($body, true);
    if (!is_array($r) || ($r['success'] ?? false) !== true) {
        return null;                          // refused: see $r['error-codes']
    }
    return $r;
}

$r = bc_verify($_POST['bc-response'] ?? null, 'comment');
if ($r === null) {
    http_response_code(400);
    exit('Please complete the captcha again.');
}
if (!empty($r['fallback'])) {
    // passed by the accessible fallback (score 0.3): see "Score and the fallback" below
}
// ... handle the form
```

Refusals come back as HTTP 200 with `success: false`, so check `success`, not just the status.

### Any other language

Send a form-encoded or JSON `POST` to `/api/v1/siteverify` with `secret`, `response` and
optionally `action` and `sitekey`:

```sh
curl -sS --max-time 3 --proto =https \
  --data-urlencode "secret=$BC_SECRET" \
  --data-urlencode "response=$TOKEN" \
  --data-urlencode "action=comment" \
  https://captcha.example.org/api/v1/siteverify
```

```json
{"success":true,"challenge_ts":"2026-11-21T10:15:00.000Z","hostname":"example.org",
 "score":1,"action":"comment","fallback":false,"error-codes":[]}
```

Accept the form only when the status is 200 **and** `success` is `true`. The shared test cases in
[`tests/fixtures/siteverify.json`](../tests/fixtures/siteverify.json) show what an SDK must do
with each answer; a new SDK should pass them.

## Score and the fallback

The widget has an "I cannot do this challenge" button for anyone the language or the task
excludes: screen-reader users, people who do not read Belarusian. It earns a pass with a harder
proof-of-work alone. That pass has `fallback: true` and `score: 0.3`; a pass from an answered
question has `score: 1`. There are no other scores today.

The fallback costs a bot only CPU time, so decide what it may do:

| Form | Suggested policy |
|---|---|
| comment, contact form, newsletter | accept; send fallback passes to moderation |
| sign-up | accept; ask for an e-mail confirmation before the account can post |
| login after failed attempts | accept with a slower retry limit |
| anything where an automated success costs real money | refuse fallback passes (`minScore: 0.5`) and offer another way in |

A `minScore` (Node) or `min_score` (Python) above 0.3 refuses every fallback pass. Refusing them
locks out the people the fallback is for, so do it only with another way in.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| widget shows `invalid-sitekey` | the page's origin is not in the site's `hostnames` (scheme and port count), or the site key is wrong |
| siteverify `invalid-secret` | the backend has another site's secret, or `sites.yaml` has a stale hash |
| siteverify `timeout-or-duplicate` | the form was submitted twice, the backend verifies twice, or the token is older than `token_ttl_s` |
| siteverify `hostname-mismatch` | the site's `hostnames` changed after the token was issued |
| every visitor gets hard challenges | `BC_TRUST_PROXY` is not set behind a proxy |
| `store-unavailable` | the SQLite volume is full or not writable; `/healthz` shows `store: "error"` |
