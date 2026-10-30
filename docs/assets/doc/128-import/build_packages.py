#!/usr/bin/env python3
"""Turn articles-strict.json into importable article ZIP packages with MP3 audio.

Each English sentence is spoken with macOS `say`, converted to MP3 with lameenc,
and cached by voice, rate and text, so a rerun only speaks sentences it has not
spoken before. Chinese edits never trigger new audio. One ZIP is written per
course because the app accepts at most 2000 ZIP entries per package.

Setup, once:  python3 -m venv <dir> && <dir>/bin/pip install lameenc
Run:          <dir>/bin/python build_packages.py build --cache <dir> --out <dir>
Check:        <dir>/bin/python build_packages.py verify --cache <dir> --out <dir>
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
import tempfile
import wave
import zipfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
VOICE = "Samantha"
RATE = 165
MP3_KBPS = 48
MAX_AUDIO_BYTES = 4 * 1024 * 1024
MAX_ENTRIES = 2000
MAX_JSON_BYTES = 1024 * 1024
MAX_SECONDS = 300


def speech_text(en: str) -> str:
    text = re.sub(r"^[\s•●·]+", "", en)
    return re.sub(r"\s+", " ", text).strip()


def cache_key(voice: str, rate: int, text: str) -> str:
    return hashlib.sha1(f"{voice}|{rate}|{text}".encode("utf-8")).hexdigest()


def course_of(title: str) -> str:
    return title.split(" | ", 1)[0].strip()


def group_by_course(articles: list[dict]) -> dict[str, list[tuple[int, dict]]]:
    groups: dict[str, list[tuple[int, dict]]] = {}
    for index, article in enumerate(articles, start=1):
        groups.setdefault(course_of(article["title"]), []).append((index, article))
    return groups


def speak_to_mp3(text: str, voice: str, rate: int) -> bytes:
    import lameenc

    with tempfile.TemporaryDirectory() as folder:
        source = Path(folder, "text.txt")
        wave_path = Path(folder, "speech.wav")
        source.write_text(text, encoding="utf-8")
        subprocess.run(
            ["say", "-v", voice, "-r", str(rate), "--file-format=WAVE", "--data-format=LEI16@22050",
             "-o", str(wave_path), "-f", str(source)],
            check=True, capture_output=True,
        )
        with wave.open(str(wave_path), "rb") as reader:
            if reader.getnchannels() != 1 or reader.getsampwidth() != 2:
                raise RuntimeError(f"unexpected audio layout for {text[:40]!r}")
            rate_hz, pcm = reader.getframerate(), reader.readframes(reader.getnframes())
    encoder = lameenc.Encoder()
    encoder.set_bit_rate(MP3_KBPS)
    encoder.set_in_sample_rate(rate_hz)
    encoder.set_channels(1)
    encoder.set_quality(2)
    return bytes(encoder.encode(pcm)) + bytes(encoder.flush())


def ensure_audio(texts: list[str], cache: Path, voice: str, rate: int, jobs: int, synthesize=speak_to_mp3) -> int:
    cache.mkdir(parents=True, exist_ok=True)
    missing = [t for t in dict.fromkeys(texts) if not (cache / f"{cache_key(voice, rate, t)}.mp3").exists()]

    def work(text: str) -> None:
        data = synthesize(text, voice, rate)
        if not data:
            raise RuntimeError(f"empty audio for {text[:60]!r}")
        target = cache / f"{cache_key(voice, rate, text)}.mp3"
        partial = target.with_suffix(".part")
        partial.write_bytes(data)
        partial.replace(target)

    done = 0
    with ThreadPoolExecutor(max_workers=jobs) as pool:
        for _ in pool.map(work, missing):
            done += 1
            if done % 100 == 0:
                print(f"spoken {done}/{len(missing)}", flush=True)
    return len(missing)


def build_manifest(entries: list[tuple[int, dict]], cache: Path, voice: str, rate: int) -> tuple[dict, dict[str, Path]]:
    files: dict[str, Path] = {}
    articles = []
    for index, article in entries:
        sentences = []
        for number, sentence in enumerate(article["sentences"], start=1):
            text = speech_text(sentence["en"])
            name = f"audio/a{index:03d}-{number:03d}.mp3"
            files[name] = cache / f"{cache_key(voice, rate, text)}.mp3"
            sentences.append({"en": sentence["en"], "zh": sentence["zh"], "audio": name})
        articles.append({"title": article["title"], "sentences": sentences})
    return {"schemaVersion": 1, "articles": articles}, files


def write_package(path: Path, manifest: dict, files: dict[str, Path]) -> None:
    payload = json.dumps(manifest, ensure_ascii=False, indent=2).encode("utf-8")
    if len(payload) > MAX_JSON_BYTES or len(files) + 1 > MAX_ENTRIES:
        raise RuntimeError(f"{path.name} exceeds the app's package limits")
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("articles.json", payload, compress_type=zipfile.ZIP_DEFLATED)
        for name, source in files.items():
            data = source.read_bytes()
            if not data or len(data) > MAX_AUDIO_BYTES:
                raise RuntimeError(f"bad audio size for {name}")
            archive.writestr(name, data, compress_type=zipfile.ZIP_STORED)


def build(args: argparse.Namespace) -> int:
    articles = json.loads(Path(args.strict).read_text(encoding="utf-8"))["articles"]
    if args.limit:
        articles = articles[: args.limit]
    texts = [speech_text(s["en"]) for a in articles for s in a["sentences"]]
    if any(not t for t in texts):
        raise SystemExit("an English sentence has nothing to speak")
    spoken = ensure_audio(texts, Path(args.cache), args.voice, args.rate, args.jobs)
    print(f"sentences {len(texts)}, newly spoken {spoken}")
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    for course, entries in group_by_course(articles).items():
        manifest, files = build_manifest(entries, Path(args.cache), args.voice, args.rate)
        target = out / f"文章导入包-{course}.zip"
        write_package(target, manifest, files)
        print(f"{target.name}: {len(entries)} articles, {len(files)} audio files, {target.stat().st_size // 1024} KB")
    return 0


def audio_seconds(path: Path) -> float:
    report = subprocess.run(["afinfo", str(path)], capture_output=True, text=True, check=True).stdout
    match = re.search(r"estimated duration:\s*([\d.]+)\s*sec", report)
    if not match:
        raise RuntimeError(f"cannot read the duration of {path.name}")
    return float(match.group(1))


def verify(args: argparse.Namespace) -> int:
    strict = json.loads(Path(args.strict).read_text(encoding="utf-8"))["articles"]
    if args.limit:
        strict = strict[: args.limit]
    expected_sentences = sum(len(a["sentences"]) for a in strict)
    problems: list[str] = []
    packages = sorted(Path(args.out).glob("文章导入包-*.zip"))
    seen_articles = 0
    seen_sentences = 0
    audio_names: list[tuple[str, bytes]] = []
    for package in packages:
        with zipfile.ZipFile(package) as archive:
            names = set(archive.namelist())
            manifest = json.loads(archive.read("articles.json"))
            if manifest["schemaVersion"] != 1:
                problems.append(f"{package.name}: schemaVersion")
            for article in manifest["articles"]:
                seen_articles += 1
                for sentence in article["sentences"]:
                    seen_sentences += 1
                    if not sentence["en"].strip() or not sentence["zh"].strip():
                        problems.append(f"{package.name}: empty text in {article['title']}")
                    if sentence["audio"] not in names:
                        problems.append(f"{package.name}: missing {sentence['audio']}")
                    else:
                        data = archive.read(sentence["audio"])
                        if not (data[:3] == b"ID3" or (data[0] == 0xFF and data[1] & 0xE0 == 0xE0)):
                            problems.append(f"{package.name}: not MP3 {sentence['audio']}")
                        audio_names.append((f"{package.name}/{sentence['audio']}", data))
            if len(names) > MAX_ENTRIES:
                problems.append(f"{package.name}: {len(names)} entries")
    if seen_articles != len(strict) or seen_sentences != expected_sentences:
        problems.append(f"coverage {seen_articles}/{len(strict)} articles, {seen_sentences}/{expected_sentences} sentences")

    def duration(item: tuple[str, bytes]) -> tuple[str, float]:
        with tempfile.NamedTemporaryFile(suffix=".mp3") as handle:
            handle.write(item[1])
            handle.flush()
            return item[0], audio_seconds(Path(handle.name))

    with ThreadPoolExecutor(max_workers=args.jobs) as pool:
        lengths = list(pool.map(duration, audio_names))
    for name, seconds in lengths:
        if not 0.2 < seconds < MAX_SECONDS:
            problems.append(f"{name}: duration {seconds}")
    seconds_only = [s for _, s in lengths]
    print(f"packages {len(packages)}, articles {seen_articles}, sentences {seen_sentences}")
    if seconds_only:
        print(f"audio {len(seconds_only)} files, shortest {min(seconds_only):.1f}s, longest {max(seconds_only):.1f}s, "
              f"total {sum(seconds_only) / 60:.0f} min")
    for line in problems[:30]:
        print("PROBLEM", line)
    print("OK" if not problems else f"{len(problems)} problems")
    return 0 if not problems else 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", choices=["build", "verify"])
    parser.add_argument("--strict", default=str(HERE / "articles-strict.json"))
    parser.add_argument("--cache", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--voice", default=VOICE)
    parser.add_argument("--rate", type=int, default=RATE)
    parser.add_argument("--jobs", type=int, default=6)
    parser.add_argument("--limit", type=int, default=0, help="only the first N articles, for a trial run")
    args = parser.parse_args(argv)
    return build(args) if args.command == "build" else verify(args)


if __name__ == "__main__":
    sys.exit(main())
