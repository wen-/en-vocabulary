import csv
import json
import unittest

import strict_align as sa

STRICT = sa.HERE / "articles-strict.json"
LEDGER = sa.HERE / "strict-corrections.tsv"


@unittest.skipUnless(STRICT.exists(), "run strict_align.py assemble first")
class StrictOutputTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = json.loads((sa.HERE / "articles-text.json").read_text(encoding="utf-8"))["articles"]
        cls.strict = json.loads(STRICT.read_text(encoding="utf-8"))["articles"]
        with LEDGER.open(encoding="utf-8") as handle:
            cls.ledger = list(csv.DictReader(handle, delimiter="\t", quoting=csv.QUOTE_NONE))

    def test_every_article_keeps_its_title_and_order(self):
        self.assertEqual(len(self.strict), 128)
        self.assertEqual([a["title"] for a in self.strict], [a["title"] for a in self.source])

    def test_english_text_is_identical_to_the_source(self):
        for index, (source, strict) in enumerate(zip(self.source, self.strict), start=1):
            expected = sa.squash("".join(s["en"] for s in source["sentences"] if s["zh"]))
            actual = sa.squash("".join(s["en"] for s in strict["sentences"]))
            self.assertEqual(actual, expected, f"article {index}")

    def test_chinese_differs_from_the_source_only_where_the_ledger_says(self):
        provenance = json.loads((sa.HERE / "strict-provenance.json").read_text(encoding="utf-8"))
        fixed = {(int(r["article"]), int(r["segment"]), int(r["piece"])): r for r in self.ledger}
        seen = set()
        for index, (source, strict, trail) in enumerate(zip(self.source, self.strict, provenance), start=1):
            self.assertEqual(len(strict["sentences"]), len(trail), f"article {index}")
            for sentence, origin in zip(strict["sentences"], trail):
                key = (index, origin["segment"], origin["piece"])
                if key in fixed:
                    seen.add(key)
                    self.assertEqual(sa.squash(origin["original_zh"]), sa.squash(fixed[key]["original_zh"]))
                    self.assertEqual(sentence["zh"], fixed[key]["corrected_zh"])
                else:
                    self.assertEqual(sentence["zh"], origin["original_zh"], f"unlogged change at {key}")
            restored = sa.squash("".join(o["original_zh"] for o in trail))
            self.assertEqual(restored, sa.squash("".join(s["zh"] for s in source["sentences"])), f"article {index}")
        self.assertEqual(seen, set(fixed))

    def test_no_empty_or_oversized_sentences(self):
        for strict in self.strict:
            for sentence in strict["sentences"]:
                self.assertTrue(sentence["en"].strip() and sentence["zh"].strip(), strict["title"])
                self.assertLess(len(sentence["en"]), 1200, sentence["en"][:60])

    def test_every_correction_has_a_reason(self):
        for row in self.ledger:
            self.assertTrue(row["why"].strip() and row["corrected_zh"].strip())


if __name__ == "__main__":
    unittest.main()
