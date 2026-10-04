"""Turns bench.py's results.json into a Markdown report.

Usage: python3 report.py <results.json> > report.md
"""

import json
import statistics
import sys
from collections import defaultdict

SIZE_CLASSES = [("< 1 MB", 0, 1e6), ("1-10 MB", 1e6, 10e6), ("> 10 MB", 10e6, float("inf"))]


def mb(n: float) -> str:
    return f"{n / 1e6:,.1f}"


def main() -> None:
    res = json.load(open(sys.argv[1]))
    rows = res["rows"]
    books = {r["book"]: r["raw_bytes"] for r in rows if r["granularity"] == "whole"}
    total_raw = sum(books.values())
    codecs = list(dict.fromkeys(r["codec"] for r in rows))
    grans = list(dict.fromkeys(r["granularity"] for r in rows))

    by = defaultdict(list)
    for r in rows:
        by[(r["codec"], r["granularity"])].append(r)

    print("# Compression benchmark: Shamela books\n")
    print(
        f"{len(books)} books, {mb(total_raw)} MB of UTF-8 text. zstd dictionary: "
        f"{res['dict_bytes']:,} bytes, trained in {res['dict_train_s']:.0f}s on a separate set of books. "
        f"Ran with {res['workers']} books in parallel, so absolute speeds are a little pessimistic.\n"
    )
    print(
        "Ratio = original bytes / stored bytes, summed over all books, including a 4-byte offset per "
        "block. Random access = median over books of the median time to decode the one block holding "
        "a random page, and the compressed bytes that block costs to fetch. For `whole` that is the "
        "entire book.\n"
    )

    for gran in grans:
        print(f"\n## Granularity: {gran}\n")
        print("| codec | ratio | bits/char | compress MB/s | decode MB/s | random page: decode | random page: fetch |")
        print("|---|---:|---:|---:|---:|---:|---:|")
        for codec in codecs:
            rs = by.get((codec, gran))
            if not rs:
                continue
            raw = sum(r["raw_bytes"] for r in rs)
            stored = sum(r["stored_bytes"] for r in rs)
            chars = sum(r["raw_chars"] for r in rs)
            ra_us = statistics.median(r["ra_median_us"] for r in rs)
            ra_b = statistics.median(r["ra_median_bytes"] for r in rs)
            ra = f"{ra_us / 1000:,.1f} ms" if ra_us >= 1000 else f"{ra_us:,.0f} µs"
            fetch = f"{ra_b / 1e6:,.2f} MB" if ra_b >= 1e6 else f"{ra_b / 1e3:,.1f} KB"
            print(
                f"| {codec} | {raw / stored:.2f} | {stored * 8 / chars:.2f} | "
                f"{mb(raw / sum(r['compress_s'] for r in rs))} | {mb(raw / sum(r['decode_s'] for r in rs))} | "
                f"{ra} | {fetch} |"
            )

    print("\n## Whole-file ratio by book size\n")
    print("| codec | " + " | ".join(n for n, _, _ in SIZE_CLASSES) + " |")
    print("|---|" + "---:|" * len(SIZE_CLASSES))
    for codec in codecs:
        rs = by.get((codec, "whole"), [])
        cells = []
        for _, lo, hi in SIZE_CLASSES:
            sel = [r for r in rs if lo <= r["raw_bytes"] < hi]
            cells.append(f"{sum(r['raw_bytes'] for r in sel) / sum(r['stored_bytes'] for r in sel):.2f}" if sel else "")
        print(f"| {codec} | " + " | ".join(cells) + " |")

    if "dict_sweep" in res:
        print("\n## zstd-19 per page, by dictionary size\n")
        print("| dictionary | ratio |")
        print("|---:|---:|")
        for d in res["dict_sweep"]:
            label = "none" if d["dict_bytes"] == 0 else f"{d['dict_bytes'] // 1024} KB"
            print(f"| {label} | {d['ratio']:.2f} |")


if __name__ == "__main__":
    main()
