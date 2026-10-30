#!/usr/bin/env python3
"""Build strictly sentence-aligned articles from reviewed alignment decisions.

Decisions only choose where text is cut. They never supply replacement text, so
the English and Chinese of every paragraph are preserved exactly, in order.

A decision file holds {"items": [...]}. Each item names one paragraph_group
segment of articles-text.json by 1-based "article" and "segment" and has one of
these shapes.

  {"article": 1, "segment": 1, "ok": true}
      The script's English and Chinese sentence splits have equal counts and
      sentence N of each language is the same statement.

  {"article": 1, "segment": 3, "en_groups": [[0], [1, 2]],
   "zh_starts": ["该", "但"]}
      "en_groups" (optional) merges the script's English sentences into pieces.
      "zh_starts" has one entry per English piece. An entry is the first
      characters of that piece's Chinese, taken verbatim from the paragraph, or
      null when the source has no Chinese for that piece. The first non-null
      entry must start the Chinese paragraph, so no Chinese text can be dropped.

  An item may use "en_starts" instead of "en_groups" to re-cut the English
  paragraph at the given prefixes, for lists, addresses and tables whose lines
  are not sentences. Prefixes work like zh_starts and may not be null.

  Optional "zh_fixed": {"<piece index>": {"text": "corrected Chinese", "why": "reason"}}
  replaces the Chinese of one piece after the cut. Use it when the source
  translation is wrong, or when the source has no Chinese for that English
  piece. English is never changed. Every fix is written to
  strict-corrections.tsv with the original Chinese, the new Chinese and the
  reason. Keep a fix as close to the source wording as the correction allows.
  Optional "note".
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

from prepare_text import split_chinese_sentences, split_english_sentences

HERE = Path(__file__).resolve().parent
ARTICLES_PER_GROUP = 16


class DecisionError(ValueError):
    pass


def squash(text: str) -> str:
    return re.sub(r"\s+", "", text)


def tidy(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def is_review_item(sentence: dict) -> bool:
    return bool(sentence["en"]) and bool(sentence["zh"])


def segment_needs_decision(en: str, zh: str) -> bool:
    return (
        len(split_english_sentences(en)) > 1
        or len(split_chinese_sentences(zh)) > 1
        or any(mark in text for text in (en, zh) for mark in "\t\n")
    )


def group_range(group: int) -> range:
    return range((group - 1) * ARTICLES_PER_GROUP + 1, group * ARTICLES_PER_GROUP + 1)


def build_worksheet(articles: list[dict], group: int) -> str:
    lines: list[str] = []
    for index in group_range(group):
        article = articles[index - 1]
        lines.append(f"=== ARTICLE {index} {article['title']}")
        for number, sentence in enumerate(article["sentences"], start=1):
            en, zh = sentence["en"], sentence["zh"]
            if not zh or not segment_needs_decision(en, zh):
                continue
            english = split_english_sentences(en)
            chinese = split_chinese_sentences(zh)
            lines.append(f"--- A{index} S{number} en={len(english)} zh={len(chinese)}")
            lines.extend(f"E{i}: {tidy(text)}" for i, text in enumerate(english))
            lines.extend(f"Z{i}: {text}" for i, text in enumerate(chinese))
            if any(mark in text for text in (en, zh) for mark in "\t\n"):
                lines.append("EN-RAW: " + en.replace("\n", "<NL>").replace("\t", "<TAB>"))
                lines.append("ZH-RAW: " + zh.replace("\n", "<NL>").replace("\t", "<TAB>"))
    return "\n".join(lines) + "\n"


def cut_text(zh: str, starts: list[str | None]) -> list[str]:
    positions: list[int | None] = []
    cursor = 0
    for start in starts:
        if start is None:
            positions.append(None)
            continue
        if not isinstance(start, str) or not start.strip():
            raise DecisionError("zh_starts entries must be non-empty text or null")
        found = zh.find(start, cursor)
        if found < 0:
            raise DecisionError(f"Chinese start {start!r} not found after offset {cursor}")
        positions.append(found)
        cursor = found + 1
    present = [p for p in positions if p is not None]
    if not present:
        raise DecisionError("every piece has no Chinese")
    if zh[: present[0]].strip():
        raise DecisionError("text before the first Chinese start would be dropped")
    if present != sorted(set(present)):
        raise DecisionError("Chinese starts must be strictly increasing")
    bounds = present + [len(zh)]
    pieces: list[str] = []
    next_piece = 0
    for position in positions:
        if position is None:
            pieces.append("")
            continue
        pieces.append(zh[bounds[next_piece] : bounds[next_piece + 1]].strip())
        next_piece += 1
    return pieces


def apply_decision(sentence: dict, decision: dict) -> tuple[list[dict], list[int], list[dict], list[str]]:
    en, zh = sentence["en"], sentence["zh"]
    english = split_english_sentences(en)
    if "en_starts" in decision:
        if "en_groups" in decision or None in decision["en_starts"]:
            raise DecisionError("en_starts cannot be combined with en_groups and cannot contain null")
        english_pieces = [tidy(piece) for piece in cut_text(en, decision["en_starts"])]
    else:
        groups = decision.get("en_groups") or [[i] for i in range(len(english))]
        if [i for group in groups for i in group] != list(range(len(english))):
            raise DecisionError("en_groups must cover every English sentence once, in order")
        english_pieces = [tidy(" ".join(english[i] for i in group)) for group in groups]

    if decision.get("ok") is True:
        if "zh_starts" in decision:
            raise DecisionError("ok decisions cannot also set zh_starts")
        chinese_pieces = split_chinese_sentences(zh)
        if len(chinese_pieces) != len(english_pieces):
            raise DecisionError(
                f"ok needs equal counts, got en={len(english_pieces)} zh={len(chinese_pieces)}"
            )
    else:
        starts = decision.get("zh_starts")
        if not isinstance(starts, list) or len(starts) != len(english_pieces):
            raise DecisionError("zh_starts needs one entry per English piece")
        chinese_pieces = cut_text(zh, starts)

    if squash("".join(english_pieces)) != squash(en):
        raise DecisionError("English text was not preserved")
    if squash("".join(chinese_pieces)) != squash(zh):
        raise DecisionError("Chinese text was not preserved")

    pairs = [{"en": e, "zh": z} for e, z in zip(english_pieces, chinese_pieces)]
    originals = list(chinese_pieces)
    fixes: list[dict] = []
    for key, fix in (decision.get("zh_fixed") or {}).items():
        index = int(key)
        if not 0 <= index < len(pairs):
            raise DecisionError(f"zh_fixed index {index} is out of range")
        text = tidy(fix.get("text", "")) if isinstance(fix, dict) else ""
        why = tidy(fix.get("why", "")) if isinstance(fix, dict) else ""
        if not text or not why:
            raise DecisionError(f"zh_fixed {index} needs text and why")
        fixes.append({"piece": index, "en": pairs[index]["en"], "original": pairs[index]["zh"],
                      "corrected": text, "why": why})
        pairs[index]["zh"] = text
    missing = [i for i, pair in enumerate(pairs) if not pair["zh"]]
    return pairs, missing, fixes, originals


def load_decisions(decision_dir: Path) -> dict[tuple[int, int], dict]:
    decisions: dict[tuple[int, int], dict] = {}
    for path in sorted(decision_dir.glob("group-*.json")):
        for item in json.loads(path.read_text(encoding="utf-8"))["items"]:
            key = (item["article"], item["segment"])
            if key in decisions:
                raise DecisionError(f"duplicate decision for article {key[0]} segment {key[1]}")
            decisions[key] = item
    return decisions


def load_review_fixes(decision_dir: Path) -> dict[tuple[int, int], list[dict]]:
    """Corrections from the independent review, kept apart from the group decisions.

    review-fixes.json holds {"fixes": [{"article", "segment", "piece", "text", "why"}]}.
    "segment" and "piece" address the same units as the group decisions, and a segment
    that needed no decision has the single piece 0.
    """
    path = decision_dir / "review-fixes.json"
    grouped: dict[tuple[int, int], list[dict]] = defaultdict(list)
    if path.exists():
        for fix in json.loads(path.read_text(encoding="utf-8"))["fixes"]:
            grouped[(fix["article"], fix["segment"])].append(fix)
    return grouped


def apply_review_fixes(pairs: list[dict], originals: list[str], fixes: list[dict], where: str) -> list[dict]:
    applied: list[dict] = []
    for fix in fixes:
        index, text, why = fix["piece"], tidy(fix.get("text", "")), tidy(fix.get("why", ""))
        if not 0 <= index < len(pairs):
            raise DecisionError(f"{where}: review fix piece {index} is out of range")
        if not text or not why:
            raise DecisionError(f"{where}: review fix {index} needs text and why")
        if pairs[index]["zh"] != originals[index]:
            raise DecisionError(f"{where}: review fix {index} repeats an earlier correction")
        applied.append({"piece": index, "en": pairs[index]["en"], "original": originals[index],
                        "corrected": text, "why": why})
        pairs[index]["zh"] = text
    return applied


def assemble(
    articles: list[dict],
    decisions: dict[tuple[int, int], dict],
    review_fixes: dict[tuple[int, int], list[dict]] | None = None,
) -> dict:
    review_fixes = review_fixes or {}
    reviewed: set[tuple[int, int]] = set()
    out_articles: list[dict] = []
    undecided: list[tuple[int, int]] = []
    errors: list[str] = []
    unresolved: list[dict] = []
    corrections: list[dict] = []
    dropped_fragments: list[tuple[int, int]] = []
    used: set[tuple[int, int]] = set()
    all_provenance: list[list[dict]] = []

    for a_index, article in enumerate(articles, start=1):
        sentences: list[dict] = []
        provenance: list[dict] = []
        for s_index, sentence in enumerate(article["sentences"], start=1):
            en, zh = sentence["en"], sentence["zh"]
            if not zh:
                dropped_fragments.append((a_index, s_index))
                continue
            if not segment_needs_decision(en, zh):
                pairs = [{"en": tidy(en), "zh": zh.strip()}]
                originals = [zh.strip()]
                try:
                    fixes = apply_review_fixes(pairs, originals, review_fixes.get((a_index, s_index), []),
                                               f"A{a_index} S{s_index}")
                except DecisionError as error:
                    errors.append(str(error))
                    fixes = []
                reviewed.add((a_index, s_index))
                corrections.extend({"article": a_index, "segment": s_index, **fix} for fix in fixes)
                sentences.extend(pairs)
                provenance.append({"segment": s_index, "piece": 0, "original_zh": originals[0]})
                continue
            decision = decisions.get((a_index, s_index))
            if decision is None:
                undecided.append((a_index, s_index))
                continue
            used.add((a_index, s_index))
            try:
                pairs, missing, fixes, originals = apply_decision(sentence, decision)
            except DecisionError as error:
                errors.append(f"A{a_index} S{s_index}: {error}")
                continue
            try:
                fixes += apply_review_fixes(pairs, originals, review_fixes.get((a_index, s_index), []),
                                            f"A{a_index} S{s_index}")
            except DecisionError as error:
                errors.append(str(error))
            reviewed.add((a_index, s_index))
            corrections.extend({"article": a_index, "segment": s_index, **fix} for fix in fixes)
            unresolved.extend(
                {"article": a_index, "segment": s_index, "piece": i, "en": pairs[i]["en"]} for i in missing
            )
            sentences.extend(pairs)
            provenance.extend(
                {"segment": s_index, "piece": i, "original_zh": original} for i, original in enumerate(originals)
            )
        out_articles.append({"title": article["title"], "sentences": sentences})
        all_provenance.append(provenance)

    stray = sorted(set(decisions) - used)
    for key in sorted(set(review_fixes) - reviewed):
        errors.append(f"review fix targets a missing segment A{key[0]} S{key[1]}")
    complete = not undecided and not errors and not unresolved
    return {
        "articles": out_articles,
        "provenance": all_provenance,
        "undecided": undecided,
        "errors": errors,
        "unresolved": unresolved,
        "corrections": corrections,
        "stray_decisions": stray,
        "dropped_fragments": dropped_fragments,
        "complete": complete and not stray,
    }


def write_outputs(result: dict, output_dir: Path) -> None:
    sentence_count = sum(len(a["sentences"]) for a in result["articles"])
    lines = [
        f"complete: {result['complete']}",
        f"articles: {len(result['articles'])}",
        f"sentence pairs: {sentence_count}",
        f"undecided paragraph segments: {len(result['undecided'])}",
        f"decision errors: {len(result['errors'])}",
        f"English pieces without Chinese: {len(result['unresolved'])}",
        f"corrected or supplied Chinese pieces: {len(result['corrections'])}",
        f"stray decisions: {len(result['stray_decisions'])}",
        f"decorative fragments left out: {len(result['dropped_fragments'])}",
    ]
    by_article: dict[int, list[int]] = defaultdict(list)
    for a, s in result["undecided"]:
        by_article[a].append(s)
    lines += [f"UNDECIDED A{a}: segments {segs}" for a, segs in sorted(by_article.items())]
    lines += [f"ERROR {e}" for e in result["errors"]]
    lines += [
        f"MISSING_ZH A{r['article']} S{r['segment']} piece {r['piece']}: {r['en']}"
        for r in result["unresolved"]
    ]
    (output_dir / "strict-report.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")
    ledger = ["article\tsegment\tpiece\tenglish\toriginal_zh\tcorrected_zh\twhy"]
    ledger += [
        "\t".join(tidy(str(r[k])) for k in ("article", "segment", "piece", "en", "original", "corrected", "why"))
        for r in result["corrections"]
    ]
    (output_dir / "strict-corrections.tsv").write_text("\n".join(ledger) + "\n", encoding="utf-8")
    target = output_dir / ("articles-strict.json" if result["complete"] else "articles-strict.partial.json")
    stale = output_dir / ("articles-strict.partial.json" if result["complete"] else "articles-strict.json")
    stale.unlink(missing_ok=True)
    provenance = [[{"segment": p["segment"], "piece": p["piece"], "original_zh": p["original_zh"]} for p in article]
                  for article in result["provenance"]]
    (output_dir / "strict-provenance.json").write_text(
        json.dumps(provenance, ensure_ascii=False) + "\n", encoding="utf-8")
    payload = {"schemaVersion": 1, "articles": result["articles"]}
    target.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", choices=["worksheet", "check", "assemble", "review"])
    parser.add_argument("--group", type=int, choices=range(1, 9))
    parser.add_argument("--directory", type=Path, default=HERE)
    args = parser.parse_args(argv)

    articles = json.loads((args.directory / "articles-text.json").read_text(encoding="utf-8"))["articles"]
    if args.command == "worksheet":
        if args.group is None:
            parser.error("worksheet needs --group")
        target = args.directory / "worksheets"
        target.mkdir(exist_ok=True)
        path = target / f"group-{args.group}.txt"
        path.write_text(build_worksheet(articles, args.group), encoding="utf-8")
        print(path)
        return 0

    if args.command == "review":
        if args.group is None:
            parser.error("review needs --group")
        strict = json.loads((args.directory / "articles-strict.json").read_text(encoding="utf-8"))["articles"]
        trail = json.loads((args.directory / "strict-provenance.json").read_text(encoding="utf-8"))
        lines: list[str] = []
        for index in group_range(args.group):
            lines.append(f"=== ARTICLE {index} {strict[index - 1]['title']}")
            for number, (pair, origin) in enumerate(zip(strict[index - 1]["sentences"], trail[index - 1]), start=1):
                flag = "" if pair["zh"] == origin["original_zh"] else " [FIXED]"
                lines.append(f"A{index}#{number}{flag}\nEN: {pair['en']}\nZH: {pair['zh']}")
        target = args.directory / "worksheets"
        target.mkdir(exist_ok=True)
        path = target / f"review-{args.group}.txt"
        path.write_text("\n".join(lines) + "\n", encoding="utf-8")
        print(path, len(strict[args.group * ARTICLES_PER_GROUP - 1]["sentences"]))
        return 0

    if args.command == "check":
        if args.group is None:
            parser.error("check needs --group")
        folder = args.directory / "decisions"
        paths = sorted([*folder.glob(f"group-{args.group}.json"), *folder.glob(f"group-{args.group}-*.json")])
        items = [item for path in paths for item in json.loads(path.read_text(encoding="utf-8"))["items"]]
        mine = set(group_range(args.group))
        decisions = {(i["article"], i["segment"]): i for i in items}
        outside = [k for k in decisions if k[0] not in mine]
        scoped = {i: a for i, a in enumerate(articles, start=1) if i in mine}
        padded = [scoped.get(i, {"title": "", "sentences": []}) for i in range(1, len(articles) + 1)]
        result = assemble(padded, decisions)
        print(f"group {args.group}: decisions={len(decisions)} undecided={len(result['undecided'])} "
              f"errors={len(result['errors'])} missing_zh={len(result['unresolved'])} fixes={len(result['corrections'])} "
              f"outside_group={len(outside)}")
        for line in result["errors"][:20]:
            print("ERROR", line)
        for a, seg in result["undecided"][:10]:
            print(f"UNDECIDED A{a} S{seg}")
        return 0 if not (result["errors"] or result["undecided"] or outside) else 1

    result = assemble(
        articles,
        load_decisions(args.directory / "decisions"),
        load_review_fixes(args.directory / "decisions"),
    )
    write_outputs(result, args.directory)
    print((args.directory / "strict-report.txt").read_text(encoding="utf-8").split("UNDECIDED")[0].rstrip())
    return 0 if result["complete"] else 1


if __name__ == "__main__":
    sys.exit(main())
