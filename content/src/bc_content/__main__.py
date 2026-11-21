"""bc-content: check the proverb items and build the content pack.

    python -m bc_content check            # errors stop it (exit 1); stop-list flags are printed
    python -m bc_content build            # check, then write pack/proverbs.json and its .sha256
    python -m bc_content build --check    # CI: fail if the committed pack differs from a build
    python -m bc_content report [--verse] [-o FILE]   # Markdown report for reviewers

Paths are relative to --root, the content/ folder by default.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from . import build, distractors, items
from . import report as review
from .stoplist import StopList
from .verse import VerseUnavailable, load_checker

CONTENT = Path(__file__).resolve().parents[2]
ITEMS = Path("items/proverbs.yaml")
STOPLIST = Path("stoplist.txt")
PACK = Path("pack/proverbs.json")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        prog="bc-content", description="Check the proverb items and build the content pack."
    )
    ap.add_argument("--root", type=Path, default=CONTENT, help="the content/ folder")
    sub = ap.add_subparsers(dest="command", required=True)
    sub.add_parser("check", help="check the items")
    b = sub.add_parser("build", help="check the items and write the pack")
    b.add_argument("--check", action="store_true", help="compare with the committed pack only")
    r = sub.add_parser("report", help="write a Markdown report for reviewers")
    r.add_argument(
        "--verse", action="store_true", help="add belarusian-verse spelling and stress flags"
    )
    r.add_argument("-o", "--out", type=Path, help="write to this file instead of stdout")
    args = ap.parse_args(argv)

    root: Path = args.root
    report = items.load(root / ITEMS, StopList.load(root / STOPLIST))
    if args.command == "report":
        return _report(report, args.verse, args.out)
    if not report.errors:
        report.errors += distractors.pool_errors(report.items)
    for flag in report.flags:
        print(f"flag: {flag}")
    for error in report.errors:
        print(f"error: {error}", file=sys.stderr)
    if report.errors:
        print(f"{len(report.errors)} error(s) in {ITEMS}", file=sys.stderr)
        return 1
    by_status = {s: sum(i.status == s for i in report.items) for s in items.STATUSES}
    print(
        f"{ITEMS}: version {report.version}, " + ", ".join(f"{n} {s}" for s, n in by_status.items())
    )
    families = build.live_families(report.items)
    if families < build.MIN_LIVE_FAMILIES:
        print(
            f"note: {families} live families; the server refuses a pack with fewer than "
            f"{build.MIN_LIVE_FAMILIES}"
        )
    if args.command == "check":
        return 0

    pack = build.render(report.version, report.items)
    sha = build.checksum_line(pack, PACK.name)
    pack_path, sha_path = root / PACK, root / PACK.with_name(PACK.name + ".sha256")
    if args.check:
        stale = [
            str(p.relative_to(root))
            for p, want in ((pack_path, pack), (sha_path, sha.encode()))
            if not p.is_file() or p.read_bytes() != want
        ]
        if stale:
            print(
                f"error: {', '.join(stale)} out of date; run `python -m bc_content build` "
                "and commit the result",
                file=sys.stderr,
            )
            return 1
        print(f"{PACK} is up to date ({len(report.live)} live items)")
        return 0
    pack_path.parent.mkdir(parents=True, exist_ok=True)
    pack_path.write_bytes(pack)
    sha_path.write_text(sha, encoding="utf-8")
    print(f"wrote {PACK} ({len(report.live)} live items) and {sha_path.name}")
    return 0


def _report(report: items.Report, verse: bool, out: Path | None) -> int:
    checker = None
    if verse:
        try:
            checker = load_checker()
        except VerseUnavailable as e:
            print(f"error: {e}", file=sys.stderr)
            return 1
    text = review.render(report, str(ITEMS), checker)
    for error in report.errors:
        print(f"error: {error}", file=sys.stderr)
    if out is None:
        sys.stdout.write(text)
    else:
        out.write_text(text, encoding="utf-8")
        print(f"wrote {out}", file=sys.stderr)
    return 1 if report.errors else 0


if __name__ == "__main__":
    sys.exit(main())
