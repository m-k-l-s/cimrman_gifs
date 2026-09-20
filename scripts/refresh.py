"""Discover clips through official Giphy search while preserving curated keywords."""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from http.client import HTTPException
from itertools import combinations
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from scripts.catalog import (
    DEFAULT_SOURCE,
    ROOT,
    Clip,
    atomic_write,
    clean_keywords,
    correct_keyword,
    load_catalog,
    parse_catalog,
    staged_write,
)

COLLECTION_URL = "https://giphy.com/ceska_televize/cimrmani"
API_URL = "https://api.giphy.com/v1/gifs/search"
SEARCH_QUERY = "cimrman"
CHANNEL_ID = "26940091"
PAGE_SIZE = 50
MAX_OFFSET = 4999
DEFAULT_REPORT = ROOT / "resources/refresh-report.json"
DEFAULT_IGNORE = ROOT / "resources/ignore_list.csv"
MAX_RESPONSE_BYTES = 8 * 1024 * 1024
TIMEOUT_SECONDS = 30


@dataclass(frozen=True)
class RemoteClip:
    id: str
    url: str


@dataclass(frozen=True)
class SearchScan:
    clips: tuple[RemoteClip, ...]
    pages: int
    rows: int
    total: int
    duplicate_ids: tuple[str, ...]


def load_api_key(key_file: Path = ROOT / "API_KEY") -> str:
    key = os.environ.get("GIPHY_API_KEY", "").strip()
    if not key and key_file.is_file():
        key = key_file.read_text(encoding="utf-8").strip()
    if not key:
        raise ValueError("Set GIPHY_API_KEY or put your API key in the ignored API_KEY file")
    return key


def read_page(api_key: str, offset: int) -> object:
    query = urlencode(
        {
            "api_key": api_key,
            "q": SEARCH_QUERY,
            "channel_ids": CHANNEL_ID,
            "limit": PAGE_SIZE,
            "offset": offset,
        }
    )
    request = Request(
        f"{API_URL}?{query}",
        headers={"Accept": "application/json", "User-Agent": "cimrman-gifs-local-refresh/0.1"},
    )
    try:
        with urlopen(request, timeout=TIMEOUT_SECONDS) as response:
            if response.headers.get_content_type() != "application/json":
                raise ValueError("Giphy API did not return JSON")
            body = response.read(MAX_RESPONSE_BYTES + 1)
    except HTTPError as error:
        raise ValueError(f"Giphy API returned HTTP {error.code}") from None
    except (OSError, HTTPException) as error:
        raise ValueError(f"Giphy API request failed ({type(error).__name__})") from None
    if len(body) > MAX_RESPONSE_BYTES:
        raise ValueError(f"API page exceeds the {MAX_RESPONSE_BYTES}-byte response limit")
    try:
        return json.loads(body)
    except ValueError:
        raise ValueError("Giphy API returned invalid JSON") from None


def parse_remote_clip(raw: object) -> RemoteClip:
    if not isinstance(raw, dict):
        raise ValueError("API record must be an object")
    clip_id = raw.get("id")
    if not isinstance(clip_id, str):
        raise ValueError("API record has an invalid ID")
    url = raw.get("url")
    if isinstance(url, str) and url.startswith("http://giphy.com/"):
        url = "https://" + url.removeprefix("http://")
    clip = parse_catalog({clip_id: {"url": url, "keywords": []}})[0]
    return RemoteClip(clip.id, clip.url)


def fetch_search(fetch: Callable[[int], object]) -> SearchScan:
    clips: dict[str, RemoteClip] = {}
    duplicates: set[str] = set()
    offset = 0
    pages = 0
    expected_count: int | None = None
    while True:
        page = fetch(offset)
        if not isinstance(page, dict) or not isinstance(page.get("data"), list):
            raise ValueError("API page is missing its data array")
        meta, pagination = page.get("meta"), page.get("pagination")
        if not isinstance(meta, dict) or meta.get("status") != 200:
            raise ValueError("Giphy API reported an unsuccessful response")
        if not isinstance(pagination, dict) or not all(
            isinstance(pagination.get(key), int)
            and not isinstance(pagination[key], bool)
            and pagination[key] >= 0
            for key in ("count", "offset", "total_count")
        ):
            raise ValueError("API page has invalid pagination")
        count, total = pagination["count"], pagination["total_count"]
        results = page["data"]
        if pagination["offset"] != offset or count != len(results) or offset + count > total:
            raise ValueError("API pagination does not match the requested result window")
        if total > MAX_OFFSET + 1:
            raise ValueError(
                f"Search reports {total} results, beyond the API's {MAX_OFFSET + 1}-result window; "
                "refusing an incomplete refresh"
            )
        if expected_count is not None and total != expected_count:
            raise ValueError("Search count changed during refresh; retry the whole scan")
        expected_count = total
        if not results and offset < total:
            raise ValueError("Search ended before its reported total")
        previous_count = len(clips)
        for raw in results:
            clip = parse_remote_clip(raw)
            if clip.id in clips:
                if clip != clips[clip.id]:
                    raise ValueError(f"{clip.id}: conflicting duplicate records during search")
                duplicates.add(clip.id)
            clips[clip.id] = clip
        offset += count
        pages += 1
        print(f"Search page {pages}: {count} records ({offset}/{total})", file=sys.stderr)
        if offset >= total:
            return SearchScan(
                tuple(clips.values()), pages, offset, total, tuple(sorted(duplicates))
            )
        if len(clips) == previous_count:
            raise ValueError("Search page adds no new IDs; refusing a nonprogressing scan")


def merge_search(
    existing: tuple[Clip, ...], scan: SearchScan, ignored: set[str]
) -> tuple[dict[str, object], dict[str, object]]:
    original = {clip.id: clip for clip in existing}
    incoming = {clip.id: clip for clip in scan.clips}
    merged: dict[str, object] = {}
    corrections: list[dict[str, str | None]] = []
    ignored_new = sorted((set(incoming) - set(original)) & ignored)
    new_ids: list[str] = []
    needs_review: list[str] = []
    for clip_id in sorted(set(original) | set(incoming)):
        old, remote = original.get(clip_id), incoming.get(clip_id)
        if old is None and clip_id in ignored:
            continue
        if old is None:
            new_ids.append(clip_id)
        original_keywords = list(old.keywords) if old is not None else []
        keywords = list(clean_keywords(original_keywords))
        if not keywords:
            needs_review.append(clip_id)
        for keyword in dict.fromkeys(original_keywords):
            corrected = correct_keyword(keyword)
            if corrected != keyword:
                corrections.append({"id": clip_id, "from": keyword, "to": corrected})
        if old is not None:
            url = old.url
        elif remote is not None:
            url = remote.url
        else:
            raise ValueError("Cannot merge a record without either source")
        merged[clip_id] = {"url": url, "keywords": keywords}
    report: dict[str, object] = {
        "checkedAt": datetime.now(UTC).isoformat(timespec="seconds"),
        "source": COLLECTION_URL,
        "endpoint": API_URL,
        "query": SEARCH_QUERY,
        "channelId": CHANNEL_ID,
        "searchComplete": True,
        "collectionComplete": False,
        "reportedSearchTotal": scan.total,
        "pages": scan.pages,
        "sourceRows": scan.rows,
        "sourceCount": len(incoming),
        "historicalCount": len(original),
        "catalogCount": len(merged),
        "newIds": new_ids,
        "notFoundInSearch": sorted(set(original) - set(incoming)),
        "ignoredNewIds": ignored_new,
        "duplicateSourceIds": list(scan.duplicate_ids),
        "keywordCorrections": corrections,
        "needsKeywordReview": needs_review,
        "policy": (
            "Curated keywords use the exact correction/removal policy; "
            "new clips need manual keywords. "
            "Search coverage does not establish complete collection membership "
            "or media availability."
        ),
    }
    return merged, report


def refresh_catalog(
    source: Path,
    report_path: Path,
    ignore_path: Path,
    *,
    fetch: Callable[[int], object],
) -> dict[str, object]:
    paths = (source, report_path, ignore_path)
    if len({path.resolve() for path in paths}) != len(paths) or any(
        first.exists() and second.exists() and first.samefile(second)
        for first, second in combinations(paths, 2)
    ):
        raise ValueError("Source, report and ignore paths must be distinct")
    if report_path.exists() and not report_path.is_file():
        raise OSError(f"Report is not a regular file: {report_path}")
    original_bytes = source.read_bytes()
    existing = load_catalog(source)
    ignored = set(ignore_path.read_text(encoding="utf-8").split())
    scan = fetch_search(fetch)
    merged, report = merge_search(existing, scan, ignored)
    parse_catalog(merged)
    content = (json.dumps(merged, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode(
        "utf-8"
    )
    report_content = (json.dumps(report, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    with (
        staged_write(source, content) as source_temp,
        staged_write(report_path, report_content) as report_temp,
    ):
        if source.read_bytes() != original_bytes:
            raise ValueError(
                "Curated source changed during refresh; refusing to overwrite concurrent edits"
            )
        if source_temp is not None:
            source_temp.replace(source)
        try:
            if report_temp is not None:
                report_temp.replace(report_path)
        except OSError as report_error:
            if source_temp is not None:
                try:
                    current = source.read_bytes()
                except OSError as read_error:
                    raise OSError(
                        "Report replacement failed after source update; "
                        f"source cannot be checked for rollback: {read_error}"
                    ) from report_error
                if current != content:
                    raise OSError(
                        "Report replacement failed after source update; "
                        "source changed again; not rolled back"
                    ) from report_error
                try:
                    atomic_write(source, original_bytes)
                except OSError as rollback_error:
                    raise OSError(
                        "Report replacement failed after source update; "
                        f"source rollback failed: {rollback_error}"
                    ) from report_error
            raise
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    parser.add_argument("--ignore", type=Path, default=DEFAULT_IGNORE)
    options = parser.parse_args(argv)
    try:
        key = load_api_key()
        report = refresh_catalog(
            options.source,
            options.report,
            options.ignore,
            fetch=lambda offset: read_page(key, offset),
        )
    except (OSError, ValueError) as error:
        print(f"refresh: {error}", file=sys.stderr)
        return 1
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
