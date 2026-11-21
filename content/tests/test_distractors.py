"""Tests of the distractor rules, the family suggestions and the reviewers' report."""

from __future__ import annotations

import contextlib
import io
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from bc_content import distractors, items, report
from bc_content.__main__ import main
from bc_content.stoplist import StopList
from bc_content.verse import VerseNote, VerseUnavailable, _flags

HERE = Path(__file__).resolve().parent
SYNTHETIC_ROOT = HERE / "fixtures" / "synthetic"


def it(
    id: str, ending: str, family: str = "", status: str = "live", cut: str = "Start,"
) -> items.Item:
    return items.Item(
        id=id,
        family=family or id,
        text=f"{cut} {ending}.",
        cut=cut,
        ending=ending,
        source="Test",
        licence="CC0-1.0",
        difficulty="easy",
        status=status,
    )


class PoolTest(unittest.TestCase):
    def test_shape_family_and_folding(self) -> None:
        me = it("a", "two words")
        live = [
            me,
            it("b", "one"),  # 1 word: within ±1
            it("c", "three words here"),  # 3 words: within ±1
            it("d", "far too many words here"),  # 5 words: out of shape
            it("e", "other", family="a"),  # same family: never
            it("f", "Two Words"),  # folds to the right answer: never
            it("g", "ONE"),  # folds to b's ending: counted once
            it("h", "fine pair", status="draft"),  # callers pass live items; see pool_errors
        ]
        self.assertEqual(distractors.pool(me, live), ["one", "three words here", "fine pair"])

    def test_pool_errors_for_live_items_only(self) -> None:
        live = [it(x, f"end {x}") for x in "abc"]
        drafts = [it("d", "end d", status="draft"), it("r", "end r", status="retired")]
        errors = distractors.pool_errors(live + drafts)
        self.assertEqual(len(errors), 3, errors)
        self.assertIn("a: 2 distractor(s) of a similar shape (2±1 words", errors[0])
        live.append(it("d", "end d"))
        self.assertEqual(distractors.pool_errors(live + drafts), [])

    def test_empty_and_synthetic(self) -> None:
        self.assertEqual(distractors.pool_errors([]), [])
        r = items.load(SYNTHETIC_ROOT / "items/proverbs.yaml", StopList(frozenset()))
        self.assertEqual(distractors.pool_errors(r.items), [])


class SuggestionTest(unittest.TestCase):
    def test_variants_by_stem_overlap(self) -> None:
        its = [
            it("v1", "далей будзеш", cut="Цішэй едзеш —"),
            it("v2", "далей будзеш", cut="Ціха едзеш —"),
            it("v3", "тое і пажнеш", cut="Што пасееш,"),
            it("v4", "далей будзеш", cut="Ціха едзеш —", family="v1"),  # already grouped
            it("v5", "далей будзеш", cut="Ціха едзеш —", status="retired"),
        ]
        got = distractors.family_suggestions(its)
        self.assertEqual([(s.a, s.b) for s in got], [("v2", "v4"), ("v1", "v2")])
        self.assertEqual(got[0].overlap, 1.0)
        self.assertEqual(got[1].overlap, 0.6)  # цішэй/ціха differ, 3 of 5 stems shared

    def test_sorted_by_overlap(self) -> None:
        its = [it("a", "x y z w"), it("b", "x y z q"), it("c", "x y z w")]
        got = distractors.family_suggestions(its)
        self.assertEqual((got[0].a, got[0].b, got[0].overlap), ("a", "c", 1.0))


class ReportTest(unittest.TestCase):
    def test_sections(self) -> None:
        r = items.Report(
            version="t",
            items=[
                it("a", "end a"),
                it("b", "end b"),
                it("c", "end c", status="draft"),
                it("x", "end x", status="retired"),
            ],
            flags=["c: stop-list ['bad']"],
        )
        text = report.render(r, "items/proverbs.yaml")
        self.assertIn("4 items, 2 live, 2 live families", text)
        self.assertIn("| a | live | a | 2 | 1 | **too few** |", text)
        self.assertIn("| c | draft | c | 2 | 2 | few |", text)
        self.assertNotIn("| x |", text)
        self.assertIn("- c: stop-list ['bad']", text)
        self.assertNotIn("belarusian-verse", text)

    def test_verse_section(self) -> None:
        r = items.Report(version="t", items=[it("a", "end | a")])

        def fake(text: str) -> VerseNote:
            return VerseNote(stressed=text.upper(), flags=["WARN X: y"])

        text = report.render(r, "p", fake)
        self.assertIn("| a | START, END \\| A. | WARN X: y |", text)

    def test_verse_flags(self) -> None:
        spelling = {"lines": [{"issues": [{"level": "ERROR", "code": "SPELLING", "word": "qq"}]}]}
        unknown = [("слова", "unknown"), ("замок", "ambiguous")]
        self.assertEqual(_flags(spelling, unknown), ["ERROR SPELLING: qq", "STRESS unknown: слова"])


class ReportCliTest(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.root)
        shutil.copytree(SYNTHETIC_ROOT, self.root, dirs_exist_ok=True)

    def run_cli(self, *args: str) -> tuple[int, str]:
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
            code = main(["--root", str(self.root), *args])
        return code, out.getvalue()

    def test_report_to_stdout_and_file(self) -> None:
        code, out = self.run_cli("report")
        self.assertEqual(code, 0, out)
        self.assertIn("# Content review report", out)
        code, out = self.run_cli("report", "-o", str(self.root / "r.md"))
        self.assertEqual(code, 0, out)
        self.assertIn("## Distractor pools", (self.root / "r.md").read_text("utf-8"))

    def test_report_verse_missing(self) -> None:
        with mock.patch("bc_content.__main__.load_checker", side_effect=VerseUnavailable("nope")):
            code, out = self.run_cli("report", "--verse")
        self.assertEqual(code, 1)
        self.assertIn("error: nope", out)

    def test_small_pool_stops_the_build(self) -> None:
        path = self.root / "items/proverbs.yaml"
        path.write_text(
            path.read_text("utf-8").replace("ending a 1", "ending a 1 and a far longer tail"),
            "utf-8",
        )
        code, out = self.run_cli("check")
        self.assertEqual(code, 1, out)
        self.assertIn("syn-a1: 0 distractor(s) of a similar shape (8±1 words", out)


if __name__ == "__main__":
    unittest.main()
