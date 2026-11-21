# 0001. The proverb pack stays JSON; `pack.sqlite` waits for the word lists

- Status: accepted (B9)
- Date: 21 November 2026
- Changes: [`DESIGN.md`](../DESIGN.md) sections 2.1 and 2.4, which planned one `pack.sqlite` for all
  content from phase 1

## Context

The design planned one SQLite file, `pack.sqlite`, built by the Python content pipeline and read by
the Node server, holding proverbs, words and the picture index. Phase 1 core shipped a simpler
loader instead: [`server/src/pack.ts`](../../server/src/pack.ts) reads a JSON file
(`format: "bc-pack-json-v1"`), checks every item, keeps the `live` ones in memory and refuses to
start without live items from at least four families. B9, the content pipeline, has to produce
one of the two.

What the phase 1 pack holds:

- proverbs only: 300 reviewed items for the MVP, 1,000+ later (design 3.7), each a few short
  strings; about 100 bytes of JSON per item, so 30 kB to a few hundred kB;
- the server reads every live item on start and draws items and distractors from the whole set in
  memory (`pickItems`, `pickDistractors` in `server/src/challenge.ts`); it never queries the pack.

What later phases add:

- phase 2, distorted word: tens of thousands of GrammarDB lemmas and forms, chosen by length,
  frequency rank and difficulty on every render;
- phase 4, word to picture: a picture index (concept, variant, file, licence) next to image files.

## Decision

1. **Phase 1 keeps `bc-pack-json-v1`.** The content pipeline writes exactly that format; the server
   loader does not change. The pipeline adds top-level fields the server ignores today
   (`licence`, `attribution`, `built_from`), so the format stays version 1.
2. **The pack is built, not edited.** `content/items/proverbs.yaml` is the reviewed source; the
   pack is a build output with a SHA-256 next to it. CI rebuilds the pack and fails when the
   committed pack differs from the build, so the pack never drifts from the reviewed YAML.
3. **The pack holds `live` items only.** Drafts, reviewed-but-not-live and retired items stay in
   the YAML. A drafted proverb that a reviewer has not approved never reaches a public image.
4. **SQLite comes with phase 2, as a second format.** When the word lists arrive, the server gets a
   `bc-pack-sqlite-v1` loader and picks the loader from the file. The JSON loader stays, so a site
   with a mounted JSON pack keeps working (additive change).

## Why

- Size: a few hundred kB loaded once fits in memory; SQLite's indexes buy nothing when the server
  scans the whole set in memory anyway.
- Review: proverbs are reviewed in pull requests (design 3.4). A JSON pack diffs line by line in a
  PR; a binary SQLite file does not, so a reviewer could not see what a pack update really changes.
- One reader: the JSON loader exists, is tested and fails closed. A SQLite reader now would be a
  second code path with nothing to read but the same few hundred items.
- Reproducible: JSON written with sorted keys and a fixed item order is byte-identical on every
  run, so the checksum check in CI is exact. A SQLite file needs extra care (page layout, `VACUUM`,
  no timestamps) to be byte-stable.

## Consequences

- `DESIGN.md` 2.1 and 2.4 say `pack.sqlite` is for phase 2; `PROTOCOL.md` no longer lists the JSON
  pack as a difference from the design.
- The Docker image keeps mounting `/etc/bc/pack.json`.
- Phase 2 pays for the SQLite loader and the format switch (about half a day, inside its 4 days).
- The words never go through JSON: tens of thousands of entries queried by length and rank is what
  SQLite is for.
