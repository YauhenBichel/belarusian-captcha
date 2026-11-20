# Contributing

Thank you for helping. The project is at the design stage: `docs/DESIGN.md` describes what will be
built, and comments on it are welcome as issues or pull-request reviews.

## Code

- One change per pull request, with a test for the behaviour it changes.
- CI must be green; actions are pinned by commit SHA and dependencies by lock file.
- No secrets, keys, IP addresses or personal data in code, tests, fixtures or logs.

## Cutting a release

Releases are tags. On a commit of `main` whose CI is green:

```bash
git switch main && git pull --ff-only
git tag -a v0.1.0 -m "v0.1.0"
git push origin v0.1.0
```

`release.yml` then builds the server image for amd64 and arm64, smoke-tests it, pushes
`ghcr.io/yauhenbichel/belarusian-captcha-server:0.1.0` (and `:latest`, unless the tag has a
pre-release suffix such as `-rc.1`) with provenance and SBOM attestations, and creates the GitHub
release with generated notes. It uses only `GITHUB_TOKEN`; no stored secrets.

If the run fails before the push step, nothing is published: fix it on `main`, delete the tag
(`git push --delete origin v0.1.0 && git tag -d v0.1.0`) and tag again. If only the GitHub release
step failed, re-run that job. The first push creates the GHCR package as private; make it public
once in the package settings.

## Content (proverbs, words, pictures, translations)

Content is licensed **CC BY-SA 4.0**; code is Apache-2.0. By contributing content you agree to
license it under CC BY-SA 4.0.

- Every proverb or phrase needs a source and its licence. Use public-domain collections, Wiktionary
  or Wikiquote, or your own knowledge of a folk saying. Do not copy items from a modern edited
  collection.
- New items enter as `draft` and go live only after two native speakers approve them.
- No ethnic, national or religious slurs or stereotypes, no politics, no obscenity.
- Reviewers are recorded by GitHub handle only.

## Conduct

Be kind and specific. Disagreements about wording are normal; settle them with sources.
