"""Refresh complete public Česká televize feeds while preserving raw source metadata."""

from __future__ import annotations

import argparse
import json
import sys
from collections import deque
from collections.abc import Callable, Iterator
from datetime import UTC, datetime
from http.client import HTTPException
from pathlib import Path
from typing import cast
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlsplit
from urllib.request import Request, urlopen

from scripts.catalog import (
    CATEGORY_PATTERN,
    DEFAULT_SNAPSHOT,
    DEFAULT_SOURCE,
    ID_PATTERN,
    MEDIA_HASH_PATTERN,
    ROOT,
    Category,
    Snapshot,
    SnapshotGif,
    atomic_write,
    catalog_groups,
    load_catalog,
    load_snapshot,
    parse_catalog,
    parse_snapshot,
    require_distinct_paths,
    review_catalog,
    snapshot_bytes,
    snapshot_document,
    staged_write,
)
from scripts.policy import PROGRAMME_RULES

ROOT_CHANNEL = 7699907
USERNAME = "ceska_televize"
DEFAULT_REPORT = ROOT / "resources/refresh-report.json"
PAGE_SIZE = 50
MAX_RESPONSE_BYTES = 8 * 1024 * 1024
TIMEOUT_SECONDS = 30


def endpoint_url(channel_id: int, kind: str, *, offset: int = 0) -> str:
    return (
        f"https://giphy.com/api/v4/channels/{channel_id}/{kind}?offset={offset}&limit={PAGE_SIZE}"
    )


def page_offset(url: str, expected: str) -> int:
    parts, base = urlsplit(url), urlsplit(expected)
    query = parse_qs(parts.query)
    if (
        parts.scheme != "https"
        or parts.netloc != "giphy.com"
        or parts.path.rstrip("/") != base.path.rstrip("/")
        or parts.fragment
        or set(query) != {"offset", "limit"}
        or query["limit"] != [str(PAGE_SIZE)]
        or len(query["offset"]) != 1
        or not query["offset"][0].isdigit()
    ):
        raise ValueError("Pagination left the expected Giphy channel endpoint")
    return int(query["offset"][0])


def read_json(url: str) -> object:
    request = Request(
        url, headers={"Accept": "application/json", "User-Agent": "ct-gifs-refresh/1"}
    )
    try:
        with urlopen(request, timeout=TIMEOUT_SECONDS) as response:
            if response.headers.get_content_type() != "application/json":
                raise ValueError("Giphy channel endpoint did not return JSON")
            body = response.read(MAX_RESPONSE_BYTES + 1)
    except HTTPError as error:
        raise ValueError(f"Giphy channel endpoint returned HTTP {error.code}") from None
    except (OSError, HTTPException) as error:
        raise ValueError(f"Giphy channel request failed ({type(error).__name__})") from None
    if len(body) > MAX_RESPONSE_BYTES:
        raise ValueError(
            f"Giphy page exceeds the explicit {MAX_RESPONSE_BYTES}-byte response limit"
        )
    try:
        return json.loads(body)
    except ValueError:
        raise ValueError("Giphy channel endpoint returned invalid JSON") from None


def iter_records(
    channel_id: int, kind: str, fetch: Callable[[str], object], summaries: list[dict[str, object]]
) -> Iterator[dict[str, object]]:
    first = endpoint_url(channel_id, kind)
    url: str | None = first
    previous_offset = -1
    seen: set[str | int] = set()
    rows = pages = 0
    expected_count: int | None = None
    while url is not None:
        offset = page_offset(url, first)
        if offset <= previous_offset:
            raise ValueError("Giphy pagination did not advance")
        previous_offset = offset
        page = fetch(url)
        if (
            not isinstance(page, dict)
            or not isinstance(page.get("results"), list)
            or "next" not in page
        ):
            raise ValueError("Giphy page is missing results or its explicit pagination boundary")
        next_url, count = page["next"], page.get("count")
        if next_url is not None and (not isinstance(next_url, str) or not next_url):
            raise ValueError("Invalid Giphy pagination URL")
        if next_url is not None and page_offset(next_url, first) != offset + PAGE_SIZE:
            raise ValueError("Giphy pagination skipped or repeated a page window")
        if count is not None:
            if not isinstance(count, int) or isinstance(count, bool) or count < 0:
                raise ValueError("Invalid Giphy total count")
            if expected_count is not None and expected_count != count:
                raise ValueError("Giphy total count changed during the scan")
            expected_count = count
        before = len(seen)
        for record in page["results"]:
            if not isinstance(record, dict) or not isinstance(record.get("id"), (str, int)):
                raise ValueError("Giphy record is missing its ID")
            seen.add(record["id"])
            yield record
        rows += len(page["results"])
        pages += 1
        print(f"Channel {channel_id} {kind}: page {pages}, {rows} records", file=sys.stderr)
        if next_url is not None and len(seen) == before:
            raise ValueError("Giphy page adds no new IDs; refusing an incomplete scan")
        url = next_url
    if expected_count is not None and len(seen) != expected_count:
        raise ValueError(
            f"Channel {channel_id} {kind}: expected {expected_count}, received {len(seen)} IDs"
        )
    summaries.append(
        {
            "channelId": channel_id,
            "kind": kind,
            "pages": pages,
            "rows": rows,
            "uniqueIds": len(seen),
        }
    )


def record_owner(record: dict[str, object]) -> str | None:
    user = record.get("user")
    owner = record.get("username") or (user.get("username") if isinstance(user, dict) else None)
    if owner is not None and not isinstance(owner, str):
        raise ValueError("Invalid Giphy owner field")
    return owner or None


def record_media_hash(record: dict[str, object]) -> str | None:
    images = record.get("images")
    original = images.get("original") if isinstance(images, dict) else None
    value = original.get("hash") if isinstance(original, dict) else None
    if isinstance(value, str) and MEDIA_HASH_PATTERN.fullmatch(value.lower()):
        return value.lower()
    return None


def exclusion_reasons(record: dict[str, object]) -> list[str]:
    owner = record_owner(record)
    reasons: list[str] = []
    if owner is not None and owner != USERNAME:
        reasons.append("foreignOwner")
    for field in ("is_video", "is_hidden", "is_removed", "is_sticker"):
        if field in record and not isinstance(record[field], bool):
            raise ValueError(f"Invalid {field} flag in Giphy record")
    if record.get("is_hidden", False):
        reasons.append("hidden")
    if record.get("is_removed", False):
        reasons.append("removed")
    if record.get("is_video", False):
        reasons.append("nonGif")
    kind = record.get("type")
    if not isinstance(kind, str) or not kind.strip():
        if not reasons:
            raise ValueError("Missing or invalid Giphy type")
        return reasons
    if kind != "gif" and not record.get("is_sticker", False) and "nonGif" not in reasons:
        reasons.append("nonGif")
    return reasons


def collect_inventory(
    fetch: Callable[[str], object],
    previous: Snapshot | None = None,
    *,
    checked_at: datetime | None = None,
) -> tuple[Snapshot, dict[str, object]]:
    previous = previous or Snapshot((), ())
    categories = {category.id: category.label for category in previous.categories}
    metadata: dict[str, tuple[str, str, tuple[str, ...]]] = {}
    media_hashes: dict[str, str] = {}
    memberships: dict[str, set[str]] = {}
    observed: set[str] = set()
    exclusions: dict[str, set[str]] = {}
    stickers: set[str] = set()
    unattributed: set[str] = set()
    programme_matches: dict[str, set[str]] = {}
    top_slugs: set[str] = set()
    summaries: list[dict[str, object]] = []
    channels: set[int] = set()
    pending: deque[tuple[int, str | None, bool]] = deque([(ROOT_CHANNEL, None, True)])
    while pending:
        channel_id, category_id, has_children = pending.popleft()
        if channel_id in channels:
            raise ValueError("Giphy collection tree contains a repeated channel")
        channels.add(channel_id)
        if has_children:
            for child in iter_records(channel_id, "children", fetch, summaries):
                child_id, slug, label = child["id"], child.get("slug"), child.get("display_name")
                nested = child.get("has_children")
                if (
                    not isinstance(child_id, int)
                    or isinstance(child_id, bool)
                    or child_id <= 0
                    or not isinstance(slug, str)
                    or not CATEGORY_PATTERN.fullmatch(slug)
                    or not isinstance(label, str)
                    or not label.strip()
                    or child.get("parent") != channel_id
                    or not isinstance(nested, bool)
                ):
                    raise ValueError("Invalid Giphy child collection")
                top = category_id or slug
                if category_id is None:
                    if top in top_slugs:
                        raise ValueError(f"Duplicate top-level collection slug: {top}")
                    top_slugs.add(top)
                    categories[top] = label
                pending.append((child_id, top, nested))
        for record in iter_records(channel_id, "feed", fetch, summaries):
            clip_id = record["id"]
            if not isinstance(clip_id, str) or not ID_PATTERN.fullmatch(clip_id):
                raise ValueError("Invalid Giphy GIF ID")
            observed.add(clip_id)
            reasons = exclusion_reasons(record)
            for reason in reasons:
                exclusions.setdefault(reason, set()).add(clip_id)
            if reasons:
                if clip_id in metadata:
                    raise ValueError(f"{clip_id}: availability/ownership changed during the scan")
                continue
            if any(clip_id in ids for ids in exclusions.values()):
                raise ValueError(f"{clip_id}: availability/ownership changed during the scan")
            if media_hash := record_media_hash(record):
                if clip_id in media_hashes and media_hashes[clip_id] != media_hash:
                    raise ValueError(f"{clip_id}: original media hash changed during the scan")
                media_hashes[clip_id] = media_hash
            if "title" not in record or "tags" not in record:
                raise ValueError(f"{clip_id}: missing title or tags field")
            if record_owner(record) is None:
                unattributed.add(clip_id)
            url, title, tags = record.get("url"), record["title"], record["tags"]
            if isinstance(url, str) and url.startswith("http://giphy.com/"):
                url = "https://" + url.removeprefix("http://")
            clip = parse_catalog({clip_id: {"url": url, "keywords": []}})[0]
            if (
                not isinstance(title, str)
                or not isinstance(tags, list)
                or not all(isinstance(tag, str) for tag in tags)
            ):
                raise ValueError(f"{clip_id}: invalid title or upstream tags")
            value = (clip.url, title, tuple(tags))
            if clip_id in metadata and metadata[clip_id] != value:
                raise ValueError(f"{clip_id}: metadata changed during the scan")
            metadata[clip_id] = value
            memberships.setdefault(clip_id, set())
            if category_id:
                memberships[clip_id].add(category_id)
            programme_matches.setdefault(clip_id, set()).update(
                programme for programme, rule in PROGRAMME_RULES.items() if rule.tags & set(tags)
            )
            if record.get("is_sticker", False):
                stickers.add(clip_id)
    if not observed:
        raise ValueError("Giphy returned no GIF records; refusing to replace the snapshot")
    old = {clip.id: clip for clip in previous.gifs}
    inferred: dict[str, set[str]] = {}
    conflicts: dict[str, dict[str, list[str]]] = {}
    ambiguous: dict[str, list[str]] = {}
    for clip_id, matches in sorted(programme_matches.items()):
        if memberships[clip_id]:
            if matches - memberships[clip_id]:
                conflicts[clip_id] = {
                    "collectionCategoryIds": sorted(memberships[clip_id]),
                    "tagCategoryIds": sorted(matches),
                }
        elif len(matches) == 1:
            programme = next(iter(matches))
            if programme not in top_slugs:
                categories[programme] = PROGRAMME_RULES[programme].label
            memberships[clip_id].add(programme)
            inferred.setdefault(programme, set()).add(clip_id)
        elif len(matches) > 1:
            ambiguous[clip_id] = sorted(matches)
    inferred_ids = set().union(*inferred.values()) if inferred else set()
    changes = {
        clip_id: {
            "from": list(old[clip_id].category_ids) if clip_id in old else [],
            "to": sorted(memberships[clip_id]),
        }
        for clip_id in sorted(metadata)
        if (clip_id in old or clip_id in inferred_ids)
        and set(old[clip_id].category_ids if clip_id in old else ()) != memberships[clip_id]
    }
    missing = sorted(old.keys() - observed)
    gifs = [
        SnapshotGif(
            clip_id,
            *metadata[clip_id],
            tuple(sorted(memberships[clip_id])),
            original_hash=media_hashes.get(clip_id),
        )
        for clip_id in sorted(metadata)
    ]
    gifs.extend(old[clip_id] for clip_id in missing)
    snapshot = Snapshot(
        tuple(Category(key, categories[key]) for key in sorted(categories)),
        tuple(sorted(gifs, key=lambda clip: clip.id)),
    )
    parse_snapshot(snapshot_document(snapshot))
    report: dict[str, object] = {
        "checkedAt": (checked_at or datetime.now(UTC)).isoformat(timespec="seconds"),
        "source": "https://giphy.com/ceska_televize",
        "sourceKind": "public-website-channel-json",
        "feedTraversalComplete": True,
        "channelsScanned": sorted(channels),
        "feeds": summaries,
        "sourceCount": len(metadata),
        "observedUniqueIds": len(observed),
        "snapshotCount": len(snapshot.gifs),
        "newCount": len(metadata.keys() - old.keys()),
        "preservedMissingIds": missing,
        "exclusions": {reason: sorted(ids) for reason, ids in sorted(exclusions.items())},
        "includedStickerCount": len(stickers),
        "unattributedIds": sorted(unattributed),
        "categoryCounts": {
            category: sum(category in clip.category_ids for clip in snapshot.gifs)
            for category in sorted(categories)
        },
        "tagCategoryRules": {
            programme: {
                "exactTags": sorted(rule.tags),
                "matchedCount": sum(programme in matches for matches in programme_matches.values()),
                "inferredCount": len(inferred.get(programme, set())),
            }
            for programme, rule in sorted(PROGRAMME_RULES.items())
        },
        "membershipChanges": changes,
        "programmeTagConflicts": conflicts,
        "ambiguousProgrammeMatches": ambiguous,
        "reviewNeeded": {
            "missingMediaHashIds": [
                clip.id for clip in snapshot.gifs if clip.original_hash is None
            ],
            "conflictingProgrammeTagIds": sorted(conflicts),
            "ambiguousProgrammeTagIds": sorted(ambiguous),
            "categoryMembershipRemovalIds": [
                clip_id
                for clip_id, change in changes.items()
                if set(change["from"]) - set(change["to"])
            ],
        },
        "policy": (
            "All public account/collection pages traversed; no record cap. "
            "Prior IDs absent from all feeds retained. Explicit known foreign-owner, "
            "non-GIF/video, hidden and removed records excluded from snapshot; stickers included. "
            "Records lacking owner metadata retained with public-feed provenance and reported. "
            "Titles preserved. Exact reviewed programme tags supply a fallback only after all "
            "collection memberships are known and only for a single unambiguous programme. "
            "Collection assignments win; conflicting or ambiguous tags are reported. "
            "Raw tags are preserved in the snapshot; the build uses curated keywords when present "
            "and cleaned source tags otherwise. "
            "Curated keywords take precedence across duplicates. "
            "Equal valid original GIF hashes within each media kind share one catalog entry; "
            "all records stay in the snapshot. Records without a usable hash remain separate "
            "and are reported."
        ),
    }
    return snapshot, report


def refresh_snapshot(
    snapshot_path: Path,
    report_path: Path,
    *,
    curated_path: Path = DEFAULT_SOURCE,
    fetch: Callable[[str], object] = read_json,
    checked_at: datetime | None = None,
) -> dict[str, object]:
    require_distinct_paths(snapshot_path, report_path, curated_path)
    if report_path.exists() and not report_path.is_file():
        raise OSError("Report destination is not a regular file")
    original = snapshot_path.read_bytes() if snapshot_path.exists() else None
    curated_bytes = curated_path.read_bytes()
    curated_clips = load_catalog(curated_path)
    curated = {clip.id for clip in curated_clips}
    previous = (
        load_snapshot(snapshot_path, allow_legacy_tags=True)
        if original is not None
        else Snapshot((), ())
    )
    snapshot, report = collect_inventory(fetch, previous, checked_at=checked_at)
    report["reviewNeeded"] = {
        **review_catalog(curated_clips, snapshot),
        **cast(dict[str, list[str]], report["reviewNeeded"]),
    }
    ids = {clip.id for clip in snapshot.gifs}
    source = {clip.id: clip for clip in snapshot.gifs}
    groups = catalog_groups(curated_clips, snapshot)
    duplicate_groups = [group for group in groups if len(group) > 1]
    excluded = {
        clip_id
        for values in cast(dict[str, list[str]], report["exclusions"]).values()
        for clip_id in values
    }
    report.update(
        {
            "curatedCount": len(curated),
            "catalogCount": len(groups),
            "duplicateMediaCount": sum(len(group) - 1 for group in duplicate_groups),
            "duplicateMediaGroups": [
                {
                    "canonicalId": group[0],
                    "duplicateIds": list(group[1:]),
                    "originalHash": source[group[0]].original_hash,
                }
                for group in duplicate_groups
            ],
            "curatedMissingIds": sorted(curated - ids),
            "curatedRetainedDespiteExclusion": sorted(curated & excluded),
        }
    )
    content = snapshot_bytes(snapshot)
    report_content = (json.dumps(report, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    with (
        staged_write(snapshot_path, content) as staged,
        staged_write(report_path, report_content) as staged_report,
    ):
        current = snapshot_path.read_bytes() if snapshot_path.exists() else None
        if current != original or curated_path.read_bytes() != curated_bytes:
            raise ValueError("Snapshot or curated input changed during refresh")
        if staged is not None:
            staged.replace(snapshot_path)
        try:
            if staged_report is not None:
                staged_report.replace(report_path)
        except OSError as report_error:
            if staged is not None:
                try:
                    if snapshot_path.read_bytes() != content:
                        raise OSError("snapshot changed again; not rolled back")
                    if original is None:
                        snapshot_path.unlink()
                    else:
                        atomic_write(snapshot_path, original)
                except OSError as rollback_error:
                    raise OSError(
                        "Report replacement failed after snapshot update; "
                        f"rollback failed: {rollback_error}"
                    ) from report_error
            raise
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--snapshot", type=Path, default=DEFAULT_SNAPSHOT)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    parser.add_argument("--curated", type=Path, default=DEFAULT_SOURCE)
    options = parser.parse_args(argv)
    try:
        report = refresh_snapshot(options.snapshot, options.report, curated_path=options.curated)
    except (OSError, ValueError) as error:
        print(f"refresh: {error}", file=sys.stderr)
        return 1
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
