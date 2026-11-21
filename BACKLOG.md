# Backlog

The ordered work for belarusian-captcha. The plan and the reasons are in
[`docs/DESIGN.md`](docs/DESIGN.md) (phases in section 9, decisions D1–D14 in section 12); this
file says what is left, in what order, and what is blocked. Last checked against `main` at
`b3754be` on 21 November 2026.

Sizes are working days of engineering. Each item lands as its own branch and PR.

## Now: finish phase 1 (MVP)

Phase 1 is done when a fresh `docker compose up` protects the demo form end to end, a replay is
refused, axe is clean, the bench report is committed, and 0.1.0 is on npm, PyPI and GHCR.

| # | Item | Size | Blocked on | Notes |
|---|---|---|---|---|
| B1 | **Python SDK** `sdk/python`: `verify(token, secret=, url=, min_score=, fail_open=, timeout=3.0)`, standard library only | 1 | | same result shape and failure rules as the Node SDK (`sdk/node/README.md`), including the `fallback` flag from B3; shared fixtures in `tests/fixtures/` |
| B2 | **`bc-admin` CLI**: generate and rotate sealing keys (two-key overlap), add a site (prints site key and secret, stores only the secret's hash) | 1 | | design 4.3 and section 11 "Key leaked"; nothing exists yet |
| B3 | **Accessible fallback B and C (D3)**: `GET /api/v1/fallback`, PoW-only pass with a low score, `fallback: true` in siteverify; proverb as accessible text | 1 | | the widget already expects it (`widget/src/widget.ts` header comment) |
| B4 | **Serve the widget from the API**: `GET /widget.js`, `/widget.worker.js` with `Cache-Control`, SRI hashes published with the release | 0.5 | | design 5.1; the demo loads the bundle itself today |
| B5 | **"Report this question" link** in the widget: sends only the item id | 0.5 | | design section 11; per-item `bc_item_answers_total` metrics already exist |
| B6 | **Widget export from the npm package** (`belarusian-captcha` for bundlers) | 0.25 | | design 6.4; the package now exports only `./server` |
| B7 | **axe check** in the Playwright e2e | 0.25 | | the "axe clean" condition of phase 1 |
| B8 | **`docker compose` example and demo backends** (Express, Fastify; Flask, FastAPI after B1) | 1 | B1 for Python | "fresh `docker compose up` protects the demo form" |
| B9 | **Content pipeline** `content/` (Python, uses `belarusian-verse`): items YAML with source and licence, stop-list, distractors, pack build with checksum | 2 | | decide here whether the pack stays JSON (`bc-pack-json-v1`, what the server reads now) or moves to `pack.sqlite` as designed |
| B10 | **300 reviewed proverbs**, two native-speaker reviews per item, recorded by handle | 10–15 h of reviewers' time | **owner: D5, who the reviewers are** | the critical path of phase 1; start finding reviewers now |
| B11 | **Bench for proverbs**: guessing, lookup, text LLM; report in `bench/results/` | 1 | B9, a first slice of B10 | design 8.3 |
| B12 | **Docs**: `PROTOCOL.md`, `INTEGRATION.md` (incl. plain PHP), `THREAT-MODEL.md` | 1 | | design 2.3 |
| B13 | **Release 0.1.0**: npm and PyPI publish jobs with trusted publishing (OIDC, no tokens), drop `private: true`, tag `v0.1.0` | 0.5 | B1–B12; **owner approves the publish** | GHCR image release already exists (`release.yml`) |

Suggested order: B2, B3, B1, B4, B6, B7, B5 (no outside dependency), then B8, B12; B9 as soon
as possible so B10 review can start in parallel; B11 and B13 last.

## Housekeeping

| # | Item | Size | Blocked on |
|---|---|---|---|
| H1 | Live monitor runs every 15 min with `BC_LIVE_URL` unset and always passes: deploy an instance and set the variables, or turn the schedule off until there is one | 0.1 | **owner: where an instance runs (D4)** |
| H2 | Dependabot PRs #12 (`@types/better-sqlite3` 9.6.0) and #13 (`actions/upload-artifact` 7.0.2): CI green, need the required review | — | **owner review** |
| H3 | `engine-strict=true` in `.npmrc`, so `npm ci` on Node < 24 stops with a clear message instead of tests crashing with SIGSEGV in `better-sqlite3` | 0.1 | |

## Later phases (design section 9)

| Phase | What | Size |
|---|---|---|
| 2 | Distorted word: renderer presets, GrammarDB word list via `belarusian-verse`, Łacinka input, bench with Tesseract, an OCR model and a VLM | 4 |
| 3 | Hardening: Redis store, key rotation drill, memory-hard PoW option, per-site tuning guide, Łacinka content mode, load test | 3 |
| 4 | Word to picture: concept list, offline GPU generation (licence check, D10), human filter, perturbation, CLIP-style bench | 4 + one GPU night |
| 5 | Integrations: WordPress plugin or PHP snippet, framework examples, public docs site | 1.5 |
| 6 | Audio fallback, only if D3 = A | 3 |

## Done

| What | PR |
|---|---|
| Design | #1, #7 |
| Phase 0: repository files, SHA-pinned CI, Dependabot | #2 |
| Shared protocol library (PoW, seal, tokens, normaliser) | #4, #5 |
| Verify API server (challenge, solve, siteverify, SQLite store, rate levels, metrics) and hardening | #4, #5 |
| Docker image, CI smoke test, GHCR release workflow | #6 |
| Live monitor script and workflow | #8 |
| Browser widget (Web Worker PoW, i18n, themes, accessibility, size budget) | #9 |
| Demo page, Playwright e2e, GitHub Pages | #10, #11 |
| Node SDK `belarusian-captcha/server` | #14 |
