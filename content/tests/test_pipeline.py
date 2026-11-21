"""Tests of the content pipeline: normaliser, item checks, stop-list, pack build, CLI."""

from __future__ import annotations

import contextlib
import copy
import datetime as dt
import hashlib
import io
import json
import shutil
import tempfile
import unittest
from pathlib import Path
from typing import Any

from bc_content import build, items
from bc_content.__main__ import main
from bc_content.normalise import normalise, words
from bc_content.stoplist import StopList

HERE = Path(__file__).resolve().parent
CONTENT = HERE.parent
REPO = CONTENT.parent
SYNTHETIC_ROOT = HERE / "fixtures" / "synthetic"
SYNTHETIC = SYNTHETIC_ROOT / "items/proverbs.yaml"
SYNTHETIC_PACK = SYNTHETIC_ROOT / "pack/proverbs.json"
EMPTY = StopList(frozenset())

REVIEWS = [
    {"reviewer": "rev-one", "verdict": "ok", "date": dt.date(2026, 11, 1)},
    {"reviewer": "rev-two", "verdict": "ok", "date": dt.date(2026, 11, 2)},
]
ITEM: dict[str, Any] = {
    "id": "t-1",
    "text": "Start of it, and the end.",
    "cut": "Start of it,",
    "ending": "and the end",
    "source": {"work": "Test", "licence": "public-domain"},
    "difficulty": "easy",
    "review": REVIEWS,
    "status": "live",
}


def doc(*its: dict[str, Any]) -> dict[str, Any]:
    return {"version": "t", "items": list(its)}


def item(**changes: Any) -> dict[str, Any]:
    it = copy.deepcopy(ITEM)
    for k, v in changes.items():
        if v is None:
            it.pop(k, None)
        else:
            it[k] = v
    return it


class NormaliseTest(unittest.TestCase):
    def test_shared_fixture(self) -> None:
        cases = json.loads((REPO / "tests/fixtures/normalise.json").read_text("utf-8"))["cases"]
        self.assertGreater(len(cases), 10)
        for case in cases:
            with self.subTest(case=case):
                self.assertEqual(normalise(case["input"]), case["expected"])

    def test_words_keep_inner_apostrophe(self) -> None:
        self.assertEqual(words("Сям’я́, і — ЎСЁ!"), ["сям'я", "і", "усе"])


class ItemsTest(unittest.TestCase):
    def errors(self, *its: dict[str, Any], stoplist: StopList = EMPTY) -> list[str]:
        return items.check(doc(*its), stoplist).errors

    def assertRefused(self, it: dict[str, Any], needle: str) -> None:
        errs = self.errors(it)
        self.assertTrue(any(needle in e for e in errs), f"{needle!r} not in {errs}")

    def test_valid_item(self) -> None:
        r = items.check(doc(item()), EMPTY)
        self.assertEqual(r.errors, [])
        self.assertEqual(r.items[0].family, "t-1", "family defaults to the id")
        self.assertEqual(r.items[0].source, "Test")

    def test_file_shape(self) -> None:
        bads: list[Any] = [None, [], {"items": []}, {"version": "x", "items": [], "extra": 1}]
        for bad in bads:
            with self.subTest(bad=bad):
                self.assertTrue(items.check(bad, EMPTY).errors)
        self.assertTrue(items.check({"version": "a b", "items": []}, EMPTY).errors)
        self.assertTrue(items.check({"version": "x", "items": {}}, EMPTY).errors)

    def test_required_and_unknown_keys(self) -> None:
        self.assertRefused(item(source=None), "missing keys ['source']")
        self.assertRefused(item(answer="x"), "unknown keys ['answer']")
        mixed: dict[Any, Any] = {**item(), 1: "x", "zz": "y"}  # YAML keys need not be strings
        self.assertRefused(mixed, "unknown keys [1, 'zz']")
        self.assertRefused(item(cut="  "), "cut: must be a non-empty string")

    def test_text_is_cut_plus_ending(self) -> None:
        self.assertRefused(item(ending="and an end"), "text must be")
        self.assertEqual(self.errors(item(text="Start  of it,\nand the end!")), [])

    def test_ids_enums_lengths(self) -> None:
        self.assertRefused(item(id="has space"), "id:")
        self.assertRefused(item(family="x/y"), "family:")
        self.assertRefused(item(difficulty="medium"), "difficulty")
        self.assertRefused(item(status="published"), "status")
        long = "x" * 201
        self.assertRefused(item(cut=long, text=f"{long} and the end"), "at most 200")

    def test_source_and_licence(self) -> None:
        self.assertRefused(item(source={"work": "Test"}), "source: a mapping")
        self.assertRefused(item(source={"work": "T", "licence": "CC-BY-NC-4.0"}), "licence")
        self.assertRefused(item(source={"work": "T", "licence": "CC0-1.0", "isbn": 1}), "unknown")
        r = items.check(
            doc(item(source={"work": "W", "page": 12, "url": "https://x", "licence": "CC0-1.0"})),
            EMPTY,
        )
        self.assertEqual(r.items[0].source, "W, p. 12, https://x")

    def test_live_needs_two_reviewers(self) -> None:
        self.assertRefused(item(review=REVIEWS[:1]), "needs 2 `ok` reviews")
        same = [REVIEWS[0], {**REVIEWS[1], "reviewer": "rev-one"}]
        self.assertRefused(item(review=same), "has 1")
        reject = [*REVIEWS, {"reviewer": "rev-three", "verdict": "reject", "date": dt.date.today()}]
        self.assertRefused(item(review=reject), "has 0")
        self.assertRefused(item(status="reviewed", review=[]), "needs 2")
        for status in ("draft", "retired"):
            self.assertEqual(self.errors(item(status=status, review=None)), [])

    def test_review_records(self) -> None:
        bad_handle = [{**REVIEWS[0], "reviewer": "Jan Kowalski"}, REVIEWS[1]]
        self.assertRefused(item(review=bad_handle), "a handle")
        bad_date = [{**REVIEWS[0], "date": "1 Nov"}, REVIEWS[1]]
        self.assertRefused(item(review=bad_date), "ISO date")
        bad_verdict = [{**REVIEWS[0], "verdict": "fine"}, REVIEWS[1]]
        self.assertRefused(item(review=bad_verdict), "verdict")
        self.assertRefused(item(review=[{"reviewer": "x"}]), "needs reviewer")
        quoted = [{**REVIEWS[0], "date": "2026-11-01"}, REVIEWS[1]]
        self.assertEqual(self.errors(item(review=quoted)), [], "a quoted ISO date is fine")

    def test_duplicates(self) -> None:
        errs = self.errors(item(), item())
        self.assertTrue(any("duplicate id" in e for e in errs), errs)
        other = item(
            id="t-2", text="START of it, and the END", cut="START of it,", ending="and the END"
        )
        self.assertTrue(any("same text as t-1" in e for e in self.errors(item(), other)))

    def test_stoplist_flags_drafts_and_blocks_live(self) -> None:
        stop = StopList.parse("end\n")
        r = items.check(doc(item(status="draft")), stop)
        self.assertEqual(r.errors, [])
        self.assertEqual(r.flags, ["t-1: stop-list ['end']"])
        errs = self.errors(item(), stoplist=stop)
        self.assertTrue(any("allow_flagged" in e for e in errs), errs)
        self.assertEqual(self.errors(item(allow_flagged=["END"]), stoplist=stop), [])
        self.assertRefused(item(allow_flagged="end"), "allow_flagged: a list")


class StopListTest(unittest.TestCase):
    def test_stems_fold_and_match_prefixes(self) -> None:
        stop = StopList.parse("# comment\nВА́йн  # war\n\nдзеўк\n")
        self.assertEqual(stop.stems, frozenset({"вайн", "дзеук"}))
        self.assertEqual(stop.hits("Пасля ВАЙНЫ дзеўкі"), {"вайн", "дзеук"})
        self.assertEqual(stop.hits("сваяк"), set())

    def test_one_stem_per_line(self) -> None:
        with self.assertRaises(ValueError):
            StopList.parse("two words\n")

    def test_repository_stoplist_loads(self) -> None:
        stems = StopList.load(CONTENT / "stoplist.txt").stems
        self.assertGreater(len(stems), 20)
        self.assertTrue(all(s == normalise(s) for s in stems))


class BuildTest(unittest.TestCase):
    def synthetic(self) -> items.Report:
        r = items.load(SYNTHETIC, EMPTY)
        self.assertEqual(r.errors, [])
        return r

    def test_synthetic_pack_is_byte_stable(self) -> None:
        r = self.synthetic()
        pack = build.render(r.version, r.items)
        self.assertEqual(
            pack,
            SYNTHETIC_PACK.read_bytes(),
            "rebuild the fixture: --root tests/fixtures/synthetic build",
        )
        self.assertEqual(build.render(r.version, list(reversed(r.items))), pack)

    def test_pack_holds_live_items_only(self) -> None:
        r = self.synthetic()
        d = json.loads(build.render(r.version, r.items))
        self.assertEqual(d["format"], "bc-pack-json-v1")
        self.assertEqual(d["version"], "synthetic-1")
        ids = [x["id"] for x in d["items"]]
        self.assertEqual(ids, sorted(ids))
        self.assertNotIn("syn-draft", ids)
        self.assertNotIn("syn-e2", ids, "retired")
        self.assertEqual({x["status"] for x in d["items"]}, {"live"})
        self.assertEqual(build.live_families(r.items), 5)

    def test_checksum_line(self) -> None:
        line = build.checksum_line(b"abc", "p.json")
        self.assertEqual(line, f"{hashlib.sha256(b'abc').hexdigest()}  p.json\n")


class CliTest(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.root)
        (self.root / "items").mkdir()
        shutil.copy(SYNTHETIC, self.root / "items/proverbs.yaml")
        (self.root / "stoplist.txt").write_text("# none\n", "utf-8")

    def run_cli(self, *args: str) -> tuple[int, str]:
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
            code = main(["--root", str(self.root), *args])
        return code, out.getvalue()

    def test_build_then_check(self) -> None:
        self.assertEqual(self.run_cli("build", "--check")[0], 1, "no pack yet")
        code, out = self.run_cli("build")
        self.assertEqual(code, 0, out)
        self.assertIn("9 live items", out)
        pack = (self.root / "pack/proverbs.json").read_bytes()
        self.assertEqual(pack, SYNTHETIC_PACK.read_bytes())
        sha = (self.root / "pack/proverbs.json.sha256").read_text("utf-8")
        self.assertEqual(sha, build.checksum_line(pack, "proverbs.json"))
        self.assertEqual(self.run_cli("build", "--check")[0], 0)
        (self.root / "pack/proverbs.json").write_bytes(pack.replace(b"ending a 1", b"ending a 9"))
        code, out = self.run_cli("build", "--check")
        self.assertEqual(code, 1)
        self.assertIn("pack/proverbs.json out of date", out)

    def test_errors_stop_the_build(self) -> None:
        (self.root / "items/proverbs.yaml").write_text("version: x\nitems: [1]\n", "utf-8")
        code, out = self.run_cli("build")
        self.assertEqual(code, 1)
        self.assertIn("items[0]: must be a mapping", out)
        self.assertFalse((self.root / "pack").exists())
        (self.root / "items/proverbs.yaml").write_text("items: [", "utf-8")
        self.assertIn("not valid YAML", self.run_cli("check")[1])

    def test_committed_packs_are_current(self) -> None:
        for root in (CONTENT, SYNTHETIC_ROOT):
            with self.subTest(root=root.name):
                out = io.StringIO()
                with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
                    code = main(["--root", str(root), "build", "--check"])
                self.assertEqual(code, 0, out.getvalue())


if __name__ == "__main__":
    unittest.main()
