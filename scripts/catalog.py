"""Build the website catalog from its source snapshot and curated keywords."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import tempfile
from collections.abc import Iterable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from itertools import combinations
from pathlib import Path
from urllib.parse import urlsplit

from scripts.policy import PROGRAMME_RULES, PUBLISHER_ALIASES, fold_text

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SOURCE = ROOT / "resources/cimrman_id_url.json"
DEFAULT_SNAPSHOT = ROOT / "resources/giphy.json"
DEFAULT_OUTPUT = ROOT / "public/catalog.json"
ID_PATTERN = re.compile(r"[A-Za-z0-9]+")
CATEGORY_PATTERN = re.compile(r"[a-z0-9][a-z0-9-]*")
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
TITLE_BOILERPLATE = frozenset(
    {
        "animated",
        "gif",
        "gifs",
        "sticker",
        "stickers",
        "by",
        "ceska",
        "televize",
        "ceskatelevize",
        "czechtv",
    }
)


@dataclass(frozen=True)
class Clip:
    id: str
    url: str
    keywords: tuple[str, ...]


@dataclass(frozen=True)
class Category:
    id: str
    label: str


@dataclass(frozen=True)
class SnapshotGif:
    id: str
    url: str
    title: str
    tags: tuple[str, ...]
    category_ids: tuple[str, ...]


@dataclass(frozen=True)
class Snapshot:
    categories: tuple[Category, ...]
    gifs: tuple[SnapshotGif, ...]


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
            or not parts.path.startswith(("/gifs/", "/stickers/"))
            or not parts.path.endswith(clip_id)
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


def effective_keywords(curated: Clip | None, source: SnapshotGif | None) -> tuple[str, ...]:
    category_ids = set(source.category_ids) if source else set()
    if curated is not None:
        category_ids.add("cimrmani")
    selected = curated.keywords if curated is not None else source.tags if source else ()
    excluded = set(PUBLISHER_ALIASES)
    for category_id in category_ids:
        excluded.add(fold_text(category_id))
        if rule := PROGRAMME_RULES.get(category_id):
            excluded.update(fold_text(tag) for tag in (*rule.tags, *rule.common_tags, rule.label))
    result: list[str] = []
    for keyword in clean_keywords(selected):
        key = fold_text(keyword)
        if key and key not in excluded:
            result.append(keyword)
            excluded.add(key)
    return tuple(result)


def review_catalog(clips: tuple[Clip, ...], snapshot: Snapshot) -> dict[str, list[str]]:
    curated = {clip.id: clip for clip in clips}
    missing_text: list[str] = []
    for clip in snapshot.gifs:
        title = fold_text(clip.title)
        words = set(re.findall(r"\w+", title))
        if not effective_keywords(curated.get(clip.id), clip) and words <= TITLE_BOILERPLATE:
            missing_text.append(clip.id)
    return {
        "uncategorizedIds": sorted(clip.id for clip in snapshot.gifs if not clip.category_ids),
        "missingSearchTextIds": sorted(missing_text),
    }


def parse_snapshot(raw: object, *, allow_legacy_tags: bool = False) -> Snapshot:
    if not isinstance(raw, dict) or set(raw) != {"categories", "gifs"}:
        raise ValueError("Snapshot must contain exactly categories and gifs")
    if not isinstance(raw["categories"], list) or not isinstance(raw["gifs"], list):
        raise ValueError("Snapshot categories and gifs must be arrays")
    categories: dict[str, Category] = {}
    for category in raw["categories"]:
        if not isinstance(category, dict) or set(category) != {"id", "label"}:
            raise ValueError("Category must contain exactly id and label")
        category_id, label = category["id"], category["label"]
        if not isinstance(category_id, str) or not CATEGORY_PATTERN.fullmatch(category_id):
            raise ValueError("Invalid category ID")
        if not isinstance(label, str) or not label.strip() or category_id in categories:
            raise ValueError("Invalid or duplicate category")
        categories[category_id] = Category(category_id, label)
    gifs: dict[str, SnapshotGif] = {}
    for record in raw["gifs"]:
        fields = {"id", "url", "title", "tags", "categoryIds"}
        if not isinstance(record, dict) or (
            set(record) != fields and not (allow_legacy_tags and set(record) == fields - {"tags"})
        ):
            raise ValueError(
                "Snapshot GIF must contain exactly id, url, title, tags and categoryIds"
            )
        clip_id, title, memberships = record["id"], record["title"], record["categoryIds"]
        tags = record.get("tags", [])
        if not isinstance(clip_id, str) or clip_id in gifs or not isinstance(title, str):
            raise ValueError("Invalid or duplicate snapshot GIF")
        clip = parse_catalog({clip_id: {"url": record["url"], "keywords": []}})[0]
        if not isinstance(tags, list) or not all(isinstance(tag, str) for tag in tags):
            raise ValueError(f"{clip_id}: invalid raw tags")
        if not isinstance(memberships, list) or not all(
            isinstance(value, str) and value in categories for value in memberships
        ):
            raise ValueError(f"{clip_id}: unknown or invalid categoryIds")
        gifs[clip_id] = SnapshotGif(
            clip_id, clip.url, title, tuple(tags), tuple(sorted(set(memberships)))
        )
    return Snapshot(
        tuple(categories[key] for key in sorted(categories)),
        tuple(gifs[key] for key in sorted(gifs)),
    )


def load_snapshot(path: Path, *, allow_legacy_tags: bool = False) -> Snapshot:
    return parse_snapshot(
        json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=unique_object),
        allow_legacy_tags=allow_legacy_tags,
    )


def snapshot_document(snapshot: Snapshot) -> dict[str, object]:
    return {
        "categories": [
            {"id": category.id, "label": category.label} for category in snapshot.categories
        ],
        "gifs": [
            {
                "id": clip.id,
                "url": clip.url,
                "title": clip.title,
                "tags": list(clip.tags),
                "categoryIds": list(clip.category_ids),
            }
            for clip in snapshot.gifs
        ],
    }


def snapshot_bytes(snapshot: Snapshot) -> bytes:
    return (json.dumps(snapshot_document(snapshot), ensure_ascii=False, indent=2) + "\n").encode(
        "utf-8"
    )


def serialize_catalog(clips: tuple[Clip, ...], snapshot: Snapshot) -> bytes:
    curated = {clip.id: clip for clip in clips}
    remote = {clip.id: clip for clip in snapshot.gifs}
    categories = {category.id: category.label for category in snapshot.categories}
    categories["cimrmani"] = PROGRAMME_RULES["cimrmani"].label
    records: list[dict[str, object]] = []
    for clip_id in sorted(curated.keys() | remote.keys()):
        old, current = curated.get(clip_id), remote.get(clip_id)
        memberships = set(current.category_ids) if current else set()
        if old:
            memberships.add("cimrmani")
        records.append(
            {
                "id": clip_id,
                "url": old.url if old else remote[clip_id].url,
                "title": current.title if current else "",
                "categoryIds": sorted(memberships),
                "keywords": effective_keywords(old, current),
            }
        )
    document = {
        "categories": [{"id": key, "label": categories[key]} for key in sorted(categories)],
        "gifs": records,
    }
    return (json.dumps(document, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")


def require_distinct_paths(*paths: Path) -> None:
    if len({path.resolve() for path in paths}) != len(paths) or any(
        first.exists() and second.exists() and first.samefile(second)
        for first, second in combinations(paths, 2)
    ):
        raise ValueError("Input/output paths must be distinct; refusing to overwrite an input")


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


def build_catalog(
    source: Path, output: Path, *, snapshot_path: Path = DEFAULT_SNAPSHOT, check: bool = False
) -> int:
    require_distinct_paths(source, snapshot_path, output)
    clips = load_catalog(source)
    snapshot = load_snapshot(snapshot_path)
    content = serialize_catalog(clips, snapshot)
    count = len({clip.id for clip in clips} | {clip.id for clip in snapshot.gifs})
    if check:
        if not output.is_file() or output.read_bytes() != content:
            print(f"Catalog is missing or stale: {output}", file=sys.stderr)
            return 1
        print(f"Catalog is current: {count} clips; all curated entries preserved")
        return 0
    changed = atomic_write(output, content)
    status = "Wrote" if changed else "Unchanged"
    print(f"{status} {output}: {count} clips; all curated entries preserved")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    build = commands.add_parser("build", help="Validate and atomically build the JSON catalog")
    build.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    build.add_argument("--snapshot", type=Path, default=DEFAULT_SNAPSHOT)
    build.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    build.add_argument("--check", action="store_true", help="Fail on stale output; never write")
    options = parser.parse_args(argv)
    try:
        return build_catalog(
            options.source, options.output, snapshot_path=options.snapshot, check=options.check
        )
    except (OSError, ValueError) as error:
        print(f"catalog: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
