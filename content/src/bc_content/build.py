"""Build the content pack the server reads (bc-pack-json-v1, ADR 0001) from the checked items.

Only `live` items go in. The output is byte-stable for the same input: items sorted by id, keys
sorted, UTF-8, two-space indent, one trailing newline. Next to it goes `<pack>.sha256` in the
`sha256sum` format, so `sha256sum -c` verifies a downloaded pack.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

from .items import Item

FORMAT = "bc-pack-json-v1"
LICENCE = "CC-BY-SA-4.0"
ATTRIBUTION = (
    "belarusian-captcha content pack, CC BY-SA 4.0. Each item names its source; see NOTICE in "
    "https://github.com/YauhenBichel/belarusian-captcha"
)
# The server refuses a pack with live items from fewer families (server/src/pack.ts).
MIN_LIVE_FAMILIES = 4


def pack_document(version: str, items: list[Item]) -> dict[str, Any]:
    live = sorted((i for i in items if i.status == "live"), key=lambda i: i.id)
    return {
        "format": FORMAT,
        "version": version,
        "licence": LICENCE,
        "attribution": ATTRIBUTION,
        "items": [
            {
                "id": i.id,
                "family": i.family,
                "cut": i.cut,
                "ending": i.ending,
                "difficulty": i.difficulty,
                "status": i.status,
                "source": i.source,
                "licence": i.licence,
            }
            for i in live
        ],
    }


def render(version: str, items: list[Item]) -> bytes:
    doc = pack_document(version, items)
    return (json.dumps(doc, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8")


def checksum_line(pack: bytes, name: str) -> str:
    return f"{hashlib.sha256(pack).hexdigest()}  {name}\n"


def live_families(items: list[Item]) -> int:
    return len({i.family for i in items if i.status == "live"})
