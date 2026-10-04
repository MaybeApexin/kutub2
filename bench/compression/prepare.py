"""Converts OpenITI mARkdown books into the plain page stream the benchmark reads.

Output format, one file per book: UTF-8 text, pages separated by a form feed
(\\f), paragraphs within a page by \\n. This mirrors what src/lib/shamela-reader.ts
gets from shamela.ws's reader (a page is a list of paragraphs), so per-page
blocks in the benchmark correspond to one reader page.

What gets stripped is OpenITI's own markup, not book content: the #META# header,
line-wrap continuations (~~), paragraph/heading markers (#, ### |), milestone
tags (ms0123), and poetry hemistich separators (%~%). Page markers (PageV01P023)
become page breaks.

Usage: python3 prepare.py <in_dir> <out_dir>
"""

import re
import sys
from pathlib import Path

HEADER_END = "#META#Header#End#"
PAGE_MARKER = re.compile(r"PageV\d+P\d+")
# Python's \b treats Arabic letters as word characters, so "...نطقms0006" has no
# boundary before "ms" — use an explicit not-a-Latin-letter lookbehind instead.
MILESTONE = re.compile(r"(?<![A-Za-z])ms\d+")
LINE_PREFIX = re.compile(r"^(?:#+\s*)?(?:\|+\s*)?(?:[A-Z]+\|\s*)?")
INLINE_TAGS = re.compile(r"%~%|@[A-Z]+\d*@|\|[A-Z]+\|")


def convert(raw: str) -> str:
    end = raw.find(HEADER_END)
    body = raw[end + len(HEADER_END) :] if end >= 0 else raw
    body = body.replace("\r\n", "\n")
    body = re.sub(r"\n~~", " ", body)

    pages = []
    for chunk in PAGE_MARKER.split(body):
        chunk = MILESTONE.sub(" ", chunk)
        chunk = INLINE_TAGS.sub(" ", chunk)
        paragraphs = []
        for line in chunk.split("\n"):
            line = LINE_PREFIX.sub("", line.strip())
            line = re.sub(r"\s+", " ", line).strip()
            if line:
                paragraphs.append(line)
        if paragraphs:
            pages.append("\n".join(paragraphs))
    return "\f".join(pages)


def main() -> None:
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    src, dst = Path(sys.argv[1]), Path(sys.argv[2])
    dst.mkdir(parents=True, exist_ok=True)
    for path in sorted(src.glob("*.txt")):
        text = convert(path.read_text(encoding="utf-8"))
        (dst / path.name).write_text(text, encoding="utf-8")
        print(f"{path.name}: {text.count(chr(12)) + 1} pages, {len(text.encode()):,} bytes", file=sys.stderr)


if __name__ == "__main__":
    main()
