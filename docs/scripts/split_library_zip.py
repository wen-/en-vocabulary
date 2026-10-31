#!/usr/bin/env python3
"""Split a vocabulary library ZIP into parts of similar size and verify the result.

Each part is a complete, independently importable package: library.json lists all
categories, its share of words, and every audio file those words reference. Import
the first part in any mode, then the remaining parts with "合并导入".
"""

import argparse
import json
import zipfile
from pathlib import Path


def audio_refs(word):
    return [item["audio"] for item in [word, *word.get("examples", [])] if item.get("audio")]


def unique_size(words, sizes):
    return sum(sizes[path] for path in {path for word in words for path in audio_refs(word)})


def split_words(words, sizes, parts):
    target = unique_size(words, sizes) / parts
    groups, current, seen, current_size = [], [], set(), 0
    for word in words:
        added = sum(sizes[path] for path in set(audio_refs(word)) - seen)
        if current and current_size + added / 2 > target and len(groups) < parts - 1:
            groups.append(current)
            current, seen, current_size = [], set(), 0
            added = sum(sizes[path] for path in set(audio_refs(word)))
        current.append(word)
        seen.update(audio_refs(word))
        current_size += added
    groups.append(current)
    return groups


def write_part(source, library, words, extras, target):
    paths = sorted({path for word in words for path in audio_refs(word)})
    payload = {**library, "words": words}
    with zipfile.ZipFile(target, "w") as archive:
        archive.writestr("library.json", json.dumps(payload, ensure_ascii=False, indent=2), compress_type=zipfile.ZIP_DEFLATED)
        for name in extras:
            archive.writestr(name, source.read(name), compress_type=zipfile.ZIP_DEFLATED)
        for path in paths:
            original = source.getinfo(path)
            info = zipfile.ZipInfo(path, original.date_time)
            info.compress_type = original.compress_type
            archive.writestr(info, source.read(path))
    return paths


def verify(source, library, targets):
    combined, categories = [], None
    for target in targets:
        with zipfile.ZipFile(target) as archive:
            if archive.testzip() is not None:
                raise ValueError(f"Corrupt entry in {target.name}")
            part = json.loads(archive.read("library.json"))
            names = set(archive.namelist())
            for word in part["words"]:
                for path in audio_refs(word):
                    if path not in names or archive.read(path) != source.read(path):
                        raise ValueError(f"{target.name}: audio missing or changed: {path}")
            if part["categories"] != library["categories"]:
                raise ValueError(f"{target.name}: categories differ from the source")
            combined.extend(part["words"])
    if combined != library["words"]:
        raise ValueError("Parts do not reassemble into the source word list")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("--parts", type=int, default=2)
    args = parser.parse_args()

    with zipfile.ZipFile(args.source) as source:
        library = json.loads(source.read("library.json"))
        sizes = {info.filename: info.file_size for info in source.infolist()}
        extras = [name for name in source.namelist() if name != "library.json" and not name.startswith("audio/")]
        targets = []
        for index, words in enumerate(split_words(library["words"], sizes, args.parts), start=1):
            target = args.source.with_name(f"{args.source.stem}-第{index}部分.zip")
            paths = write_part(source, library, words, extras, target)
            targets.append(target)
            print(f"{target.name}: {len(words)} words, {len(paths)} audio files, {target.stat().st_size / 1e6:.1f} MB")
        verify(source, library, targets)
    print(f"Verified: {args.parts} parts reassemble into {len(library['words'])} words with identical audio.")


if __name__ == "__main__":
    main()
