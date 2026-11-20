# belarusian-captcha

A self-hosted, privacy-friendly CAPTCHA in Belarusian, for any web site: finish a proverb, type a
distorted word, or pick the picture for a word, each backed by an invisible proof-of-work check.

**Капча па-беларуску:** дакончы прыказку, перапішы слова, выберы малюнак.

Status: **phase 0 (repository set-up)**. The design is in [`docs/DESIGN.md`](docs/DESIGN.md); there is
no released code yet.

## Development

Node 24 (see `.nvmrc`). One npm workspace root; every package's tests run from the root.

```bash
npm ci
npm run check   # lint (Biome), type-check (tsc -b), unit tests (Vitest)
```

## Licence

Code: Apache-2.0 ([LICENSE](LICENSE)). Content (proverbs, words, pictures): CC BY-SA 4.0. See
[NOTICE](NOTICE).
