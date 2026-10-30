import argparse
import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/sync_article_vocabulary.py"
spec = importlib.util.spec_from_file_location("vocabulary", SCRIPT)
vocabulary = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vocabulary)


class ArticleVocabularyTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.root = Path(self.folder.name)
        for name, value in {
            "VOCAB": self.root,
            "ARTICLES": self.root / "articles.json",
            "LIBRARY": self.root / "library.json",
            "ENTRIES": self.root / "entries.json",
            "REPORT": self.root / "report.json",
        }.items():
            patcher = patch.object(vocabulary, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.articles = [{
            "title": "英语 | Passage 1 | Fresh / 新鲜的",
            "sentences": [{"en": "Hello families. You're testing.", "zh": "家庭，你们正在测试。"}],
        } for _ in range(128)]
        vocabulary.ARTICLES.write_text(json.dumps({"articles": self.articles}))
        self.original = [{"term": "hello", "meaning": "你好", "categories": [], "examples": []}]
        self.library = {"schemaVersion": 1, "categories": [], "words": self.original.copy()}
        self.manifest = {
            "originalWordCount": 1,
            "originalWordsSha256": vocabulary.word_hash(self.original),
            "articlesSha256": hashlib.sha256(vocabulary.ARTICLES.read_bytes()).hexdigest(),
            "lexicalMissing": 4,
            "bodyLexicalMissing": 3,
            "titleAdditionalMissing": ["fresh"],
            "uiAdditionalFragments": [],
            "entries": [{
                "term": term, "meaning": "测试释义", "phonetics": ["/test/"],
                "firstOccurrence": [0, -1 if term == "fresh" else 0],
                "uiFragment": False,
            } for term in ["families", "fresh", "testing", "you're"]],
        }
        self.save()

    def save(self):
        vocabulary.LIBRARY.write_text(json.dumps(self.library))
        vocabulary.ENTRIES.write_text(json.dumps(self.manifest))

    def test_scans_full_forms_and_actual_curly_apostrophe_fragments(self):
        articles = [{"title": "英语 | Passage 1 | Children / 孩子", "sentences": [
            {"en": "You’re testing children's words.", "zh": "你在测试孩子们的词语。"}
        ]}]
        lexical, ui, _ = vocabulary.scan(articles)
        self.assertIn("you're", lexical)
        self.assertNotIn("re", lexical)
        self.assertIn("you", ui)
        self.assertIn("re", ui)
        self.assertIn("children's", lexical)
        self.assertIn("children", lexical)
        self.assertNotIn("passage", lexical)

    def test_accepts_complete_entry_manifest(self):
        self.assertEqual(len(vocabulary.load_inputs()[0]["entries"]), 4)

    def test_rejects_missing_entry(self):
        self.manifest["entries"].pop()
        self.save()
        with self.assertRaisesRegex(ValueError, "Entry coverage mismatch"):
            vocabulary.load_inputs()

    def test_rejects_swapped_term_with_unchanged_total(self):
        self.manifest["entries"][0]["term"] = "unrelated"
        self.save()
        with self.assertRaisesRegex(ValueError, "Entry coverage mismatch"):
            vocabulary.load_inputs()

    def test_rejects_modified_original_word(self):
        self.library["words"][0]["meaning"] = "改写"
        self.save()
        with self.assertRaisesRegex(ValueError, "Original vocabulary records changed"):
            vocabulary.load_inputs()

    def test_rejects_changed_articles(self):
        vocabulary.ARTICLES.write_text("{}")
        with self.assertRaisesRegex(ValueError, "Article content changed"):
            vocabulary.load_inputs()

    def test_rejects_incomplete_ipa(self):
        self.manifest["entries"][0]["phonetics"] = []
        self.save()
        with self.assertRaisesRegex(ValueError, "Incomplete meaning or phonetics"):
            vocabulary.load_inputs()

    def test_rejects_meaning_without_chinese(self):
        self.manifest["entries"][0]["meaning"] = "English only"
        self.save()
        with self.assertRaisesRegex(ValueError, "Incomplete meaning or phonetics"):
            vocabulary.load_inputs()

    def test_examples_keep_original_bilingual_text(self):
        words = vocabulary.expected_words(self.manifest, self.articles)
        self.assertEqual(words[0]["examples"][0]["en"], self.articles[0]["sentences"][0]["en"])
        self.assertEqual(words[0]["examples"][0]["zh"], self.articles[0]["sentences"][0]["zh"])
        self.assertEqual(words[1]["examples"][0]["en"], "Fresh")
        self.assertEqual(words[1]["examples"][0]["zh"], "新鲜的")

    def test_rejects_wrong_example_assignment(self):
        self.manifest["entries"][0]["firstOccurrence"] = [0, -1]
        with self.assertRaisesRegex(ValueError, "Example does not contain families"):
            vocabulary.expected_words(self.manifest, self.articles)

    def test_rejects_missing_audio_before_reporting_success(self):
        self.library["categories"] = [vocabulary.CATEGORY]
        self.library["words"] += vocabulary.expected_words(self.manifest, self.articles)
        self.save()
        with self.assertRaisesRegex(ValueError, "Missing or empty audio"):
            vocabulary.verify(argparse.Namespace(decode_audio=False, jobs=1))
        self.assertFalse(vocabulary.REPORT.exists())

    def test_rejects_audio_path_escape(self):
        with self.assertRaisesRegex(ValueError, "Invalid audio reference"):
            vocabulary.check_audio_path("../outside.mp3")


if __name__ == "__main__":
    unittest.main()
