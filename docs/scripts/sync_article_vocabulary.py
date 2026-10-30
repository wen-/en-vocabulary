#!/usr/bin/env python3
"""Build or verify the reviewed vocabulary supplement for the 128 articles."""

import argparse
import collections
import csv
import hashlib
import importlib.util
import json
import re
import subprocess
import tempfile
import zipfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VOCAB = ROOT / "assets/doc/vocabulary"
ARTICLES = ROOT / "assets/doc/128-import/articles-strict.json"
ENTRIES = VOCAB / "article-vocabulary-entries.json"
LIBRARY = VOCAB / "library.json"
REPORT = VOCAB / "article-vocabulary-report.json"
CATEGORY = {"name": "128篇文章补充", "description": "128篇文章正文、标题及页面缩写片段中原词库未同名收录的词形。"}
LEXICAL_PATTERN = re.compile(r"[A-Za-z]+(?:['’\-][A-Za-z]+)*")
UI_PATTERN = re.compile(r"[A-Za-z]+(?:['\-][A-Za-z]+)*")


def word_hash(words):
    return hashlib.sha256(json.dumps(words, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def audio_path(kind, text):
    digest = hashlib.sha256(text.encode()).hexdigest()[:24]
    return f"audio/{kind}/article-{digest}.mp3"


def title_sentence(article):
    title = article["title"].split(" | ", 2)[-1]
    match = re.search(r"[\u4e00-\u9fff]", title)
    if not match:
        raise ValueError(f"Title has no Chinese translation: {title}")
    return {"en": title[:match.start()].strip(" /"), "zh": title[match.start():].strip()}


def scan(articles):
    lexical = collections.Counter()
    ui = collections.Counter()
    locations = collections.defaultdict(set)
    for ai, article in enumerate(articles):
        sentences = [*article["sentences"], title_sentence(article)]
        for si, sentence in enumerate(sentences):
            lexical_tokens = [t.lower().replace("’", "'") for t in LEXICAL_PATTERN.findall(sentence["en"])]
            ui_tokens = [t.lower() for t in UI_PATTERN.findall(sentence["en"])] if si < len(article["sentences"]) else []
            lexical.update(lexical_tokens)
            ui.update(ui_tokens)
            for token in set(lexical_tokens + ui_tokens):
                locations[token].add(ai)
    return lexical, ui, locations


def load_inputs():
    if not ARTICLES.is_file() or not LIBRARY.is_file() or not ENTRIES.is_file():
        raise ValueError("Articles, library, and reviewed entries are all required.")
    manifest = json.loads(ENTRIES.read_text())
    if hashlib.sha256(ARTICLES.read_bytes()).hexdigest() != manifest["articlesSha256"]:
        raise ValueError("Article content changed. Review and regenerate the entry manifest.")
    articles = json.loads(ARTICLES.read_text())["articles"]
    library = json.loads(LIBRARY.read_text())
    if len(articles) != 128 or library.get("schemaVersion") != 1:
        raise ValueError("Expected 128 articles and library schema version 1.")
    count = manifest["originalWordCount"]
    if word_hash(library["words"][:count]) != manifest["originalWordsSha256"]:
        raise ValueError("Original vocabulary records changed.")
    original_terms = {word["term"].lower().strip() for word in library["words"][:count]}
    lexical, ui, locations = scan(articles)
    missing = (lexical.keys() | ui.keys()) - original_terms
    terms = [entry["term"] for entry in manifest["entries"]]
    if len(terms) != len(set(terms)) or set(terms) != missing:
        raise ValueError(f"Entry coverage mismatch. Missing={sorted(missing - set(terms))}; extra={sorted(set(terms) - missing)}")
    for entry in manifest["entries"]:
        if not re.search(r"[\u4e00-\u9fff]", entry["meaning"]) or not entry["phonetics"] or not all(re.fullmatch(r"/[^/]+/", p) for p in entry["phonetics"]):
            raise ValueError(f"Incomplete meaning or phonetics: {entry['term']}")
    return manifest, articles, library, lexical, ui, locations


def expected_words(manifest, articles):
    words = []
    for entry in manifest["entries"]:
        ai, si = entry["firstOccurrence"]
        article = articles[ai]
        sentence = article["sentences"][si] if si >= 0 else title_sentence(article)
        if entry["term"] not in {
            token.lower().replace("’", "'")
            for pattern in (LEXICAL_PATTERN, UI_PATTERN)
            for token in pattern.findall(sentence["en"])
        }:
            raise ValueError(f"Example does not contain {entry['term']}")
        example = {
            "en": sentence["en"], "zh": sentence["zh"],
            "audio": audio_path("examples", sentence["en"]),
        }
        words.append({
            "term": entry["term"], "phonetics": entry["phonetics"], "meaning": entry["meaning"],
            "isFavorite": False, "categories": [{"name": CATEGORY["name"]}],
            "examples": [example], "audio": audio_path("words", entry["term"]),
        })
    return words


def audio_references(words):
    return {path for word in words for path in [word.get("audio"), *(e.get("audio") for e in word.get("examples", []))] if path}


def check_audio_path(path):
    target = (VOCAB / path).resolve()
    if not target.is_relative_to(VOCAB.resolve()) or not path.startswith("audio/") or target.suffix != ".mp3":
        raise ValueError(f"Invalid audio reference: {path}")
    if not target.is_file() or target.stat().st_size < 128:
        raise ValueError(f"Missing or empty audio: {path}")
    return target


def decode_audio(path):
    target = check_audio_path(path)
    with tempfile.TemporaryDirectory() as folder:
        decoded = Path(folder) / "decoded.wav"
        subprocess.run(["afconvert", "-f", "WAVE", "-d", "LEI16", str(target), str(decoded)], check=True, capture_output=True)
        if decoded.stat().st_size <= 44:
            raise ValueError(f"Audio decodes to no PCM samples: {path}")


def build(args):
    manifest, articles, library, _, _, _ = load_inputs()
    added = expected_words(manifest, articles)
    current = {word["term"].lower().strip(): word for word in library["words"]}
    if len(current) != len(library["words"]):
        raise ValueError("Duplicate vocabulary terms.")
    for word in added:
        if word["term"] in current and current[word["term"]] != word:
            raise ValueError(f"Refusing to overwrite an edited supplement entry: {word['term']}")
    if importlib.util.find_spec("lameenc") is None:
        raise RuntimeError("MP3 encoder missing. Install lameenc into a virtual environment and rerun.")
    module_path = ROOT / "assets/doc/128-import/build_packages.py"
    spec = importlib.util.spec_from_file_location("article_audio", module_path)
    audio = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(audio)
    sentence_audio = {}
    packages = sorted(args.article_packages.glob("*.zip"))
    if not packages:
        raise ValueError(f"No article ZIP packages in {args.article_packages}")
    for package in packages:
        with zipfile.ZipFile(package) as archive:
            for article in json.loads(archive.read("articles.json"))["articles"]:
                for sentence in article["sentences"]:
                    if sentence.get("audio"):
                        sentence_audio.setdefault(sentence["en"], (package, sentence["audio"]))
    tasks = {}
    for entry, word in zip(manifest["entries"], added):
        tasks[word["audio"]] = (entry["speech"], None)
        example = word["examples"][0]
        tasks[example["audio"]] = (example["en"], sentence_audio.get(example["en"]))

    def write_audio(item):
        path, (text, source) = item
        target = VOCAB / path
        if target.is_file():
            check_audio_path(path)
            return
        target.parent.mkdir(parents=True, exist_ok=True)
        if source:
            package, name = source
            with zipfile.ZipFile(package) as archive:
                data = archive.read(name)
        else:
            data = audio.speak_to_mp3(text, "Samantha", 165)
        if len(data) < 128:
            raise ValueError(f"Generated audio is empty: {path}")
        partial = target.with_suffix(".part")
        partial.write_bytes(data)
        partial.replace(target)

    with ThreadPoolExecutor(max_workers=args.jobs) as pool:
        for index, _ in enumerate(pool.map(write_audio, tasks.items()), start=1):
            if index % 250 == 0:
                print(f"audio ready {index}/{len(tasks)}", flush=True)
    library["words"].extend(word for word in added if word["term"] not in current)
    if not any(c["name"] == CATEGORY["name"] for c in library["categories"]):
        library["categories"].append(CATEGORY)
    partial = LIBRARY.with_suffix(".part")
    partial.write_text(json.dumps(library, ensure_ascii=False, indent=2) + "\n")
    partial.replace(LIBRARY)
    verify(args)


def verify(args):
    manifest, articles, library, lexical, ui, locations = load_inputs()
    expected = expected_words(manifest, articles)
    actual = {word["term"].strip().lower(): word for word in library["words"]}
    if len(actual) != len(library["words"]):
        raise ValueError("Duplicate vocabulary terms.")
    for word in expected:
        if actual.get(word["term"]) != word:
            raise ValueError(f"Supplement entry differs from reviewed source: {word['term']}")
    if len(library["words"]) != manifest["originalWordCount"] + len(expected):
        raise ValueError("Unexpected word count.")
    for word in library["words"]:
        if not word["term"] or not word["meaning"] or any(not e["en"] or not e["zh"] for e in word.get("examples", [])):
            raise ValueError(f"Invalid import record: {word['term']}")
    category_names = {c["name"] for c in library["categories"]}
    if any(c["name"] not in category_names for w in library["words"] for c in w["categories"]):
        raise ValueError("Undefined category reference.")
    references = audio_references(library["words"])
    for path in sorted(references):
        check_audio_path(path)
    added_audio = audio_references(expected)
    if args.decode_audio:
        with ThreadPoolExecutor(max_workers=args.jobs) as pool:
            list(pool.map(decode_audio, sorted(added_audio)))
    missing_lexical = sorted(lexical.keys() - actual.keys())
    missing_ui = sorted(ui.keys() - actual.keys())
    if missing_lexical or missing_ui:
        raise ValueError(f"Remaining vocabulary gaps: {missing_lexical}, {missing_ui}")
    summary = {
        "articleCount": len(articles),
        "originalWordCount": manifest["originalWordCount"],
        "lexicalMissingBefore": manifest["lexicalMissing"],
        "bodyMissingBefore": manifest["bodyLexicalMissing"],
        "titleAdditionalMissing": manifest["titleAdditionalMissing"],
        "additionalUiFragments": manifest["uiAdditionalFragments"],
        "addedWordCount": len(expected), "totalWordCount": len(library["words"]),
        "lexicalUniqueCount": len(lexical), "lexicalTokenCount": sum(lexical.values()),
        "remainingLexicalMissing": missing_lexical, "remainingUiMissing": missing_ui,
        "addedWordAudioCount": len({w["audio"] for w in expected}),
        "addedExampleAudioCount": len({w["examples"][0]["audio"] for w in expected}),
        "originalWordsUnchanged": not bool(manifest.get("meaningCleanups")),
        "originalWordsMatchReviewedBaseline": True,
        "meaningCleanups": manifest.get("meaningCleanups", []),
        "articlesSha256": manifest["articlesSha256"],
        "originalWordsSha256": manifest["originalWordsSha256"],
        "supplementAudioSha256": {p: hashlib.sha256((VOCAB / p).read_bytes()).hexdigest() for p in sorted(added_audio)},
    }
    if REPORT.exists():
        previous = json.loads(REPORT.read_text())
        if previous.get("supplementAudioSha256") != summary["supplementAudioSha256"]:
            raise ValueError("Supplement audio differs from the recorded checksums.")
    REPORT.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n")
    with (VOCAB / "article-vocabulary-missing.tsv").open("w") as stream:
        writer = csv.writer(stream, delimiter="\t")
        writer.writerow(["term", "kind", "occurrences", "articleCount", "meaning", "phonetics", "firstArticle"])
        for entry in manifest["entries"]:
            term = entry["term"]
            writer.writerow([
                term, "ui-fragment" if entry["uiFragment"] else "word-form",
                ui[term] if entry["uiFragment"] else lexical[term], len(locations[term]),
                entry["meaning"], " ".join(entry["phonetics"]), articles[entry["firstOccurrence"][0]]["title"],
            ])
    print(json.dumps({k: v for k, v in summary.items() if k != "supplementAudioSha256"}, ensure_ascii=False, indent=2))


def package(args):
    verify(args)
    args.output.mkdir(parents=True, exist_ok=True)
    manifest, articles, library, _, _, _ = load_inputs()
    supplement = {"schemaVersion": 1, "categories": [CATEGORY], "words": expected_words(manifest, articles)}
    for name, payload in [("词库-128篇文章缺失补充.zip", supplement), ("词库-完整词库含文章补充.zip", library)]:
        target = args.output / name
        partial = target.with_suffix(".part")
        with zipfile.ZipFile(partial, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("library.json", json.dumps(payload, ensure_ascii=False, indent=2))
            for path in sorted(audio_references(payload["words"])):
                archive.write(VOCAB / path, path, compress_type=zipfile.ZIP_STORED)
            archive.write(VOCAB / "dictionary-licenses.txt", "dictionary-licenses.txt")
        with zipfile.ZipFile(partial) as archive:
            expected_names = audio_references(payload["words"]) | {"library.json", "dictionary-licenses.txt"}
            if set(archive.namelist()) != expected_names or archive.testzip() is not None:
                raise ValueError(f"Incomplete or corrupt vocabulary package: {partial}")
            if json.loads(archive.read("library.json")) != payload:
                raise ValueError(f"Vocabulary package content changed: {partial}")
        partial.replace(target)
        print(f"package {target}, {target.stat().st_size} bytes", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["build", "verify", "package"])
    parser.add_argument("--article-packages", type=Path, default=ROOT.parent / "文章导入包")
    parser.add_argument("--output", type=Path, default=ROOT.parent / "单词导入包")
    parser.add_argument("--jobs", type=int, default=3)
    parser.add_argument("--decode-audio", action="store_true")
    args = parser.parse_args()
    if args.jobs < 1:
        parser.error("--jobs must be positive")
    {"build": build, "verify": verify, "package": package}[args.command](args)


if __name__ == "__main__":
    main()
