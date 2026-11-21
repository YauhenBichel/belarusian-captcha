# belarusian-captcha

A self-hosted, privacy-friendly CAPTCHA in Belarusian, for any web site: finish a proverb, type a
distorted word, or pick the picture for a word, each backed by an invisible proof-of-work check.

**Капча па-беларуску:** дакончы прыказку, перапішы слова, выберы малюнак.

Status: **phase 1 in progress**: the shared protocol library, the verify API server, its Docker
image, the browser widget and the Node and Python SDKs exist; reviewed content does not yet. The design is in
[`docs/DESIGN.md`](docs/DESIGN.md); there is no released code yet.

To add the captcha to a site, read [`docs/INTEGRATION.md`](docs/INTEGRATION.md) (widget, Node,
Python, plain PHP, any language over HTTP). The wire format is in
[`docs/PROTOCOL.md`](docs/PROTOCOL.md); what it stops and what it does not is in
[`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md).

| Package | What it is |
| --- | --- |
| [`shared/`](shared) | ALTCHA-compatible SHA-256 proof-of-work, sealed challenges, pass tokens, the answer normaliser. WebCrypto only, so the widget can reuse it. |
| [`server/`](server) | The verify API: `GET /api/v1/challenge`, `GET /api/v1/fallback` (the accessible way through: proof-of-work only, a low-score pass marked `fallback: true`), `POST /api/v1/solve`, `POST /api/v1/siteverify`, `/healthz`, and `/metrics` on a separate port. SQLite spent store, rate levels. |
| [`widget/`](widget) | The browser widget: vanilla TypeScript, Shadow DOM, PoW in a Web Worker, `data-sitekey` embed; 5.7 kB gzipped. |
| [`sdk/node/`](sdk/node) | The Node SDK, `belarusian-captcha/server`: `verify(token, {secret, url, ...})` for the site's backend; fail closed by default. No runtime dependencies. |
| [`sdk/python/`](sdk/python) | The Python SDK, `belarusian-captcha` on PyPI: `verify(token, secret=..., url=...)`, Python 3.11+, standard library only. Both SDKs pass the same cases, [`tests/fixtures/siteverify.json`](tests/fixtures/siteverify.json). |
| [`demo/`](demo) | The static demo page (GitHub Pages), the demo backend ([`demo/backends/express/`](demo/backends/express)) and the Playwright end-to-end tests in [`e2e/`](e2e). |

The only content in the repository is **synthetic test data**
([`server/test/fixtures/synthetic-pack.json`](server/test/fixtures/synthetic-pack.json)); the
reviewed proverb pack comes from the content pipeline and native-speaker review.

## Try it: `docker compose up`

```bash
docker compose up --build
```

Then open <http://localhost:3000/>, answer the question and submit the form: the demo backend
checks the token with `siteverify` through the Node SDK and shows the answer; submit again and the
same token is refused. [`compose.yaml`](compose.yaml) starts the verify API (`:8080`), the demo
backend (`:3000`) and a one-shot service that makes the sealing keys on the first start. It is a
**local demo**: it listens on 127.0.0.1 only, serves the synthetic pack, and its site secret is a
published demo value. `docker compose down -v` removes it with its keys. `scripts/compose-smoke.ts`
checks the running stack end to end (CI runs it on every pull request).

## Development

Node 24 (see `.nvmrc`). One npm workspace root; every package's tests run from the root.

```bash
npm ci
npm run check   # lint (Biome), type-check (tsc -b), unit tests (Vitest), widget build + size budget
```

The Python SDK has its own checks (ruff, mypy, unittest); see
[`sdk/python/README.md`](sdk/python/README.md#development).

The demo page and the end-to-end tests (Playwright starts the API and the demo itself):

```bash
npm run build && npm run build:demo
npx playwright install chromium   # once
npm run e2e
```

Run the server locally (see [`server/src/main.ts`](server/src/main.ts) for every variable and
[`server/sites.example.yaml`](server/sites.example.yaml) for the site file):

```bash
npm run build
node server/dist/admin.js keys init --keys keys.json   # mode 0600; the key is never printed
cd server && BC_SITES=sites.example.yaml BC_KEYS_FILE=../keys.json \
  BC_PACK=test/fixtures/synthetic-pack.json BC_STORE=sqlite:../bc.sqlite node dist/main.js
```

## Run with Docker

The image `ghcr.io/yauhenbichel/belarusian-captcha-server` (linux/amd64 and linux/arm64) holds the
server only. Sites, keys and the content pack are mounted, never built in; the SQLite spent store
lives on the `/data` volume. The process runs as uid 65532, so mounted files must be readable by it.

```bash
docker run -d --name bc --read-only --cap-drop ALL --security-opt no-new-privileges \
  -p 8080:8080 \
  -p 127.0.0.1:9464:9464 \
  -v "$PWD/sites.yaml:/etc/bc/sites.yaml:ro" \
  -v "$PWD/bc-keys.json:/run/secrets/bc-keys.json:ro" \
  -v "$PWD/pack.json:/etc/bc/pack.json:ro" \
  -v bc-data:/data \
  -e BC_TRUST_PROXY=1 \
  ghcr.io/yauhenbichel/belarusian-captcha-server:<version>
docker stop -t 30 bc   # SIGTERM: drains in-flight requests (BC_SHUTDOWN_TIMEOUT_MS, 10 s), exits 0
```

| Port | What | Publish it? |
| --- | --- | --- |
| 8080 | the API, the widget (`GET /widget.js`, `/widget.worker.js`) and `GET /healthz` (the image's `HEALTHCHECK`) | yes, behind your TLS proxy |
| 9464 | Prometheus `GET /metrics` | no: keep it on the host or the internal network |

The image sets `BC_SITES`, `BC_KEYS_FILE`, `BC_PACK` and `BC_STORE` to the paths above,
`BC_WIDGET_DIR` to the widget build it carries, and binds metrics to `0.0.0.0` inside the
container; every variable in
[`server/src/main.ts`](server/src/main.ts) can be overridden with `-e`. Set `BC_TRUST_PROXY` to
match your proxy (the example trusts one hop). Build it yourself with `docker build -t
belarusian-captcha-server .` at the repository root; `scripts/docker-smoke.sh <image>` runs the
same smoke test as CI.

### Sites and keys: `bc-admin`

`bc-admin` (`server/dist/admin.js`, in the image too) writes `sites.yaml` and the key file. It
checks every change with the server's own parser before writing, keeps the comments in
`sites.yaml`, and never prints key material. `--dry-run` shows a change without writing it.

```bash
admin() { docker run --rm --read-only --user "$(id -u):$(id -g)" -v "$PWD:/work" \
  ghcr.io/yauhenbichel/belarusian-captcha-server:<version> server/dist/admin.js "$@"; }

admin keys init --keys /work/bc-keys.json
admin site add --sites /work/sites.yaml --host example.by --host www.example.by
admin site rotate-secret <sitekey> --sites /work/sites.yaml
admin site list --sites /work/sites.yaml
```

`site add` and `site rotate-secret` print the site's secret once; give it to the site's backend
for `siteverify`. Only its SHA-256 hash is stored. The server reads both files at start, so
restart it after a change. Make the files readable by uid 65532 before mounting them.

Rotate the sealing key with a two-key overlap: `admin keys rotate --keys /work/bc-keys.json`
adds `kN+1` and makes it active, while tokens sealed with the old key are still accepted.
Restart every server, wait for the longest `token_ttl_s` and `challenge_ttl_s` (10 minutes by
default), then `admin keys remove <old kid>` and
restart again. `keys remove` refuses the active key.

## Live monitor

[`.github/workflows/smoke.yml`](.github/workflows/smoke.yml) runs
[`scripts/live-monitor.ts`](scripts/live-monitor.ts) every 15 minutes against a running server:
`/healthz`, then a challenge, its proof-of-work and answer, `/solve` and `/siteverify`, as a
dedicated monitor site. A failure opens (or comments on) an issue labelled `live-monitor`; the
next good pass closes it. It is off until the repository variable `BC_LIVE_URL` is set; the
header of the workflow lists every setting. The monitor reads the right answers from the content
pack, so it needs the pack the server runs (today the synthetic one). Run it by hand after
`npm run build`:

```bash
BC_LIVE_URL=http://127.0.0.1:8080 BC_MONITOR_SITEKEY=<key> BC_MONITOR_SECRET=<secret> \
  node scripts/live-monitor.ts
```

## Licence

Code: Apache-2.0 ([LICENSE](LICENSE)). Content (proverbs, words, pictures): CC BY-SA 4.0. See
[NOTICE](NOTICE).
