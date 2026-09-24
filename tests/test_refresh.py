import contextlib
import io
import json
import tempfile
import unittest
from collections.abc import Callable
from pathlib import Path
from unittest.mock import Mock, patch

from scripts.catalog import parse_snapshot, snapshot_bytes
from scripts.refresh import ROOT_CHANNEL, endpoint_url, refresh_snapshot


def gif(clip_id: str, **extra: object) -> dict[str, object]:
    return {
        "id": clip_id,
        "url": f"https://giphy.com/gifs/{clip_id}",
        "title": "Hello GIF",
        "username": "ceska_televize",
        "type": "gif",
        "tags": [],
        **extra,
    }


def child(
    channel_id: int, slug: str, *, parent: int = ROOT_CHANNEL, nested: bool = False
) -> dict[str, object]:
    return {
        "id": channel_id,
        "slug": slug,
        "display_name": slug.title(),
        "parent": parent,
        "has_children": nested,
        "url": f"/ceska_televize/{slug}",
    }


def page(records: list[dict[str, object]], next_url: str | None = None) -> dict[str, object]:
    return {"results": records, "next": next_url, "count": None}


class RefreshTests(unittest.TestCase):
    def setUp(self) -> None:
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.curated = self.root / "curated.json"
        self.curated.write_text(
            json.dumps({"old1": {"url": "https://giphy.com/gifs/old1", "keywords": ["smojlak"]}})
        )
        self.snapshot = self.root / "giphy.json"
        self.report = self.root / "report.json"
        self.routes: dict[str, object] = {
            endpoint_url(ROOT_CHANNEL, "children"): page([child(10, "osada", nested=True)]),
            endpoint_url(ROOT_CHANNEL, "feed"): page(
                [gif("a1", tags=["pelíšky", "ctenisverak"]), gif("b2", is_sticker=True)]
            ),
            endpoint_url(10, "children"): page([child(11, "nested", parent=10)]),
            endpoint_url(10, "feed"): page([gif("a1", tags=["pelíšky", "ctenisverak"])]),
            endpoint_url(11, "feed"): page([gif("a1", tags=["pelíšky", "ctenisverak"]), gif("c3")]),
        }

    def fetch(self, url: str) -> object:
        return self.routes[url]

    def refresh(self, fetch: Callable[[str], object] | None = None) -> dict[str, object]:
        with contextlib.redirect_stderr(io.StringIO()):
            return refresh_snapshot(
                self.snapshot,
                self.report,
                curated_path=self.curated,
                fetch=self.fetch if fetch is None else fetch,
            )

    def test_nested_collection_membership_wins_over_conflicting_programme_tags(self) -> None:
        report = self.refresh()
        result = json.loads(self.snapshot.read_text())
        self.assertEqual(
            result["categories"],
            [{"id": "osada", "label": "Osada"}],
        )
        records = {record["id"]: record for record in result["gifs"]}
        self.assertEqual(records["a1"]["categoryIds"], ["osada"])
        self.assertEqual(records["c3"]["categoryIds"], ["osada"])
        self.assertEqual(records["b2"]["categoryIds"], [])
        self.assertNotIn("keywords", records["a1"])
        self.assertEqual(records["a1"]["tags"], ["pelíšky", "ctenisverak"])
        self.assertEqual(
            json.loads(self.report.read_text())["tagCategoryRules"]["pelisky"]["matchedCount"], 1
        )
        self.assertEqual(report["curatedMissingIds"], ["old1"])
        self.assertEqual(report["catalogCount"], 4)
        saved = json.loads(self.report.read_text())
        self.assertEqual(saved["reviewNeeded"]["conflictingProgrammeTagIds"], ["a1"])

    def test_single_programme_fallback_and_ambiguous_tags_are_kept_separate(self) -> None:
        self.routes[endpoint_url(ROOT_CHANNEL, "feed")] = page(
            [
                gif("a1", tags=["pelíšky", "ctenisverak"]),
                gif("b2", tags=["pececelazeme"]),
                gif("ambiguous1", tags=["bozena", "osada"]),
            ]
        )
        self.refresh()
        rows = {row["id"]: row for row in json.loads(self.snapshot.read_text())["gifs"]}
        report = json.loads(self.report.read_text())
        self.assertEqual(rows["b2"]["categoryIds"], ["pece-cela-zeme"])
        self.assertEqual(rows["ambiguous1"]["categoryIds"], [])
        self.assertEqual(report["reviewNeeded"]["ambiguousProgrammeTagIds"], ["ambiguous1"])
        self.assertIn("ambiguous1", report["reviewNeeded"]["uncategorizedIds"])
        self.assertEqual(report["membershipChanges"]["b2"], {"from": [], "to": ["pece-cela-zeme"]})

    def test_ambiguous_previous_inference_is_removed_and_reported_without_losing_the_clip(
        self,
    ) -> None:
        self.snapshot.write_bytes(
            snapshot_bytes(
                parse_snapshot(
                    {
                        "categories": [{"id": "pelisky", "label": "Pelíšky"}],
                        "gifs": [
                            {
                                "tags": [],
                                "id": "ambiguous1",
                                "url": "https://giphy.com/gifs/ambiguous1",
                                "title": "Original title",
                                "categoryIds": ["pelisky"],
                            }
                        ],
                    }
                )
            )
        )
        self.routes[endpoint_url(ROOT_CHANNEL, "feed")] = page(
            [
                gif("ambiguous1", title="Original title", tags=["pelisky", "andelpane"]),
            ]
        )
        self.refresh()
        report = json.loads(self.report.read_text())
        record = next(
            row
            for row in json.loads(self.snapshot.read_text())["gifs"]
            if row["id"] == "ambiguous1"
        )
        self.assertEqual(record["title"], "Original title")
        self.assertEqual(record["categoryIds"], [])
        self.assertEqual(report["membershipChanges"]["ambiguous1"], {"from": ["pelisky"], "to": []})
        self.assertEqual(report["reviewNeeded"]["categoryMembershipRemovalIds"], ["ambiguous1"])

    def test_programme_fallback_preserves_upstream_category_labels(self) -> None:
        collection = child(10, "osada", nested=True)
        collection["display_name"] = "Osada — source label"
        self.routes[endpoint_url(ROOT_CHANNEL, "children")] = page([collection])
        self.routes[endpoint_url(ROOT_CHANNEL, "feed")] = page(
            [
                gif("a1", tags=["pelíšky", "ctenisverak"]),
                gif("b2", tags=["osada"]),
            ]
        )
        self.refresh()
        snapshot = json.loads(self.snapshot.read_text())
        self.assertEqual(snapshot["categories"], [{"id": "osada", "label": "Osada — source label"}])
        self.assertEqual(
            next(row for row in snapshot["gifs"] if row["id"] == "b2")["categoryIds"], ["osada"]
        )

    def test_current_rule_label_replaces_stale_inferred_snapshot_label(self) -> None:
        self.snapshot.write_bytes(
            snapshot_bytes(
                parse_snapshot(
                    {
                        "categories": [{"id": "pelisky", "label": "Old misspelling"}],
                        "gifs": [
                            {
                                "tags": [],
                                "id": "b2",
                                "url": "https://giphy.com/gifs/b2",
                                "title": "Hello GIF",
                                "categoryIds": ["pelisky"],
                            }
                        ],
                    }
                )
            )
        )
        self.routes[endpoint_url(ROOT_CHANNEL, "feed")] = page(
            [
                gif("a1", tags=["pelíšky", "ctenisverak"]),
                gif("b2", tags=["pelisky"]),
            ]
        )
        self.refresh()
        categories = {
            row["id"]: row["label"] for row in json.loads(self.snapshot.read_text())["categories"]
        }
        self.assertEqual(categories["pelisky"], "Pelíšky")

    def test_removed_tombstone_without_unused_metadata_is_reported_and_skipped(self) -> None:
        removed = gif("removed1", is_removed=True)
        del removed["title"]
        del removed["tags"]
        self.routes[endpoint_url(ROOT_CHANNEL, "feed")] = page(
            [
                gif("a1", tags=["pelíšky", "ctenisverak"]),
                removed,
            ]
        )
        self.refresh()
        report = json.loads(self.report.read_text())
        ids = {row["id"] for row in json.loads(self.snapshot.read_text())["gifs"]}
        self.assertNotIn("removed1", ids)
        self.assertEqual(report["exclusions"]["removed"], ["removed1"])

    def test_missing_or_invalid_eligible_type_preserves_previous_outputs(self) -> None:
        self.routes[endpoint_url(ROOT_CHANNEL, "children")] = page([])
        self.routes[endpoint_url(ROOT_CHANNEL, "feed")] = page([gif("known1")])
        self.refresh()
        outputs = (self.snapshot, self.report, self.curated)
        original = [path.read_bytes() for path in outputs]
        missing = object()
        for invalid_type in (missing, None, 123, True, [], {}, "", " "):
            row = gif("known1")
            if invalid_type is missing:
                del row["type"]
            else:
                row["type"] = invalid_type
            self.routes[endpoint_url(ROOT_CHANNEL, "feed")] = page([row])
            with self.subTest(type=invalid_type):
                with self.assertRaisesRegex(ValueError, "type"):
                    self.refresh()
                self.assertEqual([path.read_bytes() for path in outputs], original)

    def test_explicit_exclusions_do_not_require_tombstone_type_or_content_metadata(self) -> None:
        self.routes[endpoint_url(ROOT_CHANNEL, "children")] = page([])
        self.routes[endpoint_url(ROOT_CHANNEL, "feed")] = page(
            [
                gif("keep1"),
                {"id": "removed1", "is_removed": True},
                {"id": "hidden1", "is_hidden": True},
                {"id": "foreign1", "username": "someone_else"},
                {"id": "video1", "is_video": True},
                gif("audio1", type="audio"),
            ]
        )
        report = self.refresh()
        self.assertEqual(
            report["exclusions"],
            {
                "foreignOwner": ["foreign1"],
                "hidden": ["hidden1"],
                "nonGif": ["audio1", "video1"],
                "removed": ["removed1"],
            },
        )
        self.assertEqual(
            [row["id"] for row in json.loads(self.snapshot.read_text())["gifs"]], ["keep1"]
        )

    def test_duplicate_top_level_slugs_fail_before_writing(self) -> None:
        self.routes[endpoint_url(ROOT_CHANNEL, "children")] = page(
            [child(10, "osada"), child(20, "osada")]
        )
        with self.assertRaisesRegex(ValueError, "Duplicate top-level collection slug"):
            self.refresh()
        self.assertFalse(self.snapshot.exists())
        self.assertFalse(self.report.exists())

    def test_missing_title_or_tags_fail_before_writing_but_explicit_empty_values_are_valid(
        self,
    ) -> None:
        for field in ("title", "tags"):
            row = gif("missing1")
            del row[field]
            self.routes[endpoint_url(ROOT_CHANNEL, "feed")] = page([row])
            with (
                self.subTest(field=field),
                self.assertRaisesRegex(ValueError, "missing title or tags"),
            ):
                self.refresh()
            self.assertFalse(self.snapshot.exists())
        self.routes[endpoint_url(ROOT_CHANNEL, "feed")] = page([gif("blank1", title="", tags=[])])
        self.refresh()
        report = json.loads(self.report.read_text())
        self.assertIn("blank1", report["reviewNeeded"]["missingSearchTextIds"])

    def test_verified_missing_programmes_use_exact_aliases_without_fuzzy_matching(self) -> None:
        self.routes[endpoint_url(ROOT_CHANNEL, "feed")] = page(
            [
                gif("a1", tags=["pelíšky", "ctenisverak"]),
                gif("ch1", tags=["chalupari"]),
                gif("na1", tags=["navstevnici"]),
                gif("pr1", tags=["prvnirepublika"]),
                gif("sd1", tags=["stardance10"]),
                gif("zk1", tags=["zkazadejvickehodivadla"]),
                gif("fuzzy1", tags=["chalupári"]),
            ]
        )
        self.refresh()
        rows = {row["id"]: row for row in json.loads(self.snapshot.read_text())["gifs"]}
        for clip_id, category in {
            "ch1": "chalupari",
            "na1": "navstevnici",
            "pr1": "prvni-republika",
            "sd1": "stardance-x",
            "zk1": "zkaza-dejvickeho-divadla",
        }.items():
            self.assertEqual(rows[clip_id]["categoryIds"], [category])
        self.assertEqual(rows["fuzzy1"]["categoryIds"], [])

    def test_full_pagination_and_cached_replay_preserve_bytes_and_mtime(self) -> None:
        first_url = endpoint_url(ROOT_CHANNEL, "feed")
        second_url = endpoint_url(ROOT_CHANNEL, "feed", offset=50)
        self.routes[first_url] = page([gif("a1", tags=["pelíšky", "ctenisverak"])], second_url)
        self.routes[second_url] = page([gif("b2", is_sticker=True)])
        self.refresh()
        original, mtime = self.snapshot.read_bytes(), self.snapshot.stat().st_mtime_ns
        self.refresh()
        self.assertEqual(self.snapshot.read_bytes(), original)
        self.assertEqual(self.snapshot.stat().st_mtime_ns, mtime)

    def test_changed_raw_tags_across_feeds_fail_without_publishing(self) -> None:
        self.routes[endpoint_url(10, "feed")] = page([gif("a1", tags=["different"])])
        with self.assertRaisesRegex(ValueError, "metadata changed during the scan"):
            self.refresh()
        self.assertFalse(self.snapshot.exists())

    def test_original_media_hash_is_normalized_and_survives_partial_feed_metadata(self) -> None:
        media_hash = "abcdef0123456789abcdef0123456789"
        self.routes[endpoint_url(ROOT_CHANNEL, "feed")] = page([gif("a1")])
        self.routes[endpoint_url(10, "feed")] = page(
            [gif("a1", images={"original": {"hash": media_hash.upper()}})]
        )
        self.routes[endpoint_url(11, "feed")] = page(
            [gif("a1", images={"original": {"hash": media_hash}}), gif("a1")]
        )
        self.refresh()
        records = json.loads(self.snapshot.read_text())["gifs"]
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["originalHash"], media_hash)
        review = json.loads(self.report.read_text())["reviewNeeded"]
        self.assertEqual(review["missingMediaHashIds"], [])

    def test_missing_or_malformed_media_hash_keeps_and_reports_the_record(self) -> None:
        self.routes[endpoint_url(ROOT_CHANNEL, "children")] = page([])
        for images in (
            None,
            [],
            {},
            {"original": None},
            {"original": []},
            {"original": {}},
            {"original": {"hash": None}},
            {"original": {"hash": 123}},
            {"original": {"hash": ""}},
            {"original": {"hash": "g" * 32}},
            {"original": {"hash": "a" * 31}},
            {"original": {"hash": "a" * 33}},
            {"original": {"hash": " " + "a" * 32}},
        ):
            with self.subTest(images=images):
                self.routes[endpoint_url(ROOT_CHANNEL, "feed")] = page(
                    [gif("known1", images=images)]
                )
                self.refresh()
                records = json.loads(self.snapshot.read_text())["gifs"]
                self.assertEqual([record["id"] for record in records], ["known1"])
                self.assertNotIn("originalHash", records[0])
                review = json.loads(self.report.read_text())["reviewNeeded"]
                self.assertEqual(review["missingMediaHashIds"], ["known1"])

    def test_observed_missing_hash_clears_stale_hash_but_absent_record_retains_it(self) -> None:
        media_hash = "a" * 32
        self.routes[endpoint_url(ROOT_CHANNEL, "children")] = page([])
        self.routes[endpoint_url(ROOT_CHANNEL, "feed")] = page(
            [
                gif("known1", images={"original": {"hash": media_hash}}),
                gif("missing1", images={"original": {"hash": "b" * 32}}),
            ]
        )
        self.refresh()
        self.routes[endpoint_url(ROOT_CHANNEL, "feed")] = page([gif("known1")])
        report = self.refresh()
        records = {record["id"]: record for record in json.loads(self.snapshot.read_text())["gifs"]}
        self.assertNotIn("originalHash", records["known1"])
        self.assertEqual(records["missing1"]["originalHash"], "b" * 32)
        self.assertEqual(report["preservedMissingIds"], ["missing1"])
        review = json.loads(self.report.read_text())["reviewNeeded"]
        self.assertEqual(review["missingMediaHashIds"], ["known1"])

    def test_different_valid_hashes_across_feeds_fail_without_publishing(self) -> None:
        self.refresh()
        outputs = (self.snapshot, self.report, self.curated)
        original = [path.read_bytes() for path in outputs]
        self.routes[endpoint_url(ROOT_CHANNEL, "feed")] = page(
            [gif("a1", images={"original": {"hash": "a" * 32}})]
        )
        self.routes[endpoint_url(10, "feed")] = page([gif("a1")])
        self.routes[endpoint_url(11, "feed")] = page(
            [gif("a1", images={"original": {"hash": "b" * 32}})]
        )
        with self.assertRaisesRegex(ValueError, "a1: original media hash changed during the scan"):
            self.refresh()
        self.assertEqual([path.read_bytes() for path in outputs], original)

    def test_report_counts_exact_media_groups_and_keeps_all_snapshot_records(self) -> None:
        media_hash, sticker_hash = "a" * 32, "b" * 32
        self.routes[endpoint_url(ROOT_CHANNEL, "children")] = page([])
        self.routes[endpoint_url(ROOT_CHANNEL, "feed")] = page(
            [
                gif("a1", images={"original": {"hash": media_hash}}),
                gif("a2", images={"original": {"hash": media_hash}}),
                gif("old1", images={"original": {"hash": media_hash}}),
                gif(
                    "s1",
                    url="https://giphy.com/stickers/s1",
                    is_sticker=True,
                    images={"original": {"hash": media_hash}},
                ),
                gif(
                    "b2",
                    url="https://giphy.com/stickers/b2",
                    is_sticker=True,
                    images={"original": {"hash": sticker_hash}},
                ),
                gif(
                    "c3",
                    url="https://giphy.com/stickers/c3",
                    is_sticker=True,
                    images={"original": {"hash": sticker_hash}},
                ),
                gif("x1", source="same-source", hash=media_hash, source_post_url="same-source"),
                gif("x2", source="same-source", hash=media_hash, source_post_url="same-source"),
            ]
        )
        report = self.refresh()
        self.assertEqual(report["snapshotCount"], 8)
        self.assertEqual(report["catalogCount"], 5)
        self.assertEqual(report["duplicateMediaCount"], 3)
        self.assertEqual(
            report["duplicateMediaGroups"],
            [
                {"canonicalId": "b2", "duplicateIds": ["c3"], "originalHash": sticker_hash},
                {"canonicalId": "old1", "duplicateIds": ["a1", "a2"], "originalHash": media_hash},
            ],
        )
        review = json.loads(self.report.read_text())["reviewNeeded"]
        self.assertEqual(review["missingMediaHashIds"], ["x1", "x2"])
        self.assertEqual(len(json.loads(self.snapshot.read_text())["gifs"]), 8)

    def test_display_only_category_fragments_never_infer_programme_membership(self) -> None:
        self.routes[endpoint_url(ROOT_CHANNEL, "feed")] = page(
            [
                gif("a1", tags=["pelíšky", "ctenisverak"]),
                gif("weak1", tags=["divadlo", "jary", "djc"]),
                gif("weak2", tags=["tomas", "holy"]),
            ]
        )
        self.refresh()
        rows = {row["id"]: row for row in json.loads(self.snapshot.read_text())["gifs"]}
        self.assertEqual(rows["weak1"]["categoryIds"], [])
        self.assertEqual(rows["weak2"]["categoryIds"], [])

    def test_previous_snapshot_absences_are_retained_but_explicit_removals_are_reported(
        self,
    ) -> None:
        self.snapshot.write_bytes(
            snapshot_bytes(
                parse_snapshot(
                    {
                        "categories": [],
                        "gifs": [
                            {
                                "tags": [],
                                "id": "missing1",
                                "url": "https://giphy.com/gifs/missing1",
                                "title": "Old",
                                "categoryIds": [],
                            },
                            {
                                "tags": [],
                                "id": "gone1",
                                "url": "https://giphy.com/gifs/gone1",
                                "title": "Gone",
                                "categoryIds": [],
                            },
                        ],
                    }
                )
            )
        )
        self.routes[endpoint_url(ROOT_CHANNEL, "feed")] = page(
            [
                gif("a1", tags=["pelíšky", "ctenisverak"]),
                gif("gone1", is_removed=True),
                gif("old1", is_hidden=True),
            ]
        )
        report = self.refresh()
        records = {row["id"] for row in json.loads(self.snapshot.read_text())["gifs"]}
        self.assertIn("missing1", records)
        self.assertNotIn("gone1", records)
        self.assertEqual(report["preservedMissingIds"], ["missing1"])
        self.assertEqual(json.loads(self.report.read_text())["exclusions"]["removed"], ["gone1"])
        self.assertEqual(report["curatedRetainedDespiteExclusion"], ["old1"])

    def test_foreign_non_gif_hidden_and_removed_records_are_explicitly_excluded(self) -> None:
        self.routes[endpoint_url(ROOT_CHANNEL, "feed")] = page(
            [
                gif("a1", tags=["pelíšky", "ctenisverak"]),
                gif("foreign1", username="someone_else"),
                gif("video1", is_video=True),
                gif("hidden1", is_hidden=True),
                gif("removed1", is_removed=True),
                gif("unknown1", username=""),
                gif("fallback1", username="", user={"username": "ceska_televize"}),
            ]
        )
        report = self.refresh()
        self.assertEqual(
            report["exclusions"],
            {
                "foreignOwner": ["foreign1"],
                "hidden": ["hidden1"],
                "nonGif": ["video1"],
                "removed": ["removed1"],
            },
        )
        self.assertEqual(report["unattributedIds"], ["unknown1"])
        self.assertIn(
            "unknown1", {row["id"] for row in json.loads(self.snapshot.read_text())["gifs"]}
        )
        self.assertIn(
            "fallback1", {row["id"] for row in json.loads(self.snapshot.read_text())["gifs"]}
        )

    def test_upstream_sticker_and_text_types_are_included_when_flagged_as_stickers(self) -> None:
        self.routes[endpoint_url(ROOT_CHANNEL, "feed")] = page(
            [
                gif("a1", tags=["pelíšky", "ctenisverak"]),
                gif("s1", type="sticker", is_sticker=True, url="https://giphy.com/stickers/s1"),
                gif("t1", type="text", is_sticker=True, url="https://giphy.com/stickers/t1"),
            ]
        )
        report = self.refresh()
        records = {record["id"] for record in json.loads(self.snapshot.read_text())["gifs"]}
        self.assertTrue({"s1", "t1"} <= records)
        self.assertEqual(report["includedStickerCount"], 2)

    def test_failed_later_page_changes_neither_output_nor_curated_input(self) -> None:
        self.refresh()
        originals = [path.read_bytes() for path in (self.snapshot, self.report, self.curated)]
        self.routes[endpoint_url(ROOT_CHANNEL, "feed")] = page(
            [gif("a1")], endpoint_url(ROOT_CHANNEL, "feed", offset=50)
        )
        fetch = Mock(
            side_effect=lambda url: (
                self.fetch(url)
                if "offset=50" not in url
                else (_ for _ in ()).throw(OSError("network failed"))
            )
        )
        with self.assertRaises(OSError):
            self.refresh(fetch)
        self.assertEqual(
            [path.read_bytes() for path in (self.snapshot, self.report, self.curated)], originals
        )

    def test_pagination_must_stay_on_expected_feed_and_make_progress(self) -> None:
        for next_url in (
            "https://example.com/feed?offset=50&limit=50",
            endpoint_url(10, "feed", offset=50),
            endpoint_url(ROOT_CHANNEL, "feed"),
            endpoint_url(ROOT_CHANNEL, "feed", offset=100),
        ):
            with self.subTest(next_url=next_url):
                self.routes[endpoint_url(ROOT_CHANNEL, "feed")] = page([gif("a1")], next_url)
                with self.assertRaises(ValueError):
                    self.refresh()
                self.assertFalse(self.snapshot.exists())

    def test_duplicate_only_nonterminal_page_fails(self) -> None:
        first, second = (
            endpoint_url(ROOT_CHANNEL, "feed"),
            endpoint_url(ROOT_CHANNEL, "feed", offset=50),
        )
        self.routes[first] = page([gif("a1")], second)
        self.routes[second] = page([gif("a1")], endpoint_url(ROOT_CHANNEL, "feed", offset=100))
        with self.assertRaisesRegex(ValueError, "no new IDs"):
            self.refresh()

    def test_output_input_aliases_fail_before_fetching(self) -> None:
        self.snapshot.symlink_to(self.curated)
        fetch = Mock()
        with self.assertRaisesRegex(ValueError, "distinct"):
            self.refresh(fetch)
        fetch.assert_not_called()

    def test_report_commit_failure_restores_previous_snapshot(self) -> None:
        self.refresh()
        original = self.snapshot.read_bytes()
        self.routes[endpoint_url(ROOT_CHANNEL, "feed")] = page(
            [gif("a1", tags=["pelíšky", "ctenisverak"]), gif("new1")]
        )
        real_replace = Path.replace

        def replace(path: Path, target: Path) -> Path:
            if target == self.report:
                raise OSError("report failed")
            return real_replace(path, target)

        with (
            patch.object(Path, "replace", replace),
            self.assertRaisesRegex(OSError, "report failed"),
        ):
            self.refresh()
        self.assertEqual(self.snapshot.read_bytes(), original)
        self.assertEqual(list(self.root.glob(".*.json.*")), [])

    def test_concurrent_snapshot_edit_is_not_overwritten(self) -> None:
        self.refresh()
        real_fetch = self.fetch

        def fetch(url: str) -> object:
            self.snapshot.write_bytes(b"concurrent edit")
            return real_fetch(url)

        with self.assertRaisesRegex(ValueError, "changed during refresh"):
            self.refresh(fetch)
        self.assertEqual(self.snapshot.read_bytes(), b"concurrent edit")

    def test_first_publish_report_failure_removes_new_snapshot(self) -> None:
        self.report.write_bytes(b"previous report")
        original_curated = self.curated.read_bytes()
        real_replace = Path.replace

        def replace(path: Path, target: Path) -> Path:
            if target == self.report:
                raise OSError("report failed")
            return real_replace(path, target)

        with (
            patch.object(Path, "replace", replace),
            self.assertRaisesRegex(OSError, "report failed"),
        ):
            self.refresh()
        self.assertFalse(self.snapshot.exists())
        self.assertEqual(self.report.read_bytes(), b"previous report")
        self.assertEqual(self.curated.read_bytes(), original_curated)
        self.assertEqual(list(self.root.glob(".*.json.*")), [])

    def test_report_failure_does_not_roll_back_a_later_concurrent_edit(self) -> None:
        real_replace = Path.replace

        def replace(path: Path, target: Path) -> Path:
            if target == self.report:
                self.snapshot.write_bytes(b"later edit")
                raise OSError("report failed")
            return real_replace(path, target)

        with (
            patch.object(Path, "replace", replace),
            self.assertRaisesRegex(OSError, "snapshot changed again"),
        ):
            self.refresh()
        self.assertEqual(self.snapshot.read_bytes(), b"later edit")


if __name__ == "__main__":
    unittest.main()
