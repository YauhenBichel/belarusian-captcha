"""Distractor rules of DESIGN.md 3.4, checked before a pack is built.

Rule 1: the server draws 3 wrong endings per question from other families' live items, preferring
endings of a similar shape (same word count ±1, `pickDistractors` in server/src/challenge.ts). If an
item has fewer than 3 such endings, the server falls back to endings of any length, and the one
ending that fits the start stands out. So every live item must have at least 3 shape-matching
endings, each different after folding, from live items of other families.

Rule 2: an ending from a variant of the same proverb must never be a distractor; the server keeps
variants apart by `family`. The pipeline cannot know variants for sure, so it suggests pairs from
different families whose words overlap, and a reviewer decides.
"""

from __future__ import annotations

from dataclasses import dataclass
from itertools import combinations

from .items import Item
from .normalise import normalise, words

DISTRACTORS = 3  # OPTIONS_PER_QUESTION - 1 in server/src/challenge.ts
SHAPE_TOLERANCE = 1  # word count ±1
STEM = 5  # letters of a folded word compared, so inflected forms of one word still match
VARIANT_OVERLAP = 0.5  # Jaccard of stems at or above which two items look like variants


def word_count(text: str) -> int:
    """Words as the server counts them: split on whitespace."""
    return len(text.split())


def pool(item: Item, live: list[Item]) -> list[str]:
    """The distinct endings of a similar shape the server can draw as distractors for `item`."""
    right = normalise(item.ending)
    n = word_count(item.ending)
    seen = {right}
    out: list[str] = []
    for other in sorted(live, key=lambda i: i.id):
        if other.family == item.family:
            continue
        key = normalise(other.ending)
        if key in seen or abs(word_count(other.ending) - n) > SHAPE_TOLERANCE:
            continue
        seen.add(key)
        out.append(other.ending)
    return out


def pool_errors(items: list[Item]) -> list[str]:
    """One error per live item with fewer than 3 shape-matching distractors."""
    live = [i for i in items if i.status == "live"]
    errors = []
    for item in sorted(live, key=lambda i: i.id):
        size = len(pool(item, live))
        if size < DISTRACTORS:
            errors.append(
                f"{item.id}: {size} distractor(s) of a similar shape "
                f"({word_count(item.ending)}±{SHAPE_TOLERANCE} words, other families, live); "
                f"needs {DISTRACTORS}"
            )
    return errors


def stems(text: str) -> frozenset[str]:
    return frozenset(w[:STEM] for w in words(text))


@dataclass(frozen=True)
class Suggestion:
    a: str
    b: str
    overlap: float


def family_suggestions(items: list[Item]) -> list[Suggestion]:
    """Pairs of items in different families that may be variants of one proverb.

    Retired items are left out: they are never drawn. Sorted by overlap, highest first.
    """
    active = sorted((i for i in items if i.status != "retired"), key=lambda i: i.id)
    keyed = [(i, stems(i.text)) for i in active]
    out = []
    for (a, sa), (b, sb) in combinations(keyed, 2):
        if a.family == b.family or not sa or not sb:
            continue
        overlap = len(sa & sb) / len(sa | sb)
        if overlap >= VARIANT_OVERLAP:
            out.append(Suggestion(a.id, b.id, round(overlap, 2)))
    return sorted(out, key=lambda s: (-s.overlap, s.a, s.b))
