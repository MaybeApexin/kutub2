# Compression benchmark for Arabic book text

A small, standalone harness that measures how well general-purpose compressors
handle Shamela book text, both as whole files and as independently decodable
blocks. It is the baseline for a block-based, indexed store: the numbers say how
much each codec saves, how fast it decodes, and what it costs to read one random
page.

It is not wired into the bot or the API, and it doesn't touch `data/` or any
existing code.

## Setup

```bash
python3 -m pip install -r bench/compression/requirements.txt
```

## Running it

```bash
cd bench/compression
python3 fetch_openiti.py --out data                       # ~260 MB download
python3 prepare.py data/openiti/test  data/pages/test
python3 prepare.py data/openiti/train data/pages/train
python3 bench.py --test data/pages/test --train data/pages/train --out data/results
python3 report.py data/results/results.json > data/results/report.md
```

`data/` here is gitignored. A full run on 4 cores takes roughly 15 minutes,
most of it brotli at quality 11. `--codecs zstd-19,zstd-19+dict` and
`--skip-dict-sweep` cut it down for quick iterations.

## Where the text comes from

`src/shamela` stores only the catalog, not book text, and reading whole books
from shamela.ws page by page is slow and heavy on their server.
[OpenITI](https://github.com/OpenITI) republishes thousands of Shamela books as
single files tagged with their Shamela id, so `fetch_openiti.py` samples from
those: 26 test books stratified by size (60 KB to 45 MB), plus 30 different
books used only to train the zstd dictionary. `prepare.py` strips OpenITI's
markup and turns its page markers back into page breaks, so a "page" block is
one shamela.ws reader page.

To benchmark books scraped some other way, write each one as UTF-8 text with
pages separated by `\f` and paragraphs by `\n`, and point `--test` at the folder.

## What is measured

| field | meaning |
|---|---|
| granularity | `page` (one reader page per block), `4k` / `16k` / `64k` (whole pages packed up to that size), `whole` (the book as one stream) |
| ratio | original bytes / stored bytes, including a 4-byte offset per block for the index |
| decode MB/s | throughput decoding the whole book, block by block |
| random page: decode | median time to decode the block that holds a random page |
| random page: fetch | compressed bytes that block costs to download |

Codecs: deflate (gzip's format, without the per-block gzip header) at 6 and 9,
brotli at 5 and 11, zstd at 3 and 19, zstd 19 with long-range matching (whole
files only), and zstd 3 and 19 with a 110 KB dictionary trained on the
separate book set. The dictionary is counted once per library, not per book.
`bench.py` also sweeps dictionary sizes for per-page zstd 19.
