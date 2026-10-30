#!/usr/bin/env python3
"""Remove repeated Chinese senses without merging grammatical or domain contexts."""

import argparse
import csv
import json
import re
import unicodedata
from dataclasses import dataclass
from pathlib import Path

POS_NAME = r"(?:abbr|interj|conj|prep|pron|pref|adj|adv|aux|num|art|int|vt|vi|pl|na|ad|n|v|a)"
POS = re.compile(rf"(?<![A-Za-z]){POS_NAME}\.(?:\s*[/&和兼、]\s*{POS_NAME}\.)*")
ALIASES = {"a": "adj", "ad": "adv", "int": "interj"}
OPEN = {"(": ")", "（": "）", "[": "]", "【": "】", "“": "”", "‘": "’", '"': '"'}
SEPARATORS = "；;,，"
ROOT = Path(__file__).resolve().parents[1]


@dataclass
class Sense:
    text: str
    separator: str
    prefix: str
    part_of_speech: tuple[str, ...]
    domain: str
    section: int


def parse_senses(meaning):
    senses = []
    stack = []
    pos = ()
    domain = ""
    section = 0
    prefix = ""
    separator = ""
    start = 0
    index = 0

    def emit(end):
        nonlocal prefix, separator
        text = meaning[start:end].strip()
        if text:
            senses.append(Sense(text, separator, prefix, pos, domain, section))
            prefix = ""
            separator = ""

    while index < len(meaning):
        char = meaning[index]
        if stack:
            if char == stack[-1]:
                stack.pop()
            elif char in OPEN and char != '"':
                stack.append(OPEN[char])
            index += 1
            continue
        marker = POS.match(meaning, index)
        if marker and (index == 0 or meaning[index - 1].isspace() or meaning[index - 1] in SEPARATORS):
            emit(index)
            prefix = marker.group()
            pos = tuple(sorted(ALIASES.get(p, p) for p in re.findall(POS_NAME, prefix)))
            domain = ""
            section += 1
            index = marker.end()
            start = index
            continue
        if char in "[【" and not meaning[start:index].strip():
            end = meaning.find(OPEN[char], index + 1)
            if end >= 0:
                emit(index)
                domain = meaning[index:end + 1]
                prefix += domain
                section += 1
                index = end + 1
                start = index
                continue
        if char in OPEN:
            stack.append(OPEN[char])
        elif char in SEPARATORS:
            emit(index)
            separator = char
            start = index + 1
        index += 1
    emit(len(meaning))
    return senses


def sense_key(text):
    normalized = unicodedata.normalize("NFKC", text)
    return re.sub(r"\s+", "", normalized).strip("。.")


def deduplicate_meaning(meaning):
    senses = parse_senses(meaning)
    kept = []
    removed = []
    for sense in senses:
        key = sense_key(sense.text)
        duplicate = None
        if re.search(r"[\u4e00-\u9fff]", key):
            for other in kept:
                if key != sense_key(other.text) or sense.domain != other.domain:
                    continue
                if sense.part_of_speech == other.part_of_speech or not sense.part_of_speech or not other.part_of_speech:
                    duplicate = other
                    break
        if duplicate is None:
            kept.append(sense)
        elif not duplicate.part_of_speech and sense.part_of_speech:
            kept.remove(duplicate)
            removed.append(duplicate.text)
            kept.append(sense)
        else:
            removed.append(sense.text)
    if not removed:
        return meaning, []
    output = ""
    last_section = None
    for sense in kept:
        if last_section != sense.section:
            first = next(part for part in senses if part.section == sense.section)
            prefix = first.prefix
            separator = "；" if output else ""
        else:
            prefix = ""
            separator = sense.separator or "；"
        output += separator + (prefix + " " if prefix else "") + sense.text
        last_section = sense.section
    return output, removed


def clean_library(library):
    changes = []
    for word in library["words"]:
        before = word["meaning"]
        after, removed = deduplicate_meaning(before)
        if removed:
            word["meaning"] = after
            changes.append({"term": word["term"], "before": before, "after": after, "removed": removed})
    return changes


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--write", action="store_true", help="Apply reviewed cleanup and refresh the checked baseline.")
    parser.add_argument("--check", action="store_true", help="Fail if repeated senses remain.")
    args = parser.parse_args()
    from sync_article_vocabulary import LIBRARY, ENTRIES, VOCAB, expected_words, load_inputs, word_hash

    manifest, articles, library, _, _, _ = load_inputs()
    current = {word["term"]: word for word in library["words"]}
    for word in expected_words(manifest, articles):
        if current.get(word["term"]) != word:
            raise ValueError(f"Supplement entry differs from reviewed source: {word['term']}")
    changes = clean_library(library)
    print(f"Words checked: {len(library['words'])}; words changed: {len(changes)}; repeated senses removed: {sum(len(c['removed']) for c in changes)}")
    if args.check:
        if changes:
            raise SystemExit("Repeated Chinese senses remain.")
        return
    if not args.write:
        for change in changes[:25]:
            print(f"{change['term']}: {change['before']} -> {change['after']}")
        return
    if not changes:
        return
    by_term = {w["term"]: w for w in library["words"]}
    for entry in manifest["entries"]:
        entry["meaning"] = by_term[entry["term"]]["meaning"]
    previous_hash = manifest["originalWordsSha256"]
    manifest["originalWordsSha256"] = word_hash(library["words"][:manifest["originalWordCount"]])
    manifest.setdefault("meaningCleanups", []).append({
        "previousOriginalWordsSha256": previous_hash,
        "originalWordsSha256": manifest["originalWordsSha256"],
        "changedWords": len(changes),
        "removedRepeatedSenses": sum(len(c["removed"]) for c in changes),
    })
    override_path = VOCAB / "article-vocabulary-overrides.tsv"
    with override_path.open() as stream:
        reader = csv.DictReader(stream, delimiter="\t")
        fields = reader.fieldnames
        overrides = list(reader)
    for row in overrides:
        row["meaning"], _ = deduplicate_meaning(row["meaning"])
    report_path = VOCAB / "meaning-cleanup.tsv"
    with report_path.open("w") as stream:
        writer = csv.writer(stream, delimiter="\t")
        writer.writerow(["term", "before", "after", "removed"])
        for change in changes:
            writer.writerow([change["term"], change["before"], change["after"], json.dumps(change["removed"], ensure_ascii=False)])
    for path, payload in [(LIBRARY, library), (ENTRIES, manifest)]:
        partial = path.with_suffix(".part")
        partial.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
        partial.replace(path)
    with override_path.open("w") as stream:
        writer = csv.DictWriter(stream, fieldnames=fields, delimiter="\t")
        writer.writeheader()
        writer.writerows(overrides)


if __name__ == "__main__":
    main()
