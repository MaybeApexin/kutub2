"""Downloads a reproducible sample of Shamela-sourced books from the OpenITI corpus.

The repo's own scraper (src/shamela) stores only the catalog (titles, authors,
URIs), not book text, and pulling whole books page by page from shamela.ws is
slow and heavy on their server. OpenITI (https://github.com/OpenITI) republishes
thousands of Shamela books as single text files, tagged with their Shamela id,
so this script samples from those instead.

Two disjoint sets are written:
  <out>/test/   books the benchmark is measured on, stratified by size
  <out>/train/  different books, used only to train the zstd dictionary, so the
                dictionary never sees the text it is later scored on

Usage: python3 fetch_openiti.py [--out data]
"""

import argparse
import csv
import random
import sys
import urllib.request
from pathlib import Path

METADATA_URL = (
    "https://raw.githubusercontent.com/OpenITI/kitab-metadata-automation/"
    "master/output/OpenITI_Github_clone_metadata_light.csv"
)

# (min chars, max chars, how many books) — chosen to cover a short risala up to
# a multi-volume sharh, since whole-file ratios depend heavily on book size.
TEST_BINS = [(50e3, 300e3, 6), (300e3, 2e6, 8), (2e6, 10e6, 8), (10e6, 40e6, 4)]
TRAIN_BIN = (200e3, 3e6, 30)


def download(url: str, dest: Path) -> None:
    if dest.exists() and dest.stat().st_size > 0:
        return
    dest.parent.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(url, timeout=300) as res:
        dest.write_bytes(res.read())


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="data")
    args = ap.parse_args()
    out = Path(args.out)

    meta_path = out / "openiti-metadata.csv"
    print("Fetching OpenITI metadata...", file=sys.stderr)
    download(METADATA_URL, meta_path)

    csv.field_size_limit(10**9)
    with meta_path.open(encoding="utf-8") as f:
        rows = [
            r
            for r in csv.DictReader(f, delimiter="\t")
            if r["id"].startswith("Shamela") and r["status"] == "pri" and r["char_length"].isdigit()
        ]

    rng = random.Random(42)
    test = []
    for lo, hi, n in TEST_BINS:
        test += rng.sample([r for r in rows if lo <= int(r["char_length"]) < hi], n)

    test_books = {r["book"] for r in test}
    rng = random.Random(7)
    lo, hi, n = TRAIN_BIN
    train = rng.sample(
        [r for r in rows if lo <= int(r["char_length"]) < hi and r["book"] not in test_books], n
    )

    for split, chosen in (("test", test), ("train", train)):
        for i, r in enumerate(chosen, 1):
            print(f"[{split} {i}/{len(chosen)}] {r['versionUri']}", file=sys.stderr)
            download(r["url"], out / "openiti" / split / f"{r['versionUri']}.txt")


if __name__ == "__main__":
    main()
