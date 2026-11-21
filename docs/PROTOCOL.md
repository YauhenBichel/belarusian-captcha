# Protocol

The wire protocol of the verify API as the code implements it today (`server/src/app.ts`,
`shared/src/`). The design is in [`DESIGN.md`](DESIGN.md) section 4; where the code differs from
it, this file says so. To add the captcha to a site, read [`INTEGRATION.md`](INTEGRATION.md)
instead; this file is for people writing their own widget, SDK or server.

Version 1. Every format below carries a version (`v: 1`, `... v1` labels), so a later version can
live beside it.

## The flow

```text
browser (widget)                    verify API                     site backend
 |  GET /api/v1/challenge ---------->|                                |
 |<--- sealed, questions, PoW -------|                                |
 |  (solve PoW in a worker, visitor picks answers)                    |
 |  POST /api/v1/solve ------------->|                                |
 |<--- token ------------------------|                                |
 |  form submit with bc-response=token -----------------------------> |
 |                                   |<---- POST /api/v1/siteverify --|
 |                                   |----- success, score, ... ----->|
```

The server keeps no state per challenge: everything it needs later travels inside the `sealed`
string, encrypted. It stores only spent ids (a challenge used once, a token used once) until they
expire, plus rate counters in memory.

## Endpoints

All bodies are JSON unless noted. Every response has `cache-control: no-store` except the widget
files. Request bodies are limited to 16 KB. A body or query that fails validation gets
`400 {"error":"bad-request"}`; an unexpected failure gets `500 {"error":"internal-error"}`.

### Browser endpoints and CORS

`/challenge`, `/fallback`, `/solve` and `/report` are called from the visitor's browser. The
browser's `Origin` must be one of the site's `hostnames`:

- `https` only; plain `http` is accepted for `localhost`, `*.localhost` and `127.0.0.1`.
- An entry without a port (`example.org`) matches the scheme's default port only. An entry with a
  port (`example.org:8443`) matches exactly that port.
- The response carries `access-control-allow-origin: <that origin>`. Error responses are readable
  by any configured origin, so the widget can show them.

### `GET /api/v1/challenge`, `GET /api/v1/fallback`

Query:

| Parameter | Required | Values |
|---|---|---|
| `sitekey` | yes | at most 64 characters |
| `lang` | no | `be`, `be-Latn`, `ru`, `en`: the interface language of the prompt |
| `script` | no | `cyrl` only today |
| `types` | no | accepted and ignored: only `proverb` exists |
| `action` | no | `^[A-Za-z0-9_/-]{0,32}$`; bound into the token |

`/fallback` gives the accessible fallback: no question, a proof-of-work two levels harder, and a
token with score 0.3 and `fallback: true` (design D3, option B).

Response `200`:

```json
{
  "sealed": "k1.<iv>.<ciphertext>",
  "type": "proverb",
  "display": {
    "questions": [
      { "prompt": "<the proverb's beginning>",
        "options": [ { "id": "a1b2c3", "text": "…" }, { "id": "d4e5f6", "text": "…" } ] }
    ]
  },
  "pow": { "algorithm": "SHA-256", "challenge": "<hex>", "maxnumber": 50000,
           "salt": "<24 hex>?cid=<cid>&expires=<unix s>&", "signature": "<hex>" },
  "expires": 1763740000000
}
```

- `type` is `proverb` or `fallback`. A `fallback` challenge has `questions: []`.
- `prompt` is the beginning of a proverb; the options are possible endings, one right, three from
  other proverbs of similar length. Each question has 4 options with random 6-character ids. One question below level 4, two at
  level 4 and above.
- `expires` is Unix milliseconds (`challenge_ttl_s`, default 600 s).

Errors: `403 invalid-sitekey` (unknown site, or `Origin` not one of its hostnames),
`429 rate-limited` with `Retry-After: 60`.

### `POST /api/v1/solve`

```json
{ "sealed": "…", "answer": ["a1b2c3"], "pow": "<base64 ALTCHA payload>" }
```

`answer` holds one option id per question (0 to 2 entries, each at most 32 characters); it is `[]`
for a fallback challenge. No other properties are allowed. The server checks, in this order:

| # | Check | Refusal |
|---|---|---|
| 1 | the seal opens and has the right shape | `400 invalid-input-response` |
| 2 | the site in the seal exists | `403 invalid-sitekey` |
| 3 | `Origin` is one of the site's hostnames | `403 hostname-mismatch` |
| 4 | the challenge has not expired (server clock) | `422 timeout-or-duplicate` + `next` |
| 5 | the PoW payload is valid and its `cid` is this challenge's | `422 bad-pow` + `next`; counts a failure |
| 6 | the challenge id is spent now, once | `422 timeout-or-duplicate`; `503 store-unavailable` if the store is down |
| 7 | the answer's count and hash match | `422 wrong-answer` + `next`; counts a failure |

The PoW is checked before the challenge is spent, so a bad PoW does not burn it; a wrong answer
does. `next` is a fresh challenge of the same type at the new level. If making `next` hits the
rate limit, the answer is `429 rate-limited` instead.

Success `200`:

```json
{ "token": "k1.<payload>.<mac>", "expires": 1763740300000 }
```

`expires` is Unix milliseconds, a whole second (`token_ttl_s`, default 300 s).

### `POST /api/v1/report`

```json
{ "sealed": "…", "question": 0 }
```

Flags question 0 or 1 of a challenge as wrong or offensive. The server reads the item id from the
seal and records only that, as `bc_item_reports_total`. A repeat of the same report is accepted
and not counted again.

`204` on success. Refusals: `400 invalid-input-response` (bad seal), `400 bad-request` (no such
question), `400 timeout-or-duplicate` (expired challenge), `403 invalid-sitekey` or
`hostname-mismatch`, `503 store-unavailable`.

### `POST /api/v1/siteverify`

Called by the site's backend, never by a browser: it sends no CORS headers. The body is JSON or
`application/x-www-form-urlencoded`:

| Field | Required | Meaning |
|---|---|---|
| `secret` | yes | the site's secret (at most 256 characters) |
| `response` | yes | the token from the form field `bc-response` |
| `sitekey` | no | if given, the token must be for this site |
| `action` | no | if given, the token's action must equal it |
| `remoteip` | no | accepted for compatibility; not used |

**Refusals are HTTP 200** with `success: false`, like reCAPTCHA and Turnstile, except the two
operational ones marked below. Checks, in order:

| # | Check | `error-codes` |
|---|---|---|
| 1 | `secret` present, at most 256 characters | `invalid-secret` |
| 2 | `response` present | `invalid-input-response` |
| 3 | token signature valid (an expired token still names its site) | `invalid-input-response` |
| 4 | the token's site exists | `invalid-sitekey` |
| 5 | SHA-256 of `secret` equals the site's `secret_sha256` (constant time) | `invalid-secret` |
| 6 | `sitekey`, if given, matches | `invalid-sitekey` |
| 7 | per-site limit `siteverify_per_min` (default 600) | **HTTP 429** `rate-limited` |
| 8 | token not expired | `timeout-or-duplicate` |
| 9 | the token's hostname is still one of the site's | `hostname-mismatch` |
| 10 | `action`, if given, matches (checked before spending) | `action-mismatch` |
| 11 | the token id is spent now, once | `timeout-or-duplicate`; **HTTP 503** `store-unavailable` |

Success:

```json
{
  "success": true,
  "challenge_ts": "2026-11-21T10:15:00.000Z",
  "hostname": "example.org",
  "score": 1,
  "action": "login",
  "fallback": false,
  "error-codes": []
}
```

Refusal: `{"success": false, "error-codes": ["timeout-or-duplicate"]}`.

A token verifies **once**. A second siteverify of the same token is `timeout-or-duplicate`.

### `GET /healthz`

`200 {"ok": true, "pack_version": "<version>+<checksum>", "store": "ok"}`; `503` with `ok: false`
and `store: "error"` when the store is not healthy.

### `GET /widget.js`, `GET /widget.worker.js`

The browser widget, served by the API: `access-control-allow-origin: *`, an ETag (304 on a
match), `cache-control: max-age=600`. The server checks the files against `sri.json` at start.

### Error codes

All codes are in `shared/src/protocol.ts`:

| Code | Where | Meaning |
|---|---|---|
| `invalid-sitekey` | all | unknown site, or the origin or `sitekey` does not fit it |
| `invalid-secret` | siteverify | missing or wrong secret |
| `invalid-input-response` | solve, report, siteverify | the seal or token is missing, malformed or forged |
| `timeout-or-duplicate` | solve, report, siteverify | expired, or already used |
| `hostname-mismatch` | solve, report, siteverify | the origin or token host is not one of the site's |
| `rate-limited` | challenge, solve, siteverify | too many requests; retry later |
| `bad-pow` | solve | the proof-of-work is missing, wrong or for another challenge |
| `wrong-answer` | solve | an answer is wrong |
| `bad-request` | all | the request does not match the schema |
| `action-mismatch` | siteverify | the token's action is not the one asked for |
| `store-unavailable` | solve, report, siteverify | the spent-id store is down; the API fails closed |

## Formats

### Keys

One key file holds the server's secret keys:

```json
{ "active": "k2", "keys": { "k1": "<base64, ≥ 32 bytes>", "k2": "<base64, ≥ 32 bytes>" } }
```

- Key ids match `^[A-Za-z0-9_-]{1,16}$`. Unknown fields are refused.
- New seals and tokens use `active`; any listed key still opens or verifies. `bc-admin` rotates
  with two keys overlapping (see the README, "Sites and keys").
- Three purpose keys come from each key with HKDF-SHA-256, empty salt, info
  `belarusian-captcha seal v1`, `belarusian-captcha token v1` and `belarusian-captcha pow v1`.
  The PoW key is used as its hex string.

### Seal

`<kid>.<base64url IV, 12 bytes>.<base64url ciphertext and tag>`, AES-256-GCM, additional data
`belarusian-captcha seal v1:<kid>`, at most 4096 characters. The plaintext is JSON:

| Field | Meaning |
|---|---|
| `v` | `1` |
| `cid` | challenge id |
| `sk` | site key |
| `t` | `proverb` or `fallback` |
| `ah` | answer hash: hex SHA-256 of `cid + "|" + right option ids joined by ","` |
| `lvl` | difficulty level when issued |
| `items` | content item ids, for reports |
| `b` | rate bucket of the requester |
| `act` | action |
| `iat`, `exp` | issued and expiry time, Unix ms |

The client cannot read the answer: the seal is encrypted, and `ah` is a hash over the option ids,
which are random per challenge.

### Proof-of-work

ALTCHA v1 with SHA-256, compatible with the ALTCHA widget's payload:

- `salt = <24 hex>?cid=<cid>&expires=<unix seconds>&`
- `number` is drawn uniformly from `[0, maxnumber]`
- `challenge = hex(SHA-256(salt + number))`
- `signature = hex(HMAC-SHA-256(pow key, challenge))`

The client searches `number` from 0 until the hash matches, then sends
`base64(JSON {algorithm, challenge, number, salt, signature, took})` (at most 2048 characters).
The server recomputes the hash and the signature, compares both in constant time, and refuses a
payload without `expires` or past it (stricter than `altcha-lib`). The PoW key is the one of the
seal's `kid`.

### Token

`<kid>.<base64url JSON payload>.<base64url HMAC-SHA-256>`, at most 2048 characters. The MAC covers
`belarusian-captcha token v1:<kid>.<payload>`. The payload:

| Field | Meaning |
|---|---|
| `v` | `1` |
| `tid` | token id, spent by siteverify |
| `sitekey`, `hostname`, `action` | what the token was issued for |
| `score` | `1` for an answered question, `0.3` for the fallback |
| `fallback` | `true` for the fallback; absent otherwise |
| `iat`, `exp` | Unix **seconds** |

The token is signed, not encrypted: do not put anything secret in an action.

## Difficulty

Per requester bucket (see [`THREAT-MODEL.md`](THREAT-MODEL.md), "Rate"):

```text
level     = clamp(floor(log2(max(r / r0, 1))) + f + s, 0, max_level)
maxnumber = base × 2^level
```

- `r`: the bucket's requests in the last minute; `r0`: the site's `r0_per_min` (default 10).
- `f`: the bucket's failures (`bad-pow`, `wrong-answer`) in the last 10 minutes, at most 3.
- `s`: site surge, `1` above 4× and `2` above 16× the site's baseline (at least 2 × `r0`).
- Defaults: `base` 50000, `max_level` 6. Above `hard_per_min` (default 120) the bucket gets
  `rate-limited`.
- Level 0 and 1 draw easy items; level 4 and up asks two questions.
- The fallback adds 2 levels, capped at `maxnumber < 2^32`.

## Where the code differs from the design

- **Score** is `1` or `0.3` only. The design's score from solve timing is not built.
- **Challenge types**: only `proverb` (and the fallback). `word` and `picture` are phases 2 and 4.
- **Script**: only `cyrl`. Łacinka content is phase 3.
- **Store**: SQLite only. Redis is phase 3, so one replica only.
- **PoW**: SHA-256 only. The memory-hard option is phase 3.
- **Content pack**: the server reads a JSON pack (`bc-pack-json-v1`), not the designed
  `pack.sqlite`; backlog B9 decides.
