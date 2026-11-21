# Threat model

What belarusian-captcha protects, against whom, how the code does it today, and what it leaves to
the site. The reasoning behind it is in [`DESIGN.md`](DESIGN.md) section 1; this file describes
the system as built. To report a vulnerability, see [`SECURITY.md`](../SECURITY.md).

## In one paragraph

This captcha makes abuse **cost** something; it does not prove that a visitor is human. It stops
scripts that do not run JavaScript, makes every attempt cost CPU time that grows with abuse,
refuses replayed and stolen tokens, and keeps the answers out of the browser. It does **not** stop
a determined attacker with a multimodal model that knows Belarusian proverbs, a paid solving farm,
or a patient bot spread over many addresses. A blind guess passes one question 25 % of the time.
Sites should treat a pass as one signal among several (moderation, e-mail confirmation, account
age, honeypot fields), never as proof.

## Assets

| Asset | Where it lives | Why it matters |
|---|---|---|
| Sealing keys | the keys file or `BC_KEYS`, in the API's memory | with them anyone can open seals (read answers), forge PoW challenges and forge tokens |
| Site secrets | the site's backend; the API keeps only SHA-256 in `sites.yaml` | with a secret anyone can verify (and so spend) the site's tokens |
| Pass tokens | the visitor's browser, the form, the site's backend | a token is one admission to one form |
| Spent ids | the SQLite store | without them a challenge or token could be used twice |
| Content pack | the API's image or a mounted file | a scraped pack makes lookup attacks cheap |
| Visitor privacy | requests to the API | the API must not become a tracker |

## Trust zones

```text
 untrusted                         | trusted: the operator          | trusted: the site
 visitor's browser, widget, bots --+--> verify API (keys, store) <--+-- site backend (secret)
                                   |    metrics port, keys file     |
```

- **The browser is untrusted.** Everything it sends is checked; nothing secret is sent to it.
  The answer travels in the browser only inside an encrypted seal.
- **The API** holds the keys and the spent-id store. Whoever runs it can forge passes for every
  site on it.
- **The site's backend** holds its own secret and makes the final decision on the form.

## Attackers and what stops them

| Attacker | What stops or slows it today | What does not |
|---|---|---|
| **Form-filler without JavaScript** | no token: siteverify has nothing to verify | nothing gets through, if the backend verifies |
| **Headless browser** (Playwright, Puppeteer) | a PoW per attempt; difficulty rises with its request rate and failures; one answer per challenge | it can solve at a low rate; a blind guess passes 1 in 4 (1 in 16 at level 4 and up) |
| **Multimodal or text LLM** that knows the proverbs | the PoW per attempt; nothing else | it likely passes, especially on pan-Slavic proverbs; the benchmark (backlog B11) will measure how often |
| **Pool scraper** (collects prompts and answers for lookup) | answers never leave the server; option ids are random per challenge; a bucket does not see its last 16 items again soon; rate limits | a patient scraper with many addresses learns the pool through repeated guessing |
| **Solving farm** (people paid per solve) | the PoW is paid in the farm's browser | farms pass; the design accepts this |
| **GPU or native SHA-256** | levels raise the work for one source | SHA-256 is many times faster natively than in a browser; the memory-hard PoW is phase 3 |
| **Distributed bot** (many IPs) | per-site surge raises difficulty for everyone; per-site siteverify limit | each address stays at a low level; there is no fingerprinting by design |
| **Token replay** | each token id is spent once at siteverify; tokens expire in 5 minutes | a relay inside 5 minutes: a farm solves and hands the token to a bot |
| **Token from another site** | the token is signed with the site key and hostname; siteverify checks the secret against the token's site | — |
| **Challenge replay** | each challenge id is spent once at solve; seals expire in 10 minutes | — |
| **Forged seal or token** | AES-256-GCM seal and HMAC-SHA-256 token under server keys; the key id is in the authenticated data | a leaked key forges everything; rotate it (`bc-admin`) |
| **PoW reuse** | the PoW salt carries the challenge id and an expiry and is signed; the server checks both | — |
| **Burning a site's tokens** without its secret | the secret is checked before a token is spent; the siteverify limit counts only requests with the right secret | — |
| **Flood of challenge requests** | `hard_per_min` per bucket answers 429; per-site surge | a flood from many addresses still costs the API CPU; put a reverse proxy limit in front |
| **Cross-site use of the API from a foreign page** | the browser's `Origin` must be one of the site's hostnames, scheme and port included | a non-browser client can set any `Origin`; that only lets it attempt challenges, which still cost PoW |

## Mitigations as built

1. **Answers stay on the server.** The seal is AES-256-GCM; inside it the answer is a SHA-256
   over the challenge id and the right option ids, which are random per challenge.
2. **Proof-of-work on every attempt**, ALTCHA-compatible SHA-256, bound to the challenge id and
   an expiry. `maxnumber = base × 2^level`.
3. **Adaptive difficulty.** The level grows with the bucket's request rate, its failures in the
   last 10 minutes, and the site's surge over its baseline ([`PROTOCOL.md`](PROTOCOL.md),
   "Difficulty"). Level 4 and up asks two questions.
4. **One answer per challenge.** A wrong answer spends the challenge; the next one is harder. A
   bad PoW is checked before the answer, so it does not spend the challenge, but it counts as a
   failure and raises the level; repeating it only makes the next work harder.
5. **Single-use, short-lived tokens** bound to site, hostname and action. siteverify spends the
   token id once. Spent ids stay in the store until their expiry plus one minute.
6. **Fail closed.** If the store is down, solve and siteverify answer 503 `store-unavailable`;
   the SDKs refuse the form by default (`failOpen: false`).
7. **Site secrets are kept as hashes.** `sites.yaml` holds only the SHA-256 of each secret, so a
   leaked `sites.yaml` does not let anyone call siteverify; the API compares hashes in constant
   time. Seal and PoW checks are constant time too.
8. **Strict parsing.** Every body and query is schema-checked, with length limits on every field
   and a 16 KB body limit. Keys files and `sites.yaml` refuse unknown fields.
9. **Key rotation** with two keys overlapping: new seals and tokens use the active key, old ones
   still open until they expire (`bc-admin`).
10. **Widget integrity.** The API checks its widget files against `sri.json` at start; the release
    publishes the hashes for `integrity` attributes.
11. **SDKs refuse redirects**, so the secret cannot follow one to another host, and never put the
    secret in an error or a log.

## Privacy

- **No cookies, no fingerprinting, no behavioural telemetry**, no third-party calls from the
  widget.
- **IP addresses are not stored.** The rate bucket is an HMAC of the IPv4 address or the IPv6 /64
  under a random key that exists only in memory and changes at UTC midnight and on every restart.
  Buckets cannot be linked across days.
- **Logs carry no IP, user agent, query or body.** Metrics are labelled by site, not by visitor.
- **Reports** (`POST /report`) record only the content item id.
- `remoteip` in siteverify is accepted for compatibility and ignored.

## Residual risks

Known and accepted, or planned:

| Risk | Status |
|---|---|
| Multimodal and text LLMs pass the proverb task | accepted; the benchmark (B11) will publish solve rates |
| Blind guess passes 25 % of one-question challenges | accepted; one answer per challenge, two questions at high levels |
| Solving farms and token relays inside the TTL | accepted; a 5-minute TTL limits the window |
| The fallback passes on PoW alone | by design, so the captcha does not lock people out; it has `score: 0.3` and `fallback: true` and the site decides |
| Native or GPU SHA-256 | the memory-hard PoW is phase 3 |
| One replica only: no failover | Redis store is phase 3 |
| A restart resets rate counters | accepted: they are minutes long anyway |
| The score is only 1 or 0.3 | the timing signal in the design is not built |
| The content pool is finite | larger reviewed pool (B10); more challenge types in phases 2 and 4 |
| A non-browser client can claim any `Origin` | accepted: it gains only attempts, each paying PoW |

## Out of scope

- Proving that a visitor is human, or stopping a targeted attack on one site.
- Account takeover, credential stuffing at scale and payment fraud: use dedicated controls.
- Denial of service on the API itself: the operator's reverse proxy and network handle volume.
- A compromised API host: whoever controls it holds the keys.

## What the operator must do

- Serve the API over https only; keep the metrics port off the public network.
- Set `BC_TRUST_PROXY` behind a reverse proxy, or all visitors share one bucket.
- Keep the keys file and site secrets out of images, repositories and logs; `bc-admin` writes
  the keys file with mode 600, so keep it that way; rotate the sealing key with `bc-admin` if it may have leaked, and replace a leaked
  site secret.
- Run one replica with the store on a persistent volume; watch `/healthz`.
- List every origin of each site in `hostnames`, and nothing else.
- Never use the compose demo's secret (`compose-demo-secret-not-real`) or its keys outside
  `localhost`.

## What the site must do

- Verify every token on the backend, once, before acting on the form; fail closed.
- Pass `action` when one site key protects several forms.
- Decide what fallback passes may do ([`INTEGRATION.md`](INTEGRATION.md), "Score and the
  fallback").
- Keep the secret in the environment.
- Add its own signals for anything valuable: rate limits per account, moderation, e-mail checks.
