import copy
import csv
import hashlib
import json
import unittest
from pathlib import Path

import prepare_text


OUTPUT_DIR = Path(__file__).resolve().parent
SOURCE = OUTPUT_DIR.parent / "128.txt"
JSON_PATH = OUTPUT_DIR / "articles-text.json"
ALIGNMENT_PATH = OUTPUT_DIR / "alignment.tsv"


def source_lines_by_number():
    return {
        number: line.strip()
        for number, line in enumerate(
            SOURCE.read_text(encoding="utf-8").splitlines(), start=1
        )
    }


def parse_line_list(value):
    return [int(number) for number in value.split(",") if number]


class PreparedTextTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.payload = json.loads(JSON_PATH.read_text(encoding="utf-8"))
        with ALIGNMENT_PATH.open(encoding="utf-8", newline="") as source:
            cls.rows = list(csv.DictReader(source, delimiter="\t"))

    def test_article_count_and_original_course_order(self):
        articles = self.payload["articles"]
        expected = []
        for base in ("人文英语", "管理英语", "理工英语", "商务英语"):
            expected.extend((f"{base}3", passage) for passage in range(1, 17))
            expected.extend((f"{base}4", passage) for passage in range(17, 33))
        self.assertEqual(len(articles), 128)
        self.assertEqual(
            [(article["course"], article["passage"]) for article in articles],
            expected,
        )
        self.assertEqual(
            len({article["title"] for article in articles}),
            128,
        )

    def test_source_hash_matches_the_actual_input(self):
        actual = hashlib.sha256(SOURCE.read_bytes()).hexdigest()
        self.assertEqual(self.payload["source_sha256"], actual)
        self.assertTrue(all(row["source_sha256"] == actual for row in self.rows))

    def test_every_source_content_line_is_accounted_for_and_preserved(self):
        source = source_lines_by_number()
        articles = self.payload["articles"]
        rows_by_article = {}
        for row in self.rows:
            rows_by_article.setdefault(int(row["article_index"]), []).append(row)

        assigned = {}
        permitted_removals = {}
        for article_index, rows in rows_by_article.items():
            article = articles[article_index - 1]
            for row in rows:
                row_type = row["row_type"]
                if row_type == "title":
                    title = article["title"]
                    for line_number in parse_line_list(row["title_source_lines"]):
                        self.assertIn(source[line_number], title)
                        assigned[line_number] = "title"
                elif row_type == "documented_duplicate_removed":
                    line_number = parse_line_list(row["en_source_lines"])[0]
                    permitted_removals[line_number] = row["note"]
                elif row_type == "segment":
                    segment = article["sentences"][int(row["segment_index"]) - 1]
                    for language, key in (("en", "en_source_lines"), ("zh", "zh_source_lines")):
                        line_numbers = parse_line_list(row[key])
                        expected = "\n".join(source[number] for number in line_numbers)
                        self.assertEqual(segment[language], expected)
                        for line_number in line_numbers:
                            self.assertNotIn(line_number, assigned)
                            assigned[line_number] = f"segment:{language}"

        expected_content = {
            number
            for number, text in source.items()
            if text
            and not prepare_text.COURSE_RE.fullmatch(text)
            and not prepare_text.PASSAGE_RE.fullmatch(text)
        }
        self.assertEqual(
            set(assigned) | set(permitted_removals),
            expected_content,
        )
        self.assertEqual(set(assigned) & set(permitted_removals), set())
        self.assertEqual(
            set(permitted_removals),
            {30},
        )
        self.assertIn("Exact repeated subheading", permitted_removals[30])

    def test_known_abbreviations_do_not_create_false_sentences(self):
        text = (
            "The U.S. Census Bureau lists A. Smith, e.g. as an example. "
            "It also compares 36% vs. 27%."
        )
        sentences = prepare_text.split_english_sentences(text)
        self.assertEqual(
            sentences,
            [
                "The U.S. Census Bureau lists A. Smith, e.g. as an example.",
                "It also compares 36% vs. 27%.",
            ],
        )

    def test_single_sentence_pairs_have_manual_semantic_review_notes(self):
        rows = [
            row
            for row in self.rows
            if row["row_type"] == "segment"
            and row["alignment_mode"] == "single_sentence_pair"
        ]
        self.assertEqual(len(rows), 195)
        self.assertTrue(
            all("semantic match manually reviewed" in row["note"] for row in rows)
        )

    def test_only_documented_dividers_remain_unpaired(self):
        rows = [
            row
            for row in self.rows
            if row["row_type"] == "segment"
            and row["alignment_mode"] == "unpaired_fragment"
        ]
        self.assertEqual(
            [row["en_source_lines"] for row in rows],
            ["240", "567", "1200", "1472", "1765", "2010"],
        )
        self.assertTrue(
            all("Non-linguistic source fragment preserved" in row["note"] for row in rows)
        )

    def test_source_spelling_anomalies_are_preserved_and_logged(self):
        expected = {
            "1497": ("Kuo ,", "1498"),
            "1598": ("visuallyimpaired", "1599"),
            "1608": ("themultisensory", "1609"),
            "1711": ("Doug Gu rian-Sherman", "1712"),
        }
        source = source_lines_by_number()
        for line_number, (fragment, paired_line) in expected.items():
            row = next(
                row
                for row in self.rows
                if row["row_type"] == "segment"
                and int(line_number) in parse_line_list(row["en_source_lines"])
            )
            article = self.payload["articles"][int(row["article_index"]) - 1]
            segment = article["sentences"][int(row["segment_index"]) - 1]
            self.assertIn(fragment, segment["en"])
            self.assertIn(int(paired_line), parse_line_list(row["zh_source_lines"]))
            self.assertIn("Source anomaly", row["note"])
            self.assertIn(source[int(line_number)], segment["en"])

    def test_mismatched_sentence_counts_remain_one_paragraph_segment(self):
        article = self.payload["articles"][0]
        rows = [
            row
            for row in self.rows
            if row["article_index"] == "1" and row["row_type"] == "segment"
        ]
        target = next(
            row
            for row in rows
            if row["en_source_lines"] == "10" and row["zh_source_lines"] == "11"
        )
        segment = article["sentences"][int(target["segment_index"]) - 1]
        self.assertEqual(len(article["sentences"]), len(rows))
        self.assertEqual(target["en_sentence_count"], "3")
        self.assertEqual(target["zh_sentence_count"], "4")
        self.assertEqual(target["alignment_mode"], "paragraph_group")
        self.assertIn("sentence counts differ", target["note"])
        self.assertEqual(
            segment["en"],
            prepare_text.SourceLine(10, source_lines_by_number()[10]).text,
        )
        self.assertEqual(
            segment["zh"],
            prepare_text.SourceLine(11, source_lines_by_number()[11]).text,
        )

    def test_coverage_check_detects_mutated_text(self):
        articles = copy.deepcopy(self.payload["articles"])
        articles[0]["sentences"][0]["en"] = "Silently mutated source text."
        source = source_lines_by_number()
        rows = [
            row
            for row in self.rows
            if row["row_type"] in ("title", "segment", "documented_duplicate_removed")
        ]
        errors = prepare_text.validate_coverage(source, articles, rows)
        self.assertTrue(any("source text mismatch" in error for error in errors))


if __name__ == "__main__":
    unittest.main()
