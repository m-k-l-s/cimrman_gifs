"""Build the website catalog from the preserved, curated Giphy metadata."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import tempfile
from collections.abc import Iterable, Iterator
from contextlib import contextmanager
from dataclasses import asdict, dataclass
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SOURCE = ROOT / "resources/cimrman_id_url.json"
DEFAULT_OUTPUT = ROOT / "public/catalog.json"
MEDIA_ORIGIN = "https://media.giphy.com/media"
ID_PATTERN = re.compile(r"[A-Za-z0-9]+")
KEYWORD_CORRECTIONS: dict[str, str | None] = {
    "smojlak": "smoljak",
    "bruckner": "brukner",
    "brunker": "brukner",
    "wiegel": "weigel",
    "ctenisverak": None,
    "vlasysverak": None,
    "sveraknarozeniny": None,
    "tokazdyvi": None,
    "ahasverak": None,
    "notaktojo": None,
    "nojovlastne": None,
    "anoano": None,
    "poctasverak": None,
    "kromeme": None,
    "zlaterucicky": None,
    "travoltasverak": None,
    "sveraklooking": None,
}


@dataclass(frozen=True)
class Clip:
    id: str
    url: str
    keywords: tuple[str, ...]
    webp: str
    gif: str
    mp4: str


def unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"Duplicate JSON key: {key!r}")
        result[key] = value
    return result


def load_catalog(source: Path) -> tuple[Clip, ...]:
    raw: object = json.loads(source.read_text(encoding="utf-8"), object_pairs_hook=unique_object)
    return parse_catalog(raw)


def parse_catalog(raw: object) -> tuple[Clip, ...]:
    if not isinstance(raw, dict) or not raw:
        raise ValueError("Source must be a nonempty JSON object keyed by Giphy ID")

    clips: list[Clip] = []
    urls: set[str] = set()
    for clip_id, record in sorted(raw.items()):
        if not isinstance(clip_id, str) or not ID_PATTERN.fullmatch(clip_id):
            raise ValueError(f"Invalid Giphy ID: {clip_id!r}")
        if not isinstance(record, dict) or set(record) != {"url", "keywords"}:
            raise ValueError(f"{clip_id}: expected exactly 'url' and 'keywords' fields")

        url = record["url"]
        if not isinstance(url, str):
            raise ValueError(f"{clip_id}: URL must be a string")
        parts = urlsplit(url)
        if (
            parts.scheme != "https"
            or parts.netloc != "giphy.com"
            or not parts.path.startswith("/gifs/")
            or not parts.path.removeprefix("/gifs/").endswith(clip_id)
            or parts.query
            or parts.fragment
        ):
            raise ValueError(f"{clip_id}: expected an HTTPS Giphy page URL ending in its ID")
        if url in urls:
            raise ValueError(f"{clip_id}: duplicate Giphy page URL")
        urls.add(url)

        keywords = record["keywords"]
        if not isinstance(keywords, list) or not all(
            isinstance(keyword, str) and keyword.strip() for keyword in keywords
        ):
            raise ValueError(f"{clip_id}: keywords must be a list of nonempty strings")
        clips.append(
            Clip(
                id=clip_id,
                url=url,
                keywords=tuple(keywords),
                webp=f"{MEDIA_ORIGIN}/{clip_id}/200w.webp",
                gif=f"{MEDIA_ORIGIN}/{clip_id}/giphy.gif",
                mp4=f"{MEDIA_ORIGIN}/{clip_id}/giphy.mp4",
            )
        )
    return tuple(clips)


def correct_keyword(keyword: str) -> str | None:
    return KEYWORD_CORRECTIONS.get(keyword, keyword)


def clean_keywords(keywords: Iterable[str]) -> tuple[str, ...]:
    return tuple(
        dict.fromkeys(
            corrected for keyword in keywords if (corrected := correct_keyword(keyword)) is not None
        )
    )


def serialize_catalog(clips: tuple[Clip, ...]) -> bytes:
    records = [{**asdict(clip), "keywords": clean_keywords(clip.keywords)} for clip in clips]
    return (json.dumps(records, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")


@contextmanager
def staged_write(destination: Path, content: bytes) -> Iterator[Path | None]:
    if destination.exists() and not destination.is_file():
        raise OSError(f"Output is not a regular file: {destination}")
    if destination.is_file() and destination.read_bytes() == content:
        yield None
        return
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            dir=destination.parent, prefix=f".{destination.name}.", delete=False
        ) as output:
            temporary = Path(output.name)
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
        temporary.chmod(0o644)
        yield temporary
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def atomic_write(destination: Path, content: bytes) -> bool:
    with staged_write(destination, content) as temporary:
        if temporary is None:
            return False
        temporary.replace(destination)
        return True


def build_catalog(source: Path, output: Path, *, check: bool = False) -> int:
    if source.resolve() == output.resolve():
        raise ValueError("Output must not overwrite the curated source")
    clips = load_catalog(source)
    content = serialize_catalog(clips)
    if check:
        if not output.is_file() or output.read_bytes() != content:
            print(f"Catalog is missing or stale: {output}", file=sys.stderr)
            return 1
        print(f"Catalog is current: {len(clips)} clips; all source entries preserved")
        return 0
    changed = atomic_write(output, content)
    status = "Wrote" if changed else "Unchanged"
    print(f"{status} {output}: {len(clips)} clips; all source entries preserved")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    build = commands.add_parser("build", help="Validate and atomically build the JSON catalog")
    build.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    build.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    build.add_argument("--check", action="store_true", help="Fail on stale output; never write")
    options = parser.parse_args(argv)
    try:
        return build_catalog(options.source, options.output, check=options.check)
    except (OSError, ValueError) as error:
        print(f"catalog: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
