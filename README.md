# belarusian-captcha

A self-hosted, privacy-friendly CAPTCHA in Belarusian, for any web site: finish a proverb, type a
distorted word, or pick the picture for a word, each backed by an invisible proof-of-work check.

**Капча па-беларуску:** дакончы прыказку, перапішы слова, выберы малюнак.

Status: **phase 1 in progress**: the shared protocol library, the verify API server and its Docker
image exist; the widget, SDKs and reviewed content do not yet. The design is in
[`docs/DESIGN.md`](docs/DESIGN.md); there is no released code yet.

| Package | What it is |
| --- | --- |
| [`shared/`](shared) | ALTCHA-compatible SHA-256 proof-of-work, sealed challenges, pass tokens, the answer normaliser. WebCrypto only, so the widget can reuse it. |
| [`server/`](server) | The verify API: `GET /api/v1/challenge`, `POST /api/v1/solve`, `POST /api/v1/siteverify`, `/healthz`, and `/metrics` on a separate port. SQLite spent store, rate levels. |

The only content in the repository is **synthetic test data**
([`server/test/fixtures/synthetic-pack.json`](server/test/fixtures/synthetic-pack.json)); the
reviewed proverb pack comes from the content pipeline and native-speaker review.

## Development

Node 24 (see `.nvmrc`). One npm workspace root; every package's tests run from the root.

```bash
npm ci
npm run check   # lint (Biome), type-check (tsc -b), unit tests (Vitest)
```

Run the server locally (see [`server/src/main.ts`](server/src/main.ts) for every variable and
[`server/sites.example.yaml`](server/sites.example.yaml) for the site file):

```bash
npm run build
node -e 'console.log(JSON.stringify({active:"k1",keys:{k1:require("crypto").randomBytes(32).toString("base64")}}))' > keys.json
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
| 8080 | the API and `GET /healthz` (the image's `HEALTHCHECK`) | yes, behind your TLS proxy |
| 9464 | Prometheus `GET /metrics` | no: keep it on the host or the internal network |

The image sets `BC_SITES`, `BC_KEYS_FILE`, `BC_PACK` and `BC_STORE` to the paths above and binds
metrics to `0.0.0.0` inside the container; every variable in
[`server/src/main.ts`](server/src/main.ts) can be overridden with `-e`. Set `BC_TRUST_PROXY` to
match your proxy (the example trusts one hop). Build it yourself with `docker build -t
belarusian-captcha-server .` at the repository root; `scripts/docker-smoke.sh <image>` runs the
same smoke test as CI.

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
