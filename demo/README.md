# demo/

The static demo page for the widget, published to GitHub Pages by
[`.github/workflows/pages.yml`](../.github/workflows/pages.yml):
<https://yauhenbichel.github.io/belarusian-captcha/>.

It renders one widget against a configurable verify API, shows the widget's events and the decoded
pass-token payload ("what the server sees"), and says plainly when the API cannot be reached. Its
content is the **SYNTHETIC** test pack, not reviewed Belarusian material. No cookies, no
third-party requests; a meta CSP allows scripts and the worker from the page's own origin only.

## Build and preview

```bash
npm run build:demo        # builds the widget, then demo/dist
node demo/serve.mjs       # http://localhost:4173/ (PORT, HOST)
```

`demo/build.mjs` reads four optional environment variables (the first three, in the Pages
workflow, are repository variables of the same names):

| Variable | Default | What |
| --- | --- | --- |
| `BC_DEMO_SITE_URL` | `https://yauhenbichel.github.io/belarusian-captcha/` | canonical URL, sitemap, Open Graph |
| `BC_DEMO_API` | `https://captcha.yserver.invalid` | the default API base URL; a placeholder that never resolves until an API is deployed |
| `BC_DEMO_SITEKEY` | `demo-sitekey-0001` | the default site key |
| `BC_DEMO_BACKEND` | empty | a same-origin path (`/demo/submit`) the form posts to when a demo backend serves the page; empty on Pages, where the page only shows the token a backend would receive |

The page's address overrides them: `?api=…&sitekey=…&lang=en|be|be-Latn|ru&theme=auto|light|dark`.
The API's `sites.yaml` must list the page's host (for Pages, `yauhenbichel.github.io`) in the
site's `hostnames`.

## Against a local API

Run the server as in the root README with a site whose `hostnames` include `localhost:4173`, then
open `http://localhost:4173/?api=http://localhost:8080&sitekey=<your site key>`.

## With a demo backend: `docker compose up`

[`backends/express/`](backends/express) is a site's backend in a few lines: it serves this page
(built with `BC_DEMO_BACKEND=/demo/submit`), takes the form at `POST /demo/submit`, checks
`bc-response` with `verify()` from the Node SDK (`belarusian-captcha/server`, action `demo`) and
answers `{accepted, verify}`: 200 when accepted, 400 when refused or the token is missing, 503 when
the verify API cannot be reached (it fails closed). `GET /healthz` is its health check. The root
[`compose.yaml`](../compose.yaml) runs it with the API; see the root README. Its settings
(`BC_API_URL`, `BC_SITEKEY`, `BC_SECRET` or `BC_SECRET_FILE`, `BC_DEMO_DIR`, `HOST`, `PORT`) are
in [`backends/express/src/main.ts`](backends/express/src/main.ts). Fastify, Flask and FastAPI
backends with the same contract are planned.

[`compose/`](compose) holds the stack's `sites.yaml` (one site, `demo-sitekey-0001`, for
`localhost:3000`, with a published demo secret: local use only) and `init-keys.mjs`, which makes
the sealing keys on the first start and keeps them after.

## Publishing

The repository's Pages source must be **GitHub Actions** (once, by the owner):

```bash
gh api -X POST repos/YauhenBichel/belarusian-captcha/pages -f build_type=workflow
```

A push to `main` that touches `demo/`, `widget/`, `shared/src/` or the lock file publishes; so does
running the workflow by hand. To roll back, re-run the workflow on an earlier commit or revert.

`robots.txt` and `sitemap.xml` are built, but crawlers read `robots.txt` only at a host's root, so
the copy on a project page (`/belarusian-captcha/robots.txt`) is ignored; the sitemap can be
submitted directly.

## End-to-end tests

[`e2e/`](../e2e) runs Playwright (Chromium) against this page and the verify API from source with
the synthetic pack, an in-memory store and a throwaway all-zero key; see the root README.
`e2e/a11y.spec.ts` scans every widget state with axe-core in the four languages and the light,
dark and auto themes; any WCAG A or AA violation fails the run.
