"""The answer normaliser of docs/DESIGN.md section 3.3, ported from shared/src/normalise.ts.

Both ports are tested on tests/fixtures/normalise.json, so they fold text the same way. The
pipeline uses it to compare items and to match stop-list stems. Step 8 (Łacinka to Cyrillic) is
phase 2 work in both ports.
"""

from __future__ import annotations

import re
import unicodedata

_SPACES = re.compile(r"\s+")
_STRESS_MARKS = re.compile("[\u0300\u0301]")  # combining grave and acute
_APOSTROPHES = re.compile(
    "['\u2019\u02bc\u2018`\u02b9\u044a]"
)  # ' and U+2019 U+02BC U+2018 ` U+02B9, Russian hard sign
_LOOKALIKES = re.compile("[aeiopcxy]")
_LATIN_TO_CYRILLIC = str.maketrans("aeiopcxy", "аеіорсху")


def _has_cyrillic(word: str) -> bool:
    return any(unicodedata.name(ch, "").startswith("CYRILLIC") for ch in word)


def normalise(text: str) -> str:
    """Folds text for comparison. Never shown to anyone."""
    # 1. Unicode NFC, trim, collapse spaces.
    s = _SPACES.sub(" ", unicodedata.normalize("NFC", text).strip())
    # 2. Remove stress marks (decompose so marks on precomposed letters go too, then recompose).
    s = unicodedata.normalize("NFC", _STRESS_MARKS.sub("", unicodedata.normalize("NFD", s)))
    # 3. Lower case (Belarusian has no locale-specific case rules).
    s = s.lower()
    # 4. One apostrophe for every apostrophe-like mark and Russian ъ.
    s = _APOSTROPHES.sub("'", s)
    # 5. ў -> у (a keyboard without ў).
    s = s.replace("ў", "у")
    # 6. Russian keyboard: и -> і, щ -> шч.
    s = s.replace("и", "і").replace("щ", "шч")
    # 7. Latin look-alikes -> Cyrillic, inside words that already contain Cyrillic.
    s = " ".join(
        w.translate(_LATIN_TO_CYRILLIC) if _has_cyrillic(w) and _LOOKALIKES.search(w) else w
        for w in s.split(" ")
    )
    # 8. (phase 2) Łacinka -> Cyrillic.
    # 9. ё -> е, for comparison only.
    return s.replace("ё", "е")


_WORD = re.compile(r"[^\W\d_]+(?:'[^\W\d_]+)*")


def words(text: str) -> list[str]:
    """The folded words of a text: letters, with an apostrophe inside a word kept."""
    return _WORD.findall(normalise(text))
