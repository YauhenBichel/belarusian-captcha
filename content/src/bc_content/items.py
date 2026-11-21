"""Proverb items: load content/items/proverbs.yaml and check every rule of DESIGN.md 3.4 and 3.5.

Errors stop the build. Flags (stop-list hits on items that are not live) are printed for the
reviewer and do not stop it. A live item with a stop-list hit is an error unless the item names the
reviewed stems in `allow_flagged`.
"""

from __future__ import annotations

import datetime as dt
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

from .normalise import normalise
from .stoplist import StopList

ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
HANDLE = re.compile(r"^[A-Za-z0-9_.-]{1,39}$")
VERSION = re.compile(r"^[A-Za-z0-9._-]{1,32}$")
DIFFICULTIES = ("easy", "normal", "hard")
STATUSES = ("draft", "reviewed", "live", "retired")
VERDICTS = ("ok", "changes", "reject")
# Licences that may go into a CC BY-SA 4.0 pack (DESIGN.md 3.1).
LICENCES = ("public-domain", "CC0-1.0", "CC-BY-4.0", "CC-BY-SA-4.0")
REVIEWS_NEEDED = 2  # D5: two native speakers
MAX_LEN = 200  # the server refuses longer cut or ending strings
END_PUNCTUATION = ".!?…"

ITEM_KEYS = {
    "id", "family", "text", "cut", "ending", "source", "difficulty", "tags", "review", "status",
    "allow_flagged", "note",
}  # fmt: skip
REQUIRED_KEYS = {"id", "text", "cut", "ending", "source", "difficulty", "status"}
SOURCE_KEYS = {"work", "page", "url", "licence"}
REVIEW_KEYS = {"reviewer", "verdict", "date", "note"}


@dataclass(frozen=True)
class Item:
    id: str
    family: str
    text: str
    cut: str
    ending: str
    source: str
    licence: str
    difficulty: str
    status: str


@dataclass
class Report:
    version: str = ""
    items: list[Item] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    flags: list[str] = field(default_factory=list)

    @property
    def live(self) -> list[Item]:
        return [i for i in self.items if i.status == "live"]


def load(path: Path, stoplist: StopList) -> Report:
    try:
        doc = yaml.safe_load(path.read_text(encoding="utf-8"))
    except yaml.YAMLError as e:
        return Report(errors=[f"{path}: not valid YAML: {e}"])
    return check(doc, stoplist)


def check(doc: Any, stoplist: StopList) -> Report:
    r = Report()
    if not isinstance(doc, dict) or set(doc) != {"version", "items"}:
        r.errors.append("the file must be a mapping with exactly `version` and `items`")
        return r
    if not isinstance(doc["version"], str) or not VERSION.match(doc["version"]):
        r.errors.append("version: a string of letters, digits, '.', '_' or '-'")
    else:
        r.version = doc["version"]
    if not isinstance(doc["items"], list):
        r.errors.append("items: must be a list (`[]` when empty)")
        return r
    seen_ids: set[str] = set()
    seen_texts: dict[str, str] = {}
    for n, raw in enumerate(doc["items"]):
        item = _check_item(raw, f"items[{n}]", r, stoplist)
        if item is None:
            continue
        where = f"{item.id}"
        if item.id in seen_ids:
            r.errors.append(f"{where}: duplicate id")
        seen_ids.add(item.id)
        folded = normalise(item.text.rstrip(END_PUNCTUATION))
        if folded in seen_texts:
            r.errors.append(f"{where}: same text as {seen_texts[folded]}")
        seen_texts.setdefault(folded, item.id)
        r.items.append(item)
    return r


def _check_item(raw: Any, where: str, r: Report, stoplist: StopList) -> Item | None:
    if not isinstance(raw, dict):
        r.errors.append(f"{where}: must be a mapping")
        return None
    if isinstance(raw.get("id"), str) and ID.match(raw["id"]):
        where = raw["id"]
    errors: list[str] = []
    unknown = sorted(set(raw) - ITEM_KEYS, key=str)
    if unknown:
        errors.append(f"unknown keys {unknown}")
    missing = sorted(REQUIRED_KEYS - set(raw))
    if missing:
        errors.append(f"missing keys {missing}")
    for key in ("id", "text", "cut", "ending", "difficulty", "status"):
        if key in raw and (not isinstance(raw[key], str) or not raw[key].strip()):
            errors.append(f"{key}: must be a non-empty string")
    if errors:
        r.errors.extend(f"{where}: {e}" for e in errors)
        return None

    family = raw.get("family", raw["id"])
    if not ID.match(raw["id"]):
        errors.append("id: letters, digits, '_' or '-', at most 64")
    if not isinstance(family, str) or not ID.match(family):
        errors.append("family: letters, digits, '_' or '-', at most 64")
    if raw["difficulty"] not in DIFFICULTIES:
        errors.append(f"difficulty: one of {', '.join(DIFFICULTIES)}")
    if raw["status"] not in STATUSES:
        errors.append(f"status: one of {', '.join(STATUSES)}")

    text, cut, ending = (" ".join(raw[k].split()) for k in ("text", "cut", "ending"))
    if len(cut) > MAX_LEN or len(ending) > MAX_LEN:
        errors.append(f"cut and ending: at most {MAX_LEN} characters each")
    if text.rstrip(END_PUNCTUATION) != f"{cut} {ending}".rstrip(END_PUNCTUATION):
        errors.append("text must be `cut`, one space, `ending` (end punctuation aside)")

    source, licence = _check_source(raw["source"], errors)
    _check_tags(raw.get("tags", []), errors)
    approvals = _check_reviews(raw.get("review", []), errors)
    if raw["status"] in ("reviewed", "live") and approvals < REVIEWS_NEEDED:
        errors.append(
            f"status {raw['status']} needs {REVIEWS_NEEDED} `ok` reviews by different handles "
            f"and no `reject`; has {approvals}"
        )

    allowed = raw.get("allow_flagged", [])
    if not isinstance(allowed, list) or not all(isinstance(s, str) for s in allowed):
        errors.append("allow_flagged: a list of stop-list stems")
        allowed = []
    hits = stoplist.hits(text)
    unreviewed = sorted(hits - {normalise(s) for s in allowed})
    if unreviewed:
        if raw["status"] == "live":
            errors.append(
                f"stop-list {unreviewed}: a reviewer must check the item and list the stems in "
                "`allow_flagged`"
            )
        else:
            r.flags.append(f"{where}: stop-list {unreviewed}")

    if errors:
        r.errors.extend(f"{where}: {e}" for e in errors)
        return None
    return Item(
        id=raw["id"],
        family=str(family),
        text=text,
        cut=cut,
        ending=ending,
        source=source,
        licence=licence,
        difficulty=raw["difficulty"],
        status=raw["status"],
    )


def _check_source(src: Any, errors: list[str]) -> tuple[str, str]:
    if not isinstance(src, dict) or not {"work", "licence"} <= set(src):
        errors.append("source: a mapping with at least `work` and `licence`")
        return "", ""
    if set(src) - SOURCE_KEYS:
        errors.append(f"source: unknown keys {sorted(set(src) - SOURCE_KEYS, key=str)}")
    if not all(isinstance(v, str | int) and str(v).strip() for v in src.values()):
        errors.append("source: every value must be non-empty")
        return "", ""
    if src["licence"] not in LICENCES:
        errors.append(f"source.licence: one of {', '.join(LICENCES)}")
    parts = [str(src["work"])]
    if "page" in src:
        parts.append(f"p. {src['page']}")
    if "url" in src:
        parts.append(str(src["url"]))
    return ", ".join(parts), str(src["licence"])


def _check_tags(tags: Any, errors: list[str]) -> None:
    if not isinstance(tags, list) or not all(isinstance(t, str) and ID.match(t) for t in tags):
        errors.append("tags: a list of short ids")


def _check_reviews(reviews: Any, errors: list[str]) -> int:
    """Number of distinct handles that said `ok`, or 0 if anyone said `reject`."""
    if not isinstance(reviews, list):
        errors.append("review: a list")
        return 0
    ok: set[str] = set()
    rejected = False
    for n, rv in enumerate(reviews):
        where = f"review[{n}]"
        if not isinstance(rv, dict) or not {"reviewer", "verdict", "date"} <= set(rv):
            errors.append(f"{where}: needs reviewer, verdict and date")
            continue
        if set(rv) - REVIEW_KEYS:
            errors.append(f"{where}: unknown keys {sorted(set(rv) - REVIEW_KEYS, key=str)}")
        if not isinstance(rv["reviewer"], str) or not HANDLE.match(rv["reviewer"]):
            errors.append(
                f"{where}.reviewer: a handle (letters, digits, '.', '_', '-'), not a name"
            )
            continue
        if rv["verdict"] not in VERDICTS:
            errors.append(f"{where}.verdict: one of {', '.join(VERDICTS)}")
        if not _is_iso_date(rv["date"]):
            errors.append(f"{where}.date: an ISO date, 2026-11-21")
        if rv["verdict"] == "ok":
            ok.add(rv["reviewer"])
        elif rv["verdict"] == "reject":
            rejected = True
    return 0 if rejected else len(ok)


def _is_iso_date(value: Any) -> bool:
    """A YAML date (2026-11-21) or the same written as a quoted string."""
    if isinstance(value, dt.date):
        return True
    if not isinstance(value, str) or len(value) != 10:
        return False
    try:
        dt.date.fromisoformat(value)
    except ValueError:
        return False
    return True
