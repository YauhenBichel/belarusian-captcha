"""The stop-list (DESIGN.md 3.5): word stems that make a reviewer look twice.

One stem per line in content/stoplist.txt, `#` starts a comment. A stem matches every folded word
that starts with it, so `stem` also catches its inflected forms. A hit never decides anything on
its own: it flags the item, and a native speaker decides.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from .normalise import normalise, words


@dataclass(frozen=True)
class StopList:
    stems: frozenset[str]

    @classmethod
    def parse(cls, text: str) -> StopList:
        stems = set()
        for line in text.splitlines():
            stem = normalise(line.split("#", 1)[0])
            if stem:
                if " " in stem:
                    raise ValueError(f"stop-list: one stem per line, got {line!r}")
                stems.add(stem)
        return cls(frozenset(stems))

    @classmethod
    def load(cls, path: Path) -> StopList:
        return cls.parse(path.read_text(encoding="utf-8"))

    def hits(self, text: str) -> set[str]:
        """The stems that start some word of the text."""
        return {s for w in words(text) for s in self.stems if w.startswith(s)}
