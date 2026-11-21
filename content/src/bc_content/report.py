"""The reviewers' report (Markdown): what a pull request with new or changed items should look at.

- items that may be variants of each other but sit in different families (DESIGN.md 3.4 rule 2);
- for every item, how many shape-matching distractors it would have among the live items (rule 1);
- stop-list flags;
- with `--verse`, spelling and stress flags from belarusian-verse.

The report decides nothing. It is printed or written to a file and read by a native speaker.
"""

from __future__ import annotations

from .distractors import DISTRACTORS, family_suggestions, pool, word_count
from .items import Report
from .verse import Checker


def _cell(text: str) -> str:
    return text.replace("|", "\\|").replace("\n", " ")


def render(report: Report, source: str, verse: Checker | None = None) -> str:
    items = sorted(report.items, key=lambda i: i.id)
    live = [i for i in items if i.status == "live"]
    out = [
        f"# Content review report: {source}",
        "",
        f"Version {report.version or '?'}; {len(items)} items, {len(live)} live, "
        f"{len({i.family for i in live})} live families.",
        "",
        "## Possible variants in different families",
        "",
        "Two items whose words overlap may be variants of one proverb; then one's ending must",
        "never be the other's distractor. Give them the same `family`, or leave them if they are",
        "different sayings.",
        "",
    ]
    suggestions = family_suggestions(items)
    if suggestions:
        out += ["| Item | Item | Overlap |", "|---|---|---:|"]
        out += [f"| {s.a} | {s.b} | {s.overlap:.2f} |" for s in suggestions]
    else:
        out.append("None.")

    out += [
        "",
        "## Distractor pools",
        "",
        f"Shape-matching endings from other families' live items; a live item needs {DISTRACTORS}.",
        "",
        "| Item | Status | Family | Ending words | Pool | |",
        "|---|---|---|---:|---:|---|",
    ]
    for i in items:
        if i.status == "retired":
            continue
        size = len(pool(i, live))
        mark = "" if size >= DISTRACTORS else ("**too few**" if i.status == "live" else "few")
        out.append(
            f"| {i.id} | {i.status} | {i.family} | {word_count(i.ending)} | {size} | {mark} |"
        )

    out += ["", "## Stop-list flags", ""]
    out += [f"- {f}" for f in report.flags] or ["None."]

    if verse is not None:
        out += [
            "",
            "## Spelling and stress (belarusian-verse)",
            "",
            "Hints, not verdicts: GrammarDB lacks some old and dialect forms that proverbs keep.",
            "",
            "| Item | Stressed | Flags |",
            "|---|---|---|",
        ]
        for i in items:
            if i.status == "retired":
                continue
            note = verse(i.text)
            flags = "; ".join(note.flags) or "-"
            out.append(f"| {i.id} | {_cell(note.stressed)} | {_cell(flags)} |")
    return "\n".join(out) + "\n"
