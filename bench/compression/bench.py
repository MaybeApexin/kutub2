"""Benchmarks general-purpose compressors on Arabic book text, whole-file and per-block.

Reads books produced by prepare.py (pages separated by \\f) and, for each codec
and each block granularity, measures:

  ratio            original bytes / stored bytes. Block layouts include a 4-byte
                   offset per block (the index needed to find a block), so the
                   ratio is what a block store would actually cost on disk.
  compress MB/s    original bytes per second of compression.
  decode MB/s      original bytes per second when decoding the whole book.
  random access    time to get one random page's block back to text, plus the
                   compressed bytes that have to be fetched for it. For a
                   whole-file layout that is the entire book.

The zstd dictionary is trained on a separate set of books (prepare.py output
for the "train" split), never on the books it is scored on. Its size is
reported separately: it is shipped once per library, not per book.

Usage: python3 bench.py --test <pages/test> --train <pages/train> --out <dir>
"""

import argparse
import json
import random
import statistics
import sys
import time
import zlib
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import brotli
import zstandard as zstd

INDEX_BYTES_PER_BLOCK = 4
RANDOM_ACCESS_SAMPLES = 200
DICT_SIZE = 112_640  # zstd's own default (--maxdict 110KB)

# Granularity name -> target uncompressed block size in bytes. Blocks are built
# from whole pages, so a page never straddles two blocks; "page" is one reader
# page per block, "whole" is the entire book as one stream.
GRANULARITIES = {"page": 0, "4k": 4096, "16k": 16384, "64k": 65536, "whole": None}

_dict_bytes: bytes | None = None


def deflate(level):
    # Raw deflate (wbits=-15): gzip's 18-byte header/trailer would be pure
    # overhead per block and isn't needed when the container has its own index.
    def c(b):
        o = zlib.compressobj(level, zlib.DEFLATED, -15)
        return o.compress(b) + o.flush()

    return c, lambda b: zlib.decompress(b, -15)


def brotli_codec(quality):
    return (lambda b: brotli.compress(b, quality=quality, lgwin=24)), brotli.decompress


def zstd_codec(level, use_dict=False, long=False):
    d = zstd.ZstdCompressionDict(_dict_bytes) if use_dict else None
    if long:
        params = zstd.ZstdCompressionParameters.from_level(
            level, window_log=27, enable_ldm=True, write_dict_id=False, write_checksum=False
        )
        cctx = zstd.ZstdCompressor(compression_params=params)
    else:
        cctx = zstd.ZstdCompressor(level=level, dict_data=d, write_dict_id=False)
    dctx = zstd.ZstdDecompressor(dict_data=d, max_window_size=1 << 27)
    return cctx.compress, dctx.decompress


CODECS = {
    "gzip-6": lambda: deflate(6),
    "gzip-9": lambda: deflate(9),
    "brotli-5": lambda: brotli_codec(5),
    "brotli-11": lambda: brotli_codec(11),
    "zstd-3": lambda: zstd_codec(3),
    "zstd-19": lambda: zstd_codec(19),
    "zstd-19-long": lambda: zstd_codec(19, long=True),
    "zstd-3+dict": lambda: zstd_codec(3, use_dict=True),
    "zstd-19+dict": lambda: zstd_codec(19, use_dict=True),
}
# Long-range matching only differs from plain zstd-19 once the input outgrows
# the normal window, so it's only worth running on whole files.
WHOLE_ONLY = {"zstd-19-long"}


def read_pages(path: Path) -> list[bytes]:
    return [p.encode("utf-8") for p in path.read_text(encoding="utf-8").split("\f")]


def make_blocks(pages: list[bytes], target: int | None) -> tuple[list[bytes], list[int]]:
    """Packs pages into blocks of at least `target` bytes. Returns the blocks and,
    for each page, the index of the block holding it."""
    if target is None:
        return [b"\f".join(pages)], [0] * len(pages)
    blocks, page_to_block, cur = [], [], []
    size = 0
    for p in pages:
        cur.append(p)
        size += len(p) + 1
        page_to_block.append(len(blocks))
        if size >= target:
            blocks.append(b"\f".join(cur))
            cur, size = [], 0
    if cur:
        blocks.append(b"\f".join(cur))
    return blocks, page_to_block


def timed(fn, *args):
    t = time.perf_counter()
    r = fn(*args)
    return r, time.perf_counter() - t


def bench_book(args) -> list[dict]:
    path, dict_bytes, codec_names = args
    global _dict_bytes
    _dict_bytes = dict_bytes
    pages = read_pages(Path(path))
    rng = random.Random(path.name)
    sample_pages = [rng.randrange(len(pages)) for _ in range(RANDOM_ACCESS_SAMPLES)]
    rows = []

    for gran, target in GRANULARITIES.items():
        blocks, page_to_block = make_blocks(pages, target)
        raw = sum(len(b) for b in blocks)
        chars = len(b"\f".join(pages).decode("utf-8"))
        for name in codec_names:
            if name in WHOLE_ONLY and target is not None:
                continue
            compress, decompress = CODECS[name]()
            comp, t_comp = timed(lambda: [compress(b) for b in blocks])
            out, t_dec = timed(lambda: [decompress(c) for c in comp])
            assert out == blocks, f"{name} round-trip failed on {path.name}"
            # Single sub-second runs are noisy; keep the best of three for those.
            if t_dec < 1:
                t_dec = min([t_dec] + [timed(lambda: [decompress(c) for c in comp])[1] for _ in range(2)])
            stored = sum(len(c) for c in comp) + (INDEX_BYTES_PER_BLOCK * len(blocks) if target is not None else 0)

            if target is None:
                # Reading any one page means decoding the whole book.
                ra_times = [t_dec]
                ra_bytes = [len(comp[0])]
            else:
                ra_times, ra_bytes = [], []
                for pi in sample_pages:
                    c = comp[page_to_block[pi]]
                    _, t = timed(decompress, c)
                    ra_times.append(t)
                    ra_bytes.append(len(c))

            rows.append(
                {
                    "book": path.stem,
                    "codec": name,
                    "granularity": gran,
                    "raw_bytes": raw,
                    "raw_chars": chars,
                    "stored_bytes": stored,
                    "blocks": len(blocks),
                    "compress_s": t_comp,
                    "decode_s": t_dec,
                    "ra_median_us": statistics.median(ra_times) * 1e6,
                    "ra_p95_us": (statistics.quantiles(ra_times, n=20)[-1] if len(ra_times) > 1 else ra_times[0]) * 1e6,
                    "ra_median_bytes": statistics.median(ra_bytes),
                }
            )
    print(f"done {path.stem}", file=sys.stderr, flush=True)
    return rows


def train_dictionary(train_dir: Path, size: int) -> bytes:
    samples = [p for f in sorted(train_dir.glob("*.txt")) for p in read_pages(f) if p]
    d = zstd.train_dictionary(size, samples, threads=-1)
    return d.as_bytes()


def dict_size_sweep(test_files: list[Path], train_dir: Path) -> list[dict]:
    """Page-level zstd-19 ratio across dictionary sizes, plus the no-dictionary baseline."""
    pages = [p for f in test_files for p in read_pages(f)]
    raw = sum(len(p) for p in pages)
    rows = []
    for size in (0, 16_384, 65_536, 112_640, 262_144, 524_288):
        d = zstd.ZstdCompressionDict(train_dictionary(train_dir, size)) if size else None
        cctx = zstd.ZstdCompressor(level=19, dict_data=d, write_dict_id=False)
        stored = sum(len(cctx.compress(p)) + INDEX_BYTES_PER_BLOCK for p in pages)
        rows.append({"dict_bytes": size, "raw_bytes": raw, "stored_bytes": stored, "ratio": raw / stored})
        print(f"dict sweep {size}: {raw / stored:.3f}", file=sys.stderr, flush=True)
    return rows


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--test", required=True, type=Path)
    ap.add_argument("--train", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--codecs", default=",".join(CODECS))
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--skip-dict-sweep", action="store_true")
    args = ap.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)

    test_files = sorted(args.test.glob("*.txt"))
    print(f"Training {DICT_SIZE}-byte dictionary on {args.train}...", file=sys.stderr)
    dict_bytes, t = timed(train_dictionary, args.train, DICT_SIZE)
    print(f"  {len(dict_bytes):,} bytes in {t:.1f}s", file=sys.stderr)
    (args.out / "zstd.dict").write_bytes(dict_bytes)

    codec_names = args.codecs.split(",")
    # Biggest books first so the pool doesn't end on one long straggler.
    jobs = [(f, dict_bytes, codec_names) for f in sorted(test_files, key=lambda f: -f.stat().st_size)]
    rows = []
    with ProcessPoolExecutor(args.workers) as pool:
        for r in pool.map(bench_book, jobs):
            rows += r

    results = {"dict_bytes": len(dict_bytes), "dict_train_s": t, "workers": args.workers, "rows": rows}
    if not args.skip_dict_sweep:
        results["dict_sweep"] = dict_size_sweep(test_files, args.train)
    (args.out / "results.json").write_text(json.dumps(results, indent=1))
    print(f"Wrote {args.out / 'results.json'}", file=sys.stderr)


if __name__ == "__main__":
    main()
