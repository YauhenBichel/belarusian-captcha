# Backlog

The ordered work for belarusian-captcha. The plan and the reasons are in
[`docs/DESIGN.md`](docs/DESIGN.md) (phases in section 9, decisions D1–D14 in section 12); this
file says what is left, in what order, and what is blocked. Last checked against `main` at
`f0f0a3e` on 21 November 2026.

Sizes are working days of engineering. Each item lands as its own branch and PR.

## Now: finish phase 1 (MVP)

Phase 1 is done when a fresh `docker compose up` protects the demo form end to end, a replay is
refused, axe is clean, the bench report is committed, and 0.1.0 is on npm, PyPI and GHCR.

| # | Item | Size | Blocked on | Notes |
|---|---|---|---|---|
| B8d | **FastAPI demo backend** in `demo/backends/fastapi`, through the Python SDK | 0.25 | | same contract, tested with `demo/backends/python_contract.py` as Flask is; its own image (as `demo/backends/flask/Dockerfile`), port 3003, a compose service and a CI smoke run |
| B9 | **Content pipeline** `content/` (Python, uses `belarusian-verse`): items YAML with source and licence, stop-list, distractors, pack build with checksum | 2 | | decide here whether the pack stays JSON (`bc-pack-json-v1`, what the server reads now) or moves to `pack.sqlite` as designed |
| B10 | **300 reviewed proverbs**, two native-speaker reviews per item, recorded by handle | 10–15 h of reviewers' time | **owner: D5, who the reviewers are** | the critical path of phase 1; start finding reviewers now |
| B11 | **Bench for proverbs**: guessing, lookup, text LLM; report in `bench/results/` | 1 | B9, a first slice of B10 | design 8.3 |
| B13 | **Release 0.1.0**: npm and PyPI publish jobs with trusted publishing (OIDC, no tokens), drop `private: true`, tag `v0.1.0` | 0.5 | B1–B12; **owner approves the publish** | GHCR image release already exists (`release.yml`) |

Suggested order: B8d (no outside dependency); B9 as soon
as possible so B10 review can start in parallel; B11 and B13 last.

## Housekeeping

| # | Item | Size | Blocked on |
|---|---|---|---|
| H1 | Live monitor runs every 15 min with `BC_LIVE_URL` unset and always passes: deploy an instance and set the variables, or turn the schedule off until there is one | 0.1 | **owner: where an instance runs (D4)** |
| H3 | `engine-strict=true` in `.npmrc`, so `npm ci` on Node < 24 stops with a clear message instead of tests crashing with SIGSEGV in `better-sqlite3` | 0.1 | |

## Later phases (design section 9)

| Phase | What | Size |
|---|---|---|
| 2 | Distorted word: renderer presets, GrammarDB word list via `belarusian-verse`, Łacinka input, bench with Tesseract, an OCR model and a VLM | 4 |
| 3 | Hardening: Redis store, key rotation drill, memory-hard PoW option, per-site tuning guide, Łacinka content mode, load test | 3 |
| 4 | Word to picture: concept list, offline GPU generation (licence check, D10), human filter, perturbation, CLIP-style bench | 4 + one GPU night |
| 5 | Integrations: WordPress plugin or PHP snippet, framework examples, public docs site | 1.5 |
| 6 | Audio fallback: not planned, D3 chose B and C (B3) | — |

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
| `bc-admin` CLI: sealing keys with two-key overlap, add a site (B2) | #16 |
| Accessible fallback: `GET /api/v1/fallback`, PoW-only pass, score 0.3, `fallback: true` in siteverify (B3, D3 option B; C needs no work) | #17 |
| Python SDK `belarusian-captcha` (B1), cases shared with the Node SDK in `tests/fixtures/siteverify.json` | #19 |
| Widget served by the API: `/widget.js`, `/widget.worker.js`, checked against `sri.json` at start, ETag and 304; release attaches `widget-sri.json` (B4) | #21 |
| Widget exported from the npm package for bundlers (`belarusian-captcha`, worker alongside, self-contained types), packed-package check in CI (B6) | #23 |
| axe-core scan in the e2e: every widget state, four languages, light, dark and auto themes, WCAG A and AA (B7) | #25 |
| "Report this question" in the widget: `POST /api/v1/report` takes the seal and the question index, records only the item id in `bc_item_reports_total` (B5) | #27 |
| `docker compose` demo stack (keys, API, demo backend on 127.0.0.1) and the Express demo backend: token accepted once, replay refused, CI job from a fresh checkout (B8, part 1) | #29, #30 |
| Docs: `docs/PROTOCOL.md`, `docs/INTEGRATION.md` (Node, Python, plain PHP, raw HTTP, CSP), `docs/THREAT-MODEL.md` (B12) | #32 |
| Flaky tamper tests: tamper by flipping a decoded byte, not by editing base64url text (H4) | #34 |
| Fastify demo backend on :3001, one vitest contract suite for both Node backends (`demo/backends/contract.ts`), compose smoke against each backend (B8b) | #36 |
| Flask demo backend on :3002 through the Python SDK, the contract as a Python unittest mixin (`demo/backends/python_contract.py`), own distroless image, CI job (B8c) | #37 |
