# content: the proverb items and the pack the server reads

The offline content pipeline of belarusian-captcha (design sections 3.1–3.5,
[ADR 0001](../docs/architecture/0001-content-pack-format.md)). Python, run by hand and in CI, never
at request time.

| Path | What |
|---|---|
| `items/proverbs.yaml` | the reviewed source: every proverb with its cut, source, licence and review records (CC BY-SA 4.0) |
| `stoplist.txt` | word stems that flag an item for a reviewer (section 3.5); a seed list until B10 |
| `pack/proverbs.json` | the built pack, `bc-pack-json-v1`, live items only; **generated, do not edit** |
| `pack/proverbs.json.sha256` | its checksum, `sha256sum -c` format |
| `src/bc_content/` | the checks, the normaliser port, the distractor rules, the build, the report |

## Adding or reviewing an item

1. Add the item to `items/proverbs.yaml` as `status: draft` (the format is in the file's header).
2. Run the check; fix every error and read every stop-list flag:

   ```bash
   cd content
   python -m venv .venv && .venv/bin/pip install --require-hashes -r requirements.txt
   PYTHONPATH=src .venv/bin/python -m bc_content check
   ```

3. Write the reviewers' report and attach what it says to the pull request:

   ```bash
   PYTHONPATH=src .venv/bin/python -m bc_content report -o /tmp/review.md
   ```

   It lists items in different families that may be variants of one proverb (give them the same
   `family` if they are), how many shape-matching distractors every item has, and the stop-list
   flags. With `--verse` it adds spelling and stress flags from
   [belarusian-verse](https://pypi.org/project/belarusian-verse/) (install
   `requirements-verse.txt` first; the first run downloads its GrammarDB tables from Hugging Face).
   The report decides nothing; a native speaker does.
4. Reviewers add their records to `review:` in the same pull request, by handle. With two `ok`
   reviews from different handles and no `reject`, the item may become `live`. A live item whose
   words hit the stop-list also needs the reviewed stems in `allow_flagged`.
5. Rebuild the pack and commit it with the YAML:

   ```bash
   PYTHONPATH=src .venv/bin/python -m bc_content build
   ```

CI runs `build --check`, which fails when the committed pack is not what the YAML builds.

## What the checks enforce

- unique ids; `text` is `cut`, one space and `ending` (end punctuation aside); no two items with
  the same folded text;
- a source with `work` and a licence that fits a CC BY-SA 4.0 pack (`public-domain`, `CC0-1.0`,
  `CC-BY-4.0`, `CC-BY-SA-4.0`);
- `reviewed` and `live` need two `ok` reviews by different handles and no `reject`;
- reviewers are handles, not names; dates are ISO dates;
- unknown keys are errors, so a typo never silently drops a field;
- every live item has at least three distractors of a similar shape: endings of live items from
  other families, different after folding, with the same word count ±1 (design 3.4 rule 1, the
  way `pickDistractors` in `server/src/challenge.ts` draws them).

The server refuses a pack with live items from fewer than four families; until B10 brings reviewed
items the pack is empty, so it is not wired into the image or the compose demo yet.

## Development

```bash
cd content
.venv/bin/pip install --require-hashes -r requirements-dev.txt
.venv/bin/ruff check . && .venv/bin/ruff format --check . && .venv/bin/mypy
PYTHONPATH=src .venv/bin/python -m unittest discover -s tests
```

`tests/fixtures/synthetic/` is a second content root with placeholder items. Its built pack is
committed, CI checks it like the real one, and the server's unit tests load it, so the pipeline and
`server/src/pack.ts` stay in step. After a deliberate change to the pack format, rebuild it:

```bash
PYTHONPATH=src .venv/bin/python -m bc_content --root tests/fixtures/synthetic build
```
