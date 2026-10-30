#!/usr/bin/env python3
"""Prepare the reviewed article entry manifest from licensed dictionary files."""

import argparse
import collections
import csv
import hashlib
import json
import re
from pathlib import Path

from vocabulary_meanings import deduplicate_meaning

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--dictionary", type=Path, required=True)
parser.add_argument("--cmu", type=Path, required=True)
args = parser.parse_args()
ROOT = Path(__file__).resolve().parents[1]
VOCAB = ROOT / "assets/doc/vocabulary"
ARTICLES = ROOT / "assets/doc/128-import/articles-strict.json"
with args.dictionary.open() as stream:
    dictionary = {r["word"].lower(): r for r in csv.DictReader(stream)}
cmu = {}
for line in args.cmu.read_text().splitlines():
    if not line or line.startswith(";;;"):
        continue
    word, *phones = line.split()
    cmu.setdefault(re.sub(r"\(\d+\)$", "", word), phones)
arpa = dict(zip(
    "AA AE AH AO AW AY B CH D DH EH ER EY F G HH IH IY JH K L M N NG OW OY P R S SH T TH UH UW V W Y Z ZH".split(),
    "ɑ æ ʌ ɔ aʊ aɪ b tʃ d ð ɛ ɝ eɪ f ɡ h ɪ iː dʒ k l m n ŋ oʊ ɔɪ p ɹ s ʃ t θ ʊ uː v w j z ʒ".split(),
))


def cmu_ipa(term):
    if term not in cmu:
        return ""
    result = ""
    for phone in cmu[term]:
        key = phone.rstrip("012")
        symbol = arpa[key]
        if phone == "AH0":
            symbol = "ə"
        elif phone == "ER0":
            symbol = "ɚ"
        result += symbol
    return result


def clean_ipa(text):
    return text.strip("/[] ").replace("ә", "ə").replace("'", "ˈ").replace(":", "ː").replace("ɡ", "g")


def suffix_ipa(base, ipa, suffix):
    if suffix in ("s", "'s", "es"):
        return ipa + ("ɪz" if ipa.endswith(("s", "z", "ʃ", "ʒ", "tʃ", "dʒ")) else "s" if ipa.endswith(("p", "t", "k", "f", "θ")) else "z")
    if suffix == "ed":
        return ipa + ("ɪd" if ipa.endswith(("t", "d")) else "t" if ipa.endswith(("p", "k", "f", "θ", "s", "ʃ", "tʃ")) else "d")
    if suffix == "ing":
        return ipa + "ɪŋ"
    return ""


overrides = {}
override_path = VOCAB / "article-vocabulary-overrides.tsv"
if override_path.exists():
    with override_path.open() as stream:
        overrides = {r["term"]: r for r in csv.DictReader(stream, delimiter="\t")}


def ipa_for(term, seen=frozenset()):
    if term in seen:
        return ""
    seen = seen | {term}
    override = overrides.get(term, {})
    if override.get("phonetic"):
        return override["phonetic"]
    row = dictionary.get(term, {})
    if row.get("phonetic"):
        return clean_ipa(row["phonetic"])
    if cmu_ipa(term):
        return cmu_ipa(term)
    if override.get("speech") and override["speech"] != term:
        parts = re.findall(r"[a-z]+(?:'[a-z]+)*", override["speech"].lower())
        values = [ipa_for(part, seen) for part in parts]
        if values and all(values):
            return " ".join(values)
    if term.endswith("'s"):
        base = term[:-2]
        ipa = ipa_for(base, seen)
        if ipa:
            return suffix_ipa(base, ipa, "'s")
    if "-" in term:
        parts = term.split("-")
        values = [ipa_for(part, seen) for part in parts]
        if all(values):
            return " ".join(values)
    exchange = dict(x.split(":", 1) for x in row.get("exchange", "").split("/") if ":" in x)
    base = exchange.get("0", "")
    if base and base != term:
        ipa = ipa_for(base, seen)
        if ipa:
            if term.endswith("ing"):
                return suffix_ipa(base, ipa, "ing")
            if term.endswith("ed"):
                return suffix_ipa(base, ipa, "ed")
            if term.endswith("s"):
                return suffix_ipa(base, ipa, "s")
    return ""


def clean_meaning(text):
    return re.sub(r"\s+", " ", text.replace("\\r", " ").replace("\\n", "；").replace("\r", " ").replace("\n", "；")).strip("； ")


def meaning_for(term):
    override = overrides.get(term, {})
    if override.get("meaning"):
        return override["meaning"]
    row = dictionary.get(term, {})
    exchange = dict(x.split(":", 1) for x in row.get("exchange", "").split("/") if ":" in x)
    base = exchange.get("0", "")
    if base and base != term and base in dictionary:
        meaning = clean_meaning(dictionary[base]["translation"])
        if re.search(r"[\u4e00-\u9fff]", meaning):
            labels = {"s": "复数", "3": "第三人称单数", "d": "过去式", "p": "过去分词", "i": "现在分词", "r": "比较级", "t": "最高级"}
            forms = "、".join(labels[x] for x in exchange.get("1", "") if x in labels)
            return f"{base} 的{forms or '变化形式'}；{meaning}"
    if term.endswith("'s"):
        base = term[:-2]
        meaning = meaning_for(base)
        if meaning:
            return f"{base} 的所有格，表示“……的”；也可为 is 或 has 的缩写，依语境判断；{meaning}"
    return clean_meaning(row.get("translation", ""))


library = json.loads((VOCAB / "library.json").read_text())
articles = json.loads(ARTICLES.read_text())["articles"]
manifest_path = VOCAB / "article-vocabulary-entries.json"
previous = json.loads(manifest_path.read_text()) if manifest_path.exists() else None
original = {"words": library["words"][:previous["originalWordCount"]]} if previous else library
original_hash = hashlib.sha256(json.dumps(original["words"], ensure_ascii=False, sort_keys=True).encode()).hexdigest()
if previous and original_hash != previous["originalWordsSha256"]:
    raise ValueError("Original vocabulary records changed.")
terms = {w["term"].strip().lower() for w in original["words"]}
occurrences = collections.defaultdict(list)
ui_terms = set()
lexical_terms = set()
for ai, article in enumerate(articles):
    for si, sentence in enumerate(article["sentences"]):
        lexical = {t.lower().replace("’", "'") for t in re.findall(r"[A-Za-z]+(?:['’\-][A-Za-z]+)*", sentence["en"])}
        ui = {t.lower() for t in re.findall(r"[A-Za-z]+(?:['\-][A-Za-z]+)*", sentence["en"])}
        lexical_terms.update(lexical)
        ui_terms.update(ui)
        for term in lexical | ui:
            occurrences[term].append((ai, si))
body_lexical_terms = lexical_terms.copy()
for ai, article in enumerate(articles):
    title = article["title"].split(" | ", 2)[-1]
    lexical = {t.lower().replace("’", "'") for t in re.findall(r"[A-Za-z]+(?:['’\-][A-Za-z]+)*", title)}
    lexical_terms.update(lexical)
    for term in lexical:
        occurrences[term].append((ai, -1))
entries = []
gaps = []
for term in sorted(occurrences.keys() - terms):
    meaning, _ = deduplicate_meaning(meaning_for(term))
    ipa = ipa_for(term)
    has_chinese_meaning = bool(re.search(r"[\u4e00-\u9fff]", meaning))
    if not has_chinese_meaning or not ipa:
        gaps.append((term, has_chinese_meaning, bool(ipa)))
    row = dictionary.get(term, {})
    override = overrides.get(term, {})
    entries.append({
        "term": term,
        "phonetics": [f"/{ipa}/"] if ipa else [],
        "meaning": meaning,
        "speech": override.get("speech") or term,
        "meaningSource": (
            "contextual annotation" if override.get("meaning")
            else "derived possessive annotation using ECDICT or contextual base"
            if term.endswith("'s") else "ECDICT"
        ),
        "phoneticSource": "contextual annotation" if override.get("phonetic") else "ECDICT / CMUdict / regular-inflection derivation",
        "firstOccurrence": list(occurrences[term][0]),
        "sentenceOccurrences": len(occurrences[term]),
        "uiFragment": term not in lexical_terms,
    })
payload = {
    "schemaVersion": 1,
    "articlesSha256": hashlib.sha256(ARTICLES.read_bytes()).hexdigest(),
    "originalWordCount": len(original["words"]),
    "originalWordsSha256": original_hash,
    "lexicalMissing": len(lexical_terms - terms),
    "bodyLexicalMissing": len(body_lexical_terms - terms),
    "titleAdditionalMissing": sorted(lexical_terms - body_lexical_terms - terms),
    "uiAdditionalFragments": sorted(ui_terms - lexical_terms - terms),
    "dictionarySha256": hashlib.sha256(args.dictionary.read_bytes()).hexdigest(),
    "cmuSha256": hashlib.sha256(args.cmu.read_bytes()).hexdigest(),
    "entries": entries,
}
if previous and "meaningCleanups" in previous:
    payload["meaningCleanups"] = previous["meaningCleanups"]
print("entries", len(entries), "incomplete", len(gaps))
for term, meaning, ipa in gaps:
    print(term, "meaning" if not meaning else "", "IPA" if not ipa else "")
if gaps:
    raise SystemExit("Incomplete entries. Add contextual annotations before saving.")
manifest_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
