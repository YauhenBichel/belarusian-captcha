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

`demo/build.mjs` reads three optional environment variables (in the Pages workflow, repository
variables of the same names):

| Variable | Default | What |
| --- | --- | --- |
| `BC_DEMO_SITE_URL` | `https://yauhenbichel.github.io/belarusian-captcha/` | canonical URL, sitemap, Open Graph |
| `BC_DEMO_API` | `https://captcha.yserver.invalid` | the default API base URL; a placeholder that never resolves until an API is deployed |
| `BC_DEMO_SITEKEY` | `demo-sitekey-0001` | the default site key |

The page's address overrides them: `?api=…&sitekey=…&lang=en|be|be-Latn|ru&theme=auto|light|dark`.
The API's `sites.yaml` must list the page's host (for Pages, `yauhenbichel.github.io`) in the
site's `hostnames`.

## Against a local API

Run the server as in the root README with a site whose `hostnames` include `localhost:4173`, then
open `http://localhost:4173/?api=http://localhost:8080&sitekey=<your site key>`.

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
