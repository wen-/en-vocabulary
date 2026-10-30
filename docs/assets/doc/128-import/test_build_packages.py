import json
import tempfile
import unittest
import zipfile
from pathlib import Path

import build_packages as bp


class BuildPackageTests(unittest.TestCase):
    def test_speech_text_drops_bullets_and_collapses_whitespace(self):
        self.assertEqual(bp.speech_text("• their government,\n as part"), "their government, as part")
        self.assertEqual(bp.speech_text("Room size\tMonthly  rate"), "Room size Monthly rate")

    def test_cache_key_depends_on_voice_rate_and_text(self):
        base = bp.cache_key("Samantha", 165, "Hello.")
        self.assertEqual(base, bp.cache_key("Samantha", 165, "Hello."))
        self.assertNotEqual(base, bp.cache_key("Daniel", 165, "Hello."))
        self.assertNotEqual(base, bp.cache_key("Samantha", 150, "Hello."))
        self.assertNotEqual(base, bp.cache_key("Samantha", 165, "Hello!"))

    def test_articles_group_by_course_in_original_order(self):
        articles = [{"title": "甲3 | Passage 1 | A"}, {"title": "甲3 | Passage 2 | B"}, {"title": "乙4 | Passage 1 | C"}]
        groups = bp.group_by_course(articles)
        self.assertEqual(list(groups), ["甲3", "乙4"])
        self.assertEqual([index for index, _ in groups["甲3"]], [1, 2])

    def test_only_uncached_sentences_are_spoken_and_chinese_edits_cost_nothing(self):
        spoken = []

        def fake(text, voice, rate):
            spoken.append(text)
            return b"\xff\xfbaudio"

        with tempfile.TemporaryDirectory() as folder:
            cache = Path(folder)
            self.assertEqual(bp.ensure_audio(["One.", "Two.", "One."], cache, "V", 1, 2, fake), 2)
            self.assertEqual(bp.ensure_audio(["One.", "Three."], cache, "V", 1, 2, fake), 1)
            self.assertEqual(sorted(spoken), ["One.", "Three.", "Two."])

    def test_package_has_a_manifest_and_one_audio_file_per_sentence(self):
        articles = [(7, {"title": "T", "sentences": [{"en": "• First.", "zh": "第一。"}, {"en": "Second.", "zh": "第二。"}]})]
        with tempfile.TemporaryDirectory() as folder:
            cache = Path(folder)
            for text in ("First.", "Second."):
                (cache / f"{bp.cache_key('V', 1, text)}.mp3").write_bytes(b"\xff\xfb" + text.encode())
            manifest, files = bp.build_manifest(articles, cache, "V", 1)
            package = cache / "p.zip"
            bp.write_package(package, manifest, files)
            with zipfile.ZipFile(package) as archive:
                stored = json.loads(archive.read("articles.json"))
                self.assertEqual([s["audio"] for s in stored["articles"][0]["sentences"]],
                                 ["audio/a007-001.mp3", "audio/a007-002.mp3"])
                self.assertEqual(stored["articles"][0]["sentences"][0]["en"], "• First.")
                self.assertEqual(archive.read("audio/a007-001.mp3"), b"\xff\xfbFirst.")

    def test_missing_cached_audio_is_an_error_not_an_empty_package(self):
        articles = [(1, {"title": "T", "sentences": [{"en": "Gone.", "zh": "没了。"}]})]
        with tempfile.TemporaryDirectory() as folder:
            manifest, files = bp.build_manifest(articles, Path(folder), "V", 1)
            with self.assertRaises(FileNotFoundError):
                bp.write_package(Path(folder, "p.zip"), manifest, files)


if __name__ == "__main__":
    unittest.main()
