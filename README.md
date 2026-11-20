# belarusian-captcha

A self-hosted, privacy-friendly CAPTCHA in Belarusian, for any web site: finish a proverb, type a
distorted word, or pick the picture for a word, each backed by an invisible proof-of-work check.

**Капча па-беларуску:** дакончы прыказку, перапішы слова, выберы малюнак.

Status: **phase 1 in progress**: the shared protocol library and the verify API server exist; the
widget, SDKs, Docker image and reviewed content do not yet. The design is in
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

## Licence

Code: Apache-2.0 ([LICENSE](LICENSE)). Content (proverbs, words, pictures): CC BY-SA 4.0. See
[NOTICE](NOTICE).
