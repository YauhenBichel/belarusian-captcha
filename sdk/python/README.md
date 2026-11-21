# belarusian-captcha (Python SDK)

Verify a belarusian-captcha pass token from your backend. Python 3.11+, standard library only
(`urllib`, `json`), no dependencies.

```python
import os
from flask import abort, request
from belarusian_captcha import verify

r = verify(
    request.form.get("bc-response"),
    secret=os.environ["BC_SECRET"],  # the site's secret key, from the environment
    url="https://captcha.example.by",  # base URL of your captcha API
    remoteip=request.remote_addr,  # optional
    action="login",  # optional: must equal the token's action
    min_score=0.5,  # optional: lower scores give success=False
    fail_open=False,  # default: refuse the form if the API is down
)
if not r.success:
    abort(400)
```

`verify` returns a `VerifyResult` (a frozen dataclass): `success`, `error_codes`, `unavailable`,
`score`, `hostname`, `action`, `challenge_ts`, `fallback`. The last five are `None` unless the API
accepted the token. `r.to_dict()` gives the Node SDK's shape, with the `None` fields left out.

| Situation | `success` | `error_codes` | `unavailable` |
|---|---|---|---|
| valid, unspent token | `True` | `[]` | `False` |
| refused by the API (replay, expired, wrong secret, wrong host, rate-limited, ...) | `False` | the API's codes, e.g. `timeout-or-duplicate` | `False` |
| accepted, but `score < min_score` | `False` | `["score-below-threshold"]` | `False` |
| API unreachable, timed out (3 s default), 5xx, or a malformed answer | `fail_open` | `["captcha-unavailable"]` | `True` |

### Fallback passes

The widget has an "I cannot do this challenge" button for anyone the language or the task
excludes, screen-reader users and people who do not read Belarusian among them. It earns a pass
with a harder proof-of-work alone: `fallback=True` and `score=0.3`. A `min_score` above 0.3
refuses those passes, so decide what they may do. For a sign-up form or a comment you might
accept them and send the result to moderation:

```python
r = verify(token, secret=secret, url=url)
if not r.success:
    abort(400)
if r.fallback:
    queue_for_review(comment)  # or ask for an e-mail check, a slower limit, ...
```

### Errors

It never raises because of the visitor or the network. It raises `ValueError` only when the
options are wrong (no secret, a URL that is not a plain http(s) base URL, `min_score` outside
0..1, a `timeout` that is not a positive number).

The secret is sent only in the request body, never logged or put in an error, and the request
refuses redirects so the secret cannot follow one to another host. Prefer an `https` URL; plain
`http` is accepted for a private network between your backend and the API container.

`timeout` is in seconds. It bounds connecting and every wait for data, and reading the answer
stops once it has passed. Name resolution is not covered, and an API that sends its answer a few
bytes at a time can take up to about twice as long.

`verify` blocks. In an async framework, run it in a thread (for example
`await asyncio.to_thread(verify, token, secret=secret, url=url)`).

Both SDKs are checked against the same cases,
[`tests/fixtures/siteverify.json`](https://github.com/YauhenBichel/belarusian-captcha/blob/main/tests/fixtures/siteverify.json).
The protocol is described in
[`docs/DESIGN.md`](https://github.com/YauhenBichel/belarusian-captcha/blob/main/docs/DESIGN.md),
section 5.

### Development

```bash
cd sdk/python
python -m venv .venv && . .venv/bin/activate
pip install --require-hashes -r requirements-dev.txt
pip install --no-deps -e .
ruff check . && ruff format --check . && mypy
python -m unittest discover -s tests
```

Licence: Apache-2.0.
