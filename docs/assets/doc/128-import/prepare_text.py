#!/usr/bin/env python3
"""Prepare provenance-backed bilingual article text from the source document."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable


HERE = Path(__file__).resolve().parent
DEFAULT_SOURCE = HERE.parent / "128.txt"
DEFAULT_OUTPUT = HERE

COURSE_RE = re.compile(r"^(人文英语|管理英语|理工英语|商务英语)[34]$")
PASSAGE_RE = re.compile(r"^Passage\s+(\d+)$")
CJK_RE = re.compile(r"[\u3400-\u9fff]")
LATIN_RE = re.compile(r"[A-Za-z]")
NUMBERED_OR_TABLE_RE = re.compile(r"^[\d\s.,$%/()\-+\t]+$")
DECORATIVE_RE = re.compile(r"^[\-\u2010-\u2015_=·•]+$")
ENGLISH_ABBREVIATIONS = (
    "a.m.", "p.m.", "e.g.", "i.e.", "u.s.", "u.k.", "u.n.", "vs.",
    "mr.", "mrs.", "ms.", "dr.", "prof.", "inc.", "ltd.",
)

DUPLICATE_STRAY_HEADINGS = {
    30: {
        "course": "人文英语3",
        "passage": 3,
        "text": "Establish a routine.",
        "repeated_at": 32,
        "translation_at": 33,
        "reason": (
            "Exact repeated subheading. The later occurrence at line 32 is "
            "immediately paired with its Chinese heading at line 33."
        ),
    }
}
SOURCE_TEXT_ANOMALIES = {
    1497: {
        "fragment": "Kuo ,",
        "paired_line": 1498,
        "note": "The source has a space before a comma. The original punctuation is retained.",
    },
    1598: {
        "fragment": "visuallyimpaired",
        "paired_line": 1599,
        "note": "The source joins 'visually' and 'impaired'. The original spelling is retained.",
    },
    1608: {
        "fragment": "themultisensory",
        "paired_line": 1609,
        "note": "The source joins 'the' and 'multisensory'. The original spelling is retained.",
    },
    1711: {
        "fragment": "Doug Gu rian-Sherman",
        "paired_line": 1712,
        "note": (
            "The source splits the proper name 'Gurian-Sherman'. The Chinese "
            "parallel gives 'Gurian-Sherman'. The original spelling is retained."
        ),
    },
}


@dataclass(frozen=True)
class SourceLine:
    number: int
    raw: str

    @property
    def text(self) -> str:
        return self.raw.strip()


@dataclass
class ArticleSource:
    course: str
    passage: int
    marker_line: int
    lines: list[SourceLine] = field(default_factory=list)


@dataclass
class Block:
    language: str
    lines: list[SourceLine]
    note: str = ""

    @property
    def text(self) -> str:
        return "\n".join(line.text for line in self.lines)

    @property
    def line_numbers(self) -> list[int]:
        return [line.number for line in self.lines]


def classify_line(text: str) -> str:
    if CJK_RE.search(text):
        return "zh"
    if LATIN_RE.search(text):
        return "en"
    if DECORATIVE_RE.fullmatch(text):
        return "special"
    if NUMBERED_OR_TABLE_RE.fullmatch(text):
        return "data"
    return "special"


def split_english_sentences(text: str) -> list[str]:
    """Split at sentence punctuation without treating common abbreviations as stops."""
    starts: list[int] = []
    i = 0
    while i < len(text):
        if text[i] not in ".!?":
            i += 1
            continue

        punctuation_end = i + 1
        while punctuation_end < len(text) and text[punctuation_end] in ".!?":
            punctuation_end += 1
        while punctuation_end < len(text) and text[punctuation_end] in "\"'”’)]}":
            punctuation_end += 1

        if punctuation_end < len(text) and not text[punctuation_end].isspace():
            i = punctuation_end
            continue

        if text[i] == "." and _period_is_abbreviation(text, i):
            i += 1
            continue

        if punctuation_end == len(text) or text[punctuation_end].isspace():
            starts.append(punctuation_end)
        i = punctuation_end

    return _split_at_boundaries(text, starts)


def _period_is_abbreviation(text: str, period_index: int) -> bool:
    prefix = text[: period_index + 1].lower()
    if any(prefix.endswith(abbreviation) for abbreviation in ENGLISH_ABBREVIATIONS):
        return True

    token_start = max(prefix.rfind(" "), prefix.rfind("\n"), prefix.rfind("\t")) + 1
    token = prefix[token_start:]
    if re.fullmatch(r"[a-z]\.", token):
        return True
    if re.search(r"\d\.\d$", prefix):
        return True
    return False


def split_chinese_sentences(text: str) -> list[str]:
    boundaries = []
    i = 0
    while i < len(text):
        if text[i] in "。！？":
            end = i + 1
            while end < len(text) and text[end] in "”’\"'）】》":
                end += 1
            boundaries.append(end)
            i = end
        else:
            i += 1
    return _split_at_boundaries(text, boundaries)


def _split_at_boundaries(text: str, boundaries: Iterable[int]) -> list[str]:
    pieces: list[str] = []
    start = 0
    for boundary in boundaries:
        piece = text[start:boundary].strip()
        if piece:
            pieces.append(piece)
        start = boundary
        while start < len(text) and text[start].isspace():
            start += 1
    tail = text[start:].strip()
    if tail:
        pieces.append(tail)
    return pieces


def parse_source_lines(lines: list[str]) -> list[ArticleSource]:
    articles: list[ArticleSource] = []
    course: str | None = None
    current: ArticleSource | None = None

    def finish() -> None:
        nonlocal current
        if current is not None:
            articles.append(current)
            current = None

    for number, raw in enumerate(lines, start=1):
        text = raw.strip()
        if COURSE_RE.fullmatch(text):
            finish()
            course = text
            continue

        passage_match = PASSAGE_RE.fullmatch(text)
        if passage_match:
            finish()
            if course is None:
                raise ValueError(f"Passage marker without a course at line {number}")
            current = ArticleSource(course, int(passage_match.group(1)), number)
            continue

        if current is not None:
            current.lines.append(SourceLine(number, raw))

    finish()
    return articles


def _clean_title_line(line: SourceLine) -> str:
    return line.text


def _take_title(article: ArticleSource) -> tuple[list[SourceLine], list[SourceLine]]:
    content = [line for line in article.lines if line.text]
    if not content:
        raise ValueError(
            f"No title or body for {article.course} Passage {article.passage}"
        )

    title_lines = [content[0]]
    if (
        classify_line(content[0].text) == "en"
        and len(content) > 1
        and classify_line(content[1].text) == "zh"
    ):
        title_lines.append(content[1])
    title_numbers = {line.number for line in title_lines}
    body = [line for line in article.lines if line.number not in title_numbers]
    return title_lines, body


def _blocks_for_body(
    article: ArticleSource, body: list[SourceLine]
) -> tuple[list[Block], list[dict[str, object]]]:
    blocks: list[Block] = []
    removed: list[dict[str, object]] = []
    active: Block | None = None

    def flush() -> None:
        nonlocal active
        if active is not None:
            blocks.append(active)
            active = None

    overrides = {
        line_number: override
        for line_number, override in DUPLICATE_STRAY_HEADINGS.items()
        if override["course"] == article.course
        and override["passage"] == article.passage
    }
    source_by_number = {line.number: line for line in article.lines}
    for line_number, override in overrides.items():
        repeated = source_by_number.get(override["repeated_at"])
        translated = source_by_number.get(override["translation_at"])
        original = source_by_number.get(line_number)
        if (
            original is None
            or original.text != override["text"]
            or repeated is None
            or repeated.text != override["text"]
            or translated is None
            or classify_line(translated.text) != "zh"
        ):
            raise ValueError(f"Duplicate-heading override no longer matches line {line_number}")

    for line in body:
        if not line.text:
            continue
        if line.number in overrides:
            flush()
            override = overrides[line.number]
            removed.append(
                {
                    "line": line.number,
                    "text": line.text,
                    "note": override["reason"],
                }
            )
            continue

        language = classify_line(line.text)
        if language in ("en", "zh"):
            if active is None or active.language != language:
                flush()
                active = Block(language, [])
            active.lines.append(line)
        elif language == "data":
            if active is None:
                blocks.append(
                    Block(
                        "special",
                        [line],
                        "Unlabelled numeric or table fragment has no adjacent language block.",
                    )
                )
            else:
                active.lines.append(line)
        else:
            flush()
            blocks.append(
                Block("special", [line], "Non-linguistic source fragment preserved.")
            )

    flush()
    return blocks, removed


def _segment_note(en: str, zh: str, mode: str) -> tuple[int, int, str]:
    en_count = len(split_english_sentences(en))
    zh_count = len(split_chinese_sentences(zh))
    notes: list[str] = []

    if "\t" in en or "\t" in zh:
        notes.append("Tabular content kept intact.")
    if mode == "single_sentence_pair":
        notes.append("One sentence per language; semantic match manually reviewed.")
    if en_count > 1 or zh_count > 1:
        if en_count == zh_count:
            notes.append(
                "Paragraph kept intact. Equal sentence counts do not certify "
                "sentence-level semantic alignment; review before splitting."
            )
        else:
            notes.append(
                "Paragraph kept intact because sentence counts differ. "
                "Review before sentence-level alignment."
            )
    elif en_count != zh_count:
        notes.append(
            "Heading or fragment kept intact. No sentence-level alignment claimed."
        )
    elif mode == "paragraph_group":
        notes.append(
            "Structural or multi-line block kept intact. "
            "Sentence-level semantic alignment is not claimed."
        )
    elif mode == "unpaired":
        notes.append("Source block has no safely paired translation.")
    return en_count, zh_count, " ".join(notes)


def prepare(source: Path, output_dir: Path) -> dict[str, object]:
    source_bytes = source.read_bytes()
    source_hash = hashlib.sha256(source_bytes).hexdigest()
    source_lines = source_bytes.decode("utf-8").splitlines()
    parsed_articles = parse_source_lines(source_lines)
    if len(parsed_articles) != 128:
        raise ValueError(f"Expected 128 Passage articles, found {len(parsed_articles)}")

    article_data: list[dict[str, object]] = []
    alignment_rows: list[dict[str, object]] = []
    group_count = 0
    segment_count = 0
    unpaired_count = 0
    issues: list[str] = []
    seen_titles: dict[str, tuple[str, int, list[int]]] = {}
    seen_source_anomalies: set[int] = set()
    source_by_number = {
        number: line.strip() for number, line in enumerate(source_lines, start=1)
    }
    for line_number, anomaly in SOURCE_TEXT_ANOMALIES.items():
        if (
            anomaly["fragment"] not in source_by_number.get(line_number, "")
            or not source_by_number.get(int(anomaly["paired_line"]), "")
        ):
            raise ValueError(f"Source-text anomaly override no longer matches line {line_number}")

    for article_index, source_article in enumerate(parsed_articles, start=1):
        title_lines, body = _take_title(source_article)
        title_parts = [_clean_title_line(line) for line in title_lines]
        bilingual_title = " / ".join(title_parts)
        full_title = (
            f"{source_article.course} | Passage {source_article.passage} | "
            f"{bilingual_title}"
        )
        previous_title = seen_titles.get(bilingual_title)
        if previous_title is not None:
            previous_course, previous_passage, previous_lines = previous_title
            issues.append(
                f"Duplicate bilingual title at {source_article.course} Passage "
                f"{source_article.passage} lines {[line.number for line in title_lines]}; "
                f"first seen at {previous_course} Passage {previous_passage} "
                f"lines {previous_lines}"
            )
        else:
            seen_titles[bilingual_title] = (
                source_article.course,
                source_article.passage,
                [line.number for line in title_lines],
            )
        article_end = max(
            [source_article.marker_line]
            + [line.number for line in source_article.lines if line.text]
        )

        article_data.append(
            {
                "title": full_title,
                "course": source_article.course,
                "passage": source_article.passage,
                "source_line_range": [
                    source_article.marker_line,
                    article_end,
                ],
                "title_source_lines": [line.number for line in title_lines],
                "sentences": [],
            }
        )
        alignment_rows.append(
            _alignment_row(
                source_hash,
                article_index,
                source_article,
                full_title,
                article_end,
                0,
                "title",
                "",
                [line.number for line in title_lines],
                [],
                0,
                0,
                "Bilingual title retained as source text.",
            )
        )

        blocks, removed = _blocks_for_body(source_article, body)
        for item in removed:
            alignment_rows.append(
                _alignment_row(
                    source_hash,
                    article_index,
                    source_article,
                    full_title,
                    article_end,
                    0,
                    "documented_duplicate_removed",
                    "",
                    [int(item["line"])],
                    [],
                    0,
                    0,
                    str(item["note"]),
                )
            )

        paired_units: list[tuple[Block | None, Block | None, Block | None]] = []
        language_blocks = [block for block in blocks if block.language in ("en", "zh")]
        special_blocks = [block for block in blocks if block.language == "special"]

        position = 0
        while position < len(language_blocks):
            first = language_blocks[position]
            second = (
                language_blocks[position + 1]
                if position + 1 < len(language_blocks)
                else None
            )
            if second is not None and first.language != second.language:
                en_block = first if first.language == "en" else second
                zh_block = first if first.language == "zh" else second
                paired_units.append((en_block, zh_block, None))
                position += 2
            else:
                paired_units.append(
                    (first if first.language == "en" else None,
                     first if first.language == "zh" else None,
                     None)
                )
                position += 1

        paired_units.extend((None, None, block) for block in special_blocks)
        paired_units.sort(
            key=lambda unit: min(
                block.line_numbers[0]
                for block in unit
                if block is not None and block.line_numbers
            )
        )

        for segment_index, (en_block, zh_block, special_block) in enumerate(
            paired_units, start=1
        ):
            en = en_block.text if en_block else ""
            zh = zh_block.text if zh_block else ""
            if special_block is not None:
                en = special_block.text
                zh = ""
                mode = "unpaired_fragment"
                note = special_block.note
                en_count = 0
                zh_count = 0
                unpaired_count += 1
                issues.append(
                    f"{source_article.course} Passage {source_article.passage} "
                    f"lines {special_block.line_numbers}: {special_block.note}"
                )
            elif en_block is None or zh_block is None:
                mode = "unpaired"
                en_count, zh_count, note = _segment_note(en, zh, mode)
                if en_count == 0 and zh_count == 0:
                    note = f"{note} Non-sentence source fragment retained."
                unpaired_count += 1
                issue_lines = (
                    en_block.line_numbers if en_block else zh_block.line_numbers
                )
                issues.append(
                    f"{source_article.course} Passage {source_article.passage} "
                    f"lines {issue_lines}: unpaired {('English' if en_block else 'Chinese')} block"
                )
            else:
                en_count = len(split_english_sentences(en))
                zh_count = len(split_chinese_sentences(zh))
                is_single_sentence_pair = (
                    en_count == 1
                    and zh_count == 1
                    and len(en_block.lines) == 1
                    and len(zh_block.lines) == 1
                    and "\t" not in en
                    and "\t" not in zh
                )
                mode = (
                    "single_sentence_pair"
                    if is_single_sentence_pair
                    else "paragraph_group"
                )
                en_count, zh_count, note = _segment_note(en, zh, mode)
                if mode == "paragraph_group" and (en_count > 1 or zh_count > 1):
                    group_count += 1
                if en_count != zh_count:
                    issues.append(
                        f"{source_article.course} Passage {source_article.passage} "
                        f"lines EN {en_block.line_numbers} / ZH {zh_block.line_numbers}: "
                        f"sentence counts {en_count}/{zh_count}; kept as paragraph"
                    )
                elif en_count > 1:
                    issues.append(
                        f"{source_article.course} Passage {source_article.passage} "
                        f"lines EN {en_block.line_numbers} / ZH {zh_block.line_numbers}: "
                        "equal multi-sentence counts retained as paragraph; semantics "
                        "not certified"
                    )
                elif "\t" in en or "\t" in zh:
                    issues.append(
                        f"{source_article.course} Passage {source_article.passage} "
                        f"lines EN {en_block.line_numbers} / ZH {zh_block.line_numbers}: "
                        "tabular block retained"
                    )
                elif mode == "paragraph_group" and en_count <= 1 and zh_count <= 1:
                    issues.append(
                        f"{source_article.course} Passage {source_article.passage} "
                        f"lines EN {en_block.line_numbers} / ZH {zh_block.line_numbers}: "
                        "structural or multi-line block retained; semantics not certified"
                    )

            article_data[-1]["sentences"].append({"en": en, "zh": zh})
            source_refs = set(
                (en_block.line_numbers if en_block else [])
                + (zh_block.line_numbers if zh_block else [])
            )
            for line_number, anomaly in SOURCE_TEXT_ANOMALIES.items():
                if line_number not in source_refs:
                    continue
                paired_line = int(anomaly["paired_line"])
                if paired_line not in source_refs:
                    raise ValueError(
                        f"Source-text anomaly at line {line_number} is not paired "
                        f"with expected line {paired_line}"
                    )
                note = f"{note} Source anomaly. {anomaly['note']}".strip()
                issues.append(
                    f"{source_article.course} Passage {source_article.passage} "
                    f"lines {line_number}-{paired_line}: {anomaly['note']}"
                )
                seen_source_anomalies.add(line_number)
            alignment_rows.append(
                _alignment_row(
                    source_hash,
                    article_index,
                    source_article,
                    full_title,
                    article_end,
                    segment_index,
                    "segment",
                    mode,
                    en_block.line_numbers if en_block else (
                        special_block.line_numbers if special_block else []
                    ),
                    zh_block.line_numbers if zh_block else [],
                    en_count,
                    zh_count,
                    note,
                )
            )
            segment_count += 1

        if not any(CJK_RE.search(part) for part in title_parts):
            issues.append(
                f"{source_article.course} Passage {source_article.passage} "
                f"title lines {[line.number for line in title_lines]}: no Chinese title text"
            )
        if not any(LATIN_RE.search(part) for part in title_parts):
            issues.append(
                f"{source_article.course} Passage {source_article.passage} "
                f"title lines {[line.number for line in title_lines]}: no English title text"
            )

    output_dir.mkdir(parents=True, exist_ok=True)
    if seen_source_anomalies != set(SOURCE_TEXT_ANOMALIES):
        missing = sorted(set(SOURCE_TEXT_ANOMALIES) - seen_source_anomalies)
        raise ValueError(f"Source-text anomaly lines were not aligned: {missing}")
    json_path = output_dir / "articles-text.json"
    tsv_path = output_dir / "alignment.tsv"
    report_path = output_dir / "preparation-report.txt"
    payload = {
        "source_file": source.name,
        "source_sha256": source_hash,
        "articles": article_data,
    }
    json_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    write_alignment(tsv_path, alignment_rows)
    report_path.write_text(
        "\n".join(
            [
                f"source_file\t{source.name}",
                f"source_sha256\t{source_hash}",
                f"articles\t{len(article_data)}",
                f"segments\t{segment_count}",
                f"grouped_multi_sentence_segments\t{group_count}",
                f"unpaired_or_nonlinguistic_segments\t{unpaired_count}",
                f"review_items\t{len(issues)}",
                "",
                *issues,
            ]
        )
        + "\n",
        encoding="utf-8",
    )
    return {
        "articles": len(article_data),
        "segments": segment_count,
        "grouped_multi_sentence_segments": group_count,
        "unpaired_or_nonlinguistic_segments": unpaired_count,
        "review_items": len(issues),
        "source_sha256": source_hash,
        "json_path": json_path,
        "tsv_path": tsv_path,
        "report_path": report_path,
    }


def _alignment_row(
    source_hash: str,
    article_index: int,
    article: ArticleSource,
    title: str,
    article_end: int,
    segment_index: int,
    row_type: str,
    alignment_mode: str,
    en_lines: list[int],
    zh_lines: list[int],
    en_count: int,
    zh_count: int,
    note: str,
) -> dict[str, object]:
    return {
        "source_sha256": source_hash,
        "article_index": article_index,
        "course": article.course,
        "passage": article.passage,
        "article_title": title,
        "article_line_range": f"{article.marker_line}-{article_end}",
        "segment_index": segment_index,
        "row_type": row_type,
        "alignment_mode": alignment_mode,
        "title_source_lines": (
            ",".join(map(str, en_lines)) if row_type == "title" else ""
        ),
        "en_source_lines": (
            ",".join(map(str, en_lines)) if row_type != "title" else ""
        ),
        "zh_source_lines": ",".join(map(str, zh_lines)),
        "en_sentence_count": en_count,
        "zh_sentence_count": zh_count,
        "note": note,
    }


def write_alignment(path: Path, rows: list[dict[str, object]]) -> None:
    fields = [
        "source_sha256",
        "article_index",
        "course",
        "passage",
        "article_title",
        "article_line_range",
        "segment_index",
        "row_type",
        "alignment_mode",
        "title_source_lines",
        "en_source_lines",
        "zh_source_lines",
        "en_sentence_count",
        "zh_sentence_count",
        "note",
    ]
    with path.open("w", encoding="utf-8", newline="") as output:
        writer = csv.DictWriter(output, fieldnames=fields, delimiter="\t")
        writer.writeheader()
        writer.writerows(rows)


def validate_coverage(
    source_by_number: dict[int, str],
    articles: list[dict[str, object]],
    rows: list[dict[str, str]],
) -> list[str]:
    errors: list[str] = []
    assigned: dict[int, str] = {}
    removed: dict[int, str] = {}

    for row in rows:
        article_index = int(row["article_index"])
        article = articles[article_index - 1]
        row_type = row["row_type"]
        if row_type == "title":
            for number in parse_line_numbers(row["title_source_lines"]):
                if source_by_number[number] not in str(article["title"]):
                    errors.append(f"source text mismatch at title line {number}")
                if number in assigned or number in removed:
                    errors.append(f"source line assigned more than once: {number}")
                assigned[number] = "title"
        elif row_type == "documented_duplicate_removed":
            numbers = parse_line_numbers(row["en_source_lines"])
            if len(numbers) != 1 or "Exact repeated subheading" not in row["note"]:
                errors.append(f"invalid documented removal at lines {numbers}")
                continue
            number = numbers[0]
            if number in assigned or number in removed:
                errors.append(f"source line assigned more than once: {number}")
            removed[number] = row["note"]
        elif row_type == "segment":
            segment = article["sentences"][int(row["segment_index"]) - 1]
            for language in ("en", "zh"):
                key = f"{language}_source_lines"
                numbers = parse_line_numbers(row[key])
                expected = "\n".join(source_by_number[number] for number in numbers)
                if segment[language] != expected:
                    errors.append(
                        f"source text mismatch in article {article_index} "
                        f"segment {row['segment_index']} {language}"
                    )
                for number in numbers:
                    if number in assigned or number in removed:
                        errors.append(f"source line assigned more than once: {number}")
                    assigned[number] = f"segment:{language}"
        else:
            errors.append(f"unknown alignment row type: {row_type}")

    expected_content = {
        number
        for number, text in source_by_number.items()
        if text
        and not COURSE_RE.fullmatch(text)
        and not PASSAGE_RE.fullmatch(text)
    }
    accounted_for = set(assigned) | set(removed)
    for number in sorted(expected_content - accounted_for):
        errors.append(f"unaccounted source line: {number}")
    for number in sorted(accounted_for - expected_content):
        errors.append(f"alignment references non-content line: {number}")
    return errors


def parse_line_numbers(value: str) -> list[int]:
    return [int(number) for number in value.split(",") if number]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args(argv)
    try:
        result = prepare(args.source, args.output_dir)
    except (OSError, UnicodeError, ValueError) as error:
        print(f"Preparation failed: {error}", file=sys.stderr)
        return 1

    print(
        f"Prepared {result['articles']} articles and {result['segments']} segments. "
        f"{result['grouped_multi_sentence_segments']} paragraph-grouped segments, "
        f"{result['unpaired_or_nonlinguistic_segments']} unpaired or non-linguistic "
        f"segments, and {result['review_items']} review items."
    )
    print(f"Source SHA-256: {result['source_sha256']}")
    print(f"JSON: {result['json_path']}")
    print(f"Alignment: {result['tsv_path']}")
    print(f"Report: {result['report_path']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
