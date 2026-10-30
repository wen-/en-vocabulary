import importlib.util
import sys
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/vocabulary_meanings.py"
spec = importlib.util.spec_from_file_location("meanings", SCRIPT)
meanings = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = meanings
spec.loader.exec_module(meanings)


class MeaningCleanupTests(unittest.TestCase):
    def test_removes_repeated_sense(self):
        self.assertEqual(meanings.deduplicate_meaning("v. 积累；堆积；积累；积聚")[0], "v. 积累；堆积；积聚")

    def test_removes_repeated_comma_list(self):
        self.assertEqual(meanings.deduplicate_meaning("v. 改变；更改；改动；改变，更改")[0], "v. 改变；更改；改动")

    def test_preserves_different_parts_of_speech(self):
        text = "n. 工作；劳动 vi. 工作；起作用"
        self.assertEqual(meanings.deduplicate_meaning(text), (text, []))

    def test_prefers_explicit_grammatical_label(self):
        self.assertEqual(meanings.deduplicate_meaning("呼吁；v. 呼吁；请求")[0], "v. 呼吁；请求")

    def test_preserves_parentheses_and_quoted_explanations(self):
        text = "v. 处理（数量，质量）；表示“甲，乙；甲”；处理（数量，质量）"
        self.assertEqual(meanings.deduplicate_meaning(text)[0], "v. 处理（数量，质量）；表示“甲，乙；甲”")

    def test_preserves_distinct_domains(self):
        text = "n. 组织；[医] 组织；[计] 组织"
        self.assertEqual(meanings.deduplicate_meaning(text), (text, []))

    def test_preserves_label_when_first_sense_removed(self):
        self.assertEqual(meanings.deduplicate_meaning("n. 地址；演说；n. 地址；称呼")[0], "n. 地址；演说；n. 称呼")

    def test_recognizes_combined_labels(self):
        self.assertEqual(meanings.deduplicate_meaning("n./v. 测试；检验；n./v. 测试，测验；检验，试验")[0], "n./v. 测试；检验；n./v. 测验，试验")

    def test_recognizes_adjective_alias(self):
        self.assertEqual(meanings.deduplicate_meaning("adj. 巨大的；庞大的；a. 巨大的，极大的，庞大的")[0], "adj. 巨大的；庞大的；a. 极大的")

    def test_keeps_ampersand_combined_pos_intact(self):
        self.assertEqual(meanings.deduplicate_meaning("vi. & vt. 集中；聚焦；集中")[0], "vi. & vt. 集中；聚焦")
        self.assertEqual(meanings.deduplicate_meaning("v.& n. 估计；估量；v./n. 估计；评价")[0], "v.& n. 估计；估量；v./n. 评价")

    def test_keeps_qualifiers_and_different_senses(self):
        text = "v. 增加；（数量）增加；增多；增加收入"
        self.assertEqual(meanings.deduplicate_meaning(text), (text, []))

    def test_does_not_change_other_word_fields(self):
        library = {"words": [{"term": "word", "meaning": "n. 词；词", "audio": "original.mp3", "isFavorite": True}]}
        meanings.clean_library(library)
        self.assertEqual(library["words"][0], {"term": "word", "meaning": "n. 词", "audio": "original.mp3", "isFavorite": True})

    def test_idempotence(self):
        once = meanings.deduplicate_meaning("词；n. 词；词；n. 词，单词")[0]
        self.assertEqual(meanings.deduplicate_meaning(once), (once, []))


if __name__ == "__main__":
    unittest.main()
