"""Optional spelling and stress flags from belarusian-verse, for the reviewers' report.

Not a CI gate and not needed to build the pack: belarusian-verse downloads its GrammarDB tables
(word forms, stress, a Hunspell dictionary) from Hugging Face on first use. Install it with
`pip install --require-hashes -r requirements-verse.txt`. A flag is a hint for a native speaker,
never a verdict: GrammarDB lacks some old and dialect forms that proverbs keep.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class VerseNote:
    stressed: str  # the text with stress marks where GrammarDB knows the word
    flags: list[str] = field(default_factory=list)


Checker = Callable[[str], VerseNote]


class VerseUnavailable(RuntimeError):
    pass


def load_checker() -> Checker:
    """Load the tables once and return a checker for one item text."""
    try:
        import belarusian_verse as bv  # optional: requirements-verse.txt
    except ImportError as e:
        raise VerseUnavailable(
            "belarusian-verse is not installed: "
            "pip install --require-hashes -r requirements-verse.txt"
        ) from e
    dictionary = bv.load_dictionary()
    forms = bv.load_index()
    lexicon = bv.load_lexicon()

    def check(text: str) -> VerseNote:
        spelling: dict[str, Any] = bv.check_spelling(text, dictionary=dictionary, forms=forms)
        stressed, _stats, unknown = bv.mark_text(text, lexicon)
        return VerseNote(stressed=stressed, flags=_flags(spelling, unknown))

    return check


def _flags(spelling: dict[str, Any], unknown: list[tuple[str, str]]) -> list[str]:
    flags = [
        f"{issue['level']} {issue['code']}: {issue['word']}"
        for line in spelling.get("lines", [])
        for issue in line.get("issues", [])
    ]
    flags += [f"STRESS {status}: {word}" for word, status in unknown if status == "unknown"]
    return flags
