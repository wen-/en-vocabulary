import json
import tempfile
import unittest
from pathlib import Path

import strict_align as sa

EN = "First idea is here. Second idea follows. Third idea ends it."
ZH = "第一个想法在这里。第二个想法随后。第三个想法结束它。"


def article(en=EN, zh=ZH):
    return [{"title": "T", "sentences": [{"en": en, "zh": zh}]}]


def run(decision, articles=None):
    return sa.assemble(articles or article(), {(1, 1): {"article": 1, "segment": 1, **decision}})


class StrictAlignTests(unittest.TestCase):
    def test_ok_pairs_equal_counts_in_order(self):
        result = run({"ok": True})
        self.assertTrue(result["complete"])
        pairs = result["articles"][0]["sentences"]
        self.assertEqual([p["en"] for p in pairs], ["First idea is here.", "Second idea follows.", "Third idea ends it."])
        self.assertEqual(pairs[1]["zh"], "第二个想法随后。")

    def test_ok_with_unequal_counts_is_rejected(self):
        result = run({"ok": True}, article(zh="第一个想法在这里。第二个想法随后。"))
        self.assertFalse(result["complete"])
        self.assertIn("equal counts", result["errors"][0])

    def test_zh_starts_cut_a_clause_without_losing_text(self):
        zh = "第一个想法在这里，第二个想法随后。第三个想法结束它。"
        result = run({"zh_starts": ["第一", "第二", "第三"]}, article(zh=zh))
        zhs = [p["zh"] for p in result["articles"][0]["sentences"]]
        self.assertEqual(zhs, ["第一个想法在这里，", "第二个想法随后。", "第三个想法结束它。"])
        self.assertEqual("".join(zhs), zh)

    def test_missing_chinese_is_unresolved_not_invented(self):
        zh = "第一个想法在这里。第三个想法结束它。"
        result = run({"zh_starts": ["第一", None, "第三"]}, article(zh=zh))
        self.assertFalse(result["complete"])
        self.assertEqual(result["unresolved"][0]["piece"], 1)
        self.assertEqual(result["articles"][0]["sentences"][1]["zh"], "")

    def test_fix_for_missing_chinese_is_applied_and_logged(self):
        zh = "第一个想法在这里。第三个想法结束它。"
        fix = {"1": {"text": "第二个想法随后。", "why": "source omits this sentence"}}
        result = run({"zh_starts": ["第一", None, "第三"], "zh_fixed": fix}, article(zh=zh))
        self.assertTrue(result["complete"])
        self.assertEqual(result["articles"][0]["sentences"][1]["zh"], "第二个想法随后。")
        self.assertEqual(result["corrections"][0]["original"], "")

    def test_fix_for_wrong_translation_keeps_the_original_in_the_ledger(self):
        zh = "第一个想法在这里。第二个想法随后。第三个想法结束它。"
        fix = {"1": {"text": "第二个想法接着出现。", "why": "wrong verb"}}
        result = run({"ok": True, "zh_fixed": fix}, article(zh=zh))
        self.assertEqual(result["articles"][0]["sentences"][1]["zh"], "第二个想法接着出现。")
        self.assertEqual(result["corrections"][0]["original"], "第二个想法随后。")
        self.assertEqual(result["corrections"][0]["why"], "wrong verb")

    def test_fix_without_reason_or_with_bad_index_is_rejected(self):
        self.assertIn("text and why", run({"ok": True, "zh_fixed": {"0": {"text": "新"}}})["errors"][0])
        self.assertIn("out of range", run({"ok": True, "zh_fixed": {"9": {"text": "新", "why": "x"}}})["errors"][0])

    def test_english_is_never_changed_by_a_fix(self):
        fix = {"0": {"text": "新译文。", "why": "x"}}
        result = run({"ok": True, "zh_fixed": fix})
        self.assertEqual(result["articles"][0]["sentences"][0]["en"], "First idea is here.")

    def test_dropping_leading_chinese_is_rejected(self):
        result = run({"zh_starts": ["第二", "第三", "第三个"]})
        self.assertFalse(result["complete"])

    def test_start_text_not_in_paragraph_is_rejected(self):
        result = run({"zh_starts": ["第一", "没有", "第三"]})
        self.assertIn("not found", result["errors"][0])

    def test_en_groups_merge_sentences_and_must_cover_all(self):
        result = run({"en_groups": [[0, 1], [2]], "zh_starts": ["第一", "第三"]})
        self.assertEqual(result["articles"][0]["sentences"][0]["en"], "First idea is here. Second idea follows.")
        bad = run({"en_groups": [[0], [2]], "zh_starts": ["第一", "第三"]})
        self.assertIn("en_groups", bad["errors"][0])

    def test_en_starts_recut_lines_that_are_not_sentences(self):
        en, zh = "Dear Sir\nPlease reply", "尊敬的先生\n请回复"
        result = run({"en_starts": ["Dear", "Please"], "zh_starts": ["尊敬", "请回"]}, article(en=en, zh=zh))
        self.assertEqual([p["en"] for p in result["articles"][0]["sentences"]], ["Dear Sir", "Please reply"])
        self.assertEqual([p["zh"] for p in result["articles"][0]["sentences"]], ["尊敬的先生", "请回复"])
        self.assertTrue(result["complete"])

    def test_newline_blocks_need_a_decision(self):
        self.assertTrue(sa.segment_needs_decision("Yours sincerely\nJames Bush", "您真诚的，\n詹姆斯"))

    def test_review_fix_applies_to_single_pairs_and_decided_pieces_and_is_logged(self):
        articles = [{"title": "T", "sentences": [{"en": "One sentence.", "zh": "一句话。"}, {"en": EN, "zh": ZH}]}]
        decisions = {(1, 2): {"article": 1, "segment": 2, "ok": True}}
        fixes = {
            (1, 1): [{"piece": 0, "text": "一个句子。", "why": "复核"}],
            (1, 2): [{"piece": 1, "text": "第二个想法接着出现。", "why": "复核"}],
        }
        result = sa.assemble(articles, decisions, fixes)
        self.assertTrue(result["complete"])
        zhs = [p["zh"] for p in result["articles"][0]["sentences"]]
        self.assertEqual(zhs[0], "一个句子。")
        self.assertEqual(zhs[2], "第二个想法接着出现。")
        self.assertEqual({(c["segment"], c["original"]) for c in result["corrections"]},
                         {(1, "一句话。"), (2, "第二个想法随后。")})

    def test_review_fix_cannot_repeat_a_correction_or_miss_its_target(self):
        decisions = {(1, 1): {"article": 1, "segment": 1, "ok": True,
                              "zh_fixed": {"0": {"text": "新的第一句。", "why": "x"}}}}
        repeat = sa.assemble(article(), decisions, {(1, 1): [{"piece": 0, "text": "又改。", "why": "y"}]})
        self.assertIn("repeats", repeat["errors"][0])
        stray = sa.assemble(article(), {(1, 1): {"article": 1, "segment": 1, "ok": True}},
                            {(5, 5): [{"piece": 0, "text": "无。", "why": "z"}]})
        self.assertIn("missing segment", stray["errors"][0])
        far = sa.assemble(article(), {(1, 1): {"article": 1, "segment": 1, "ok": True}},
                          {(1, 1): [{"piece": 9, "text": "无。", "why": "z"}]})
        self.assertIn("out of range", far["errors"][0])

    def test_undecided_segment_blocks_completion(self):
        result = sa.assemble(article(), {})
        self.assertEqual(result["undecided"], [(1, 1)])
        self.assertFalse(result["complete"])

    def test_stray_and_duplicate_decisions_are_caught(self):
        stray = sa.assemble(article(), {(1, 1): {"article": 1, "segment": 1, "ok": True}, (9, 9): {"ok": True}})
        self.assertFalse(stray["complete"])
        with tempfile.TemporaryDirectory() as folder:
            item = {"article": 1, "segment": 1, "ok": True}
            for name in ("group-1.json", "group-2.json"):
                Path(folder, name).write_text(json.dumps({"items": [item]}))
            with self.assertRaises(sa.DecisionError):
                sa.load_decisions(Path(folder))

    def test_single_pairs_and_fragments_need_no_decision(self):
        articles = [{"title": "T", "sentences": [
            {"en": "One sentence.", "zh": "一句话。"}, {"en": "-----", "zh": ""}]}]
        result = sa.assemble(articles, {})
        self.assertTrue(result["complete"])
        self.assertEqual(len(result["articles"][0]["sentences"]), 1)
        self.assertEqual(result["dropped_fragments"], [(1, 2)])

    def test_swapped_translations_are_not_caught_by_counts_alone(self):
        swapped = "第二个想法随后。第一个想法在这里。第三个想法结束它。"
        result = run({"ok": True}, article(zh=swapped))
        pairs = result["articles"][0]["sentences"]
        self.assertEqual(pairs[0]["zh"], "第二个想法随后。")


class RealDataTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.articles = json.loads((sa.HERE / "articles-text.json").read_text(encoding="utf-8"))["articles"]

    def test_worksheets_cover_every_review_segment(self):
        covered = 0
        for group in range(1, 9):
            covered += sum(1 for line in sa.build_worksheet(self.articles, group).splitlines() if line.startswith("--- "))
        expected = sum(
            1 for a in self.articles for s in a["sentences"]
            if s["zh"] and sa.segment_needs_decision(s["en"], s["zh"])
        )
        self.assertEqual(covered, expected)
        self.assertGreater(expected, 628)

    def test_ok_decision_for_every_equal_count_segment_preserves_all_text(self):
        decisions = {}
        for a, article_ in enumerate(self.articles, start=1):
            for s, sentence in enumerate(article_["sentences"], start=1):
                en, zh = sentence["en"], sentence["zh"]
                if zh and sa.segment_needs_decision(en, zh) and len(sa.split_english_sentences(en)) == len(sa.split_chinese_sentences(zh)):
                    decisions[(a, s)] = {"article": a, "segment": s, "ok": True}
        result = sa.assemble(self.articles, decisions)
        self.assertEqual(result["errors"], [])
        expected = sum(1 for a in self.articles for s in a["sentences"] if s["zh"] and sa.segment_needs_decision(s["en"], s["zh"]))
        self.assertEqual(len(result["undecided"]), expected - len(decisions))


if __name__ == "__main__":
    unittest.main()
