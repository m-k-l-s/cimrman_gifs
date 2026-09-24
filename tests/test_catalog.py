import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts.catalog import (
    SnapshotGif,
    atomic_write,
    build_catalog,
    clean_keywords,
    effective_keywords,
    load_catalog,
    parse_snapshot,
    review_catalog,
    snapshot_bytes,
)


class CatalogTests(unittest.TestCase):
    def setUp(self) -> None:
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.source = self.root / "curated.json"
        self.snapshot = self.root / "giphy.json"
        self.output = self.root / "catalog.json"
        self.source.write_text(
            json.dumps(
                {
                    "a1": {
                        "url": "https://giphy.com/gifs/curated-a1",
                        "keywords": ["smojlak", "ctenisverak"],
                    },
                    "b2": {
                        "url": "https://giphy.com/gifs/curated-b2",
                        "keywords": ["milou", "penice"],
                    },
                }
            )
        )
        self.data: dict[str, object] = {
            "categories": [{"id": "osada", "label": "Osada"}],
            "gifs": [
                {
                    "id": "a1",
                    "url": "https://giphy.com/gifs/remote-a1",
                    "title": "Hello GIF",
                    "tags": [],
                    "categoryIds": ["osada", "osada"],
                },
                {
                    "id": "c3",
                    "url": "https://giphy.com/gifs/remote-c3",
                    "title": "What GIF",
                    "tags": [],
                    "categoryIds": [],
                },
            ],
        }
        self.snapshot.write_text(json.dumps(self.data))

    def build(self, *, check: bool = False) -> int:
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            return build_catalog(self.source, self.output, snapshot_path=self.snapshot, check=check)

    def test_build_merges_categories_and_preserves_both_inputs(self) -> None:
        originals = (self.source.read_bytes(), self.snapshot.read_bytes())
        self.assertEqual(self.build(), 0)
        result = json.loads(self.output.read_text())
        self.assertEqual(
            result["categories"],
            [
                {"id": "cimrmani", "label": "Cimrman"},
                {"id": "osada", "label": "Osada"},
            ],
        )
        clips = {clip["id"]: clip for clip in result["gifs"]}
        self.assertEqual(list(clips), ["a1", "b2", "c3"])
        self.assertEqual(clips["a1"]["url"], "https://giphy.com/gifs/curated-a1")
        self.assertEqual(clips["a1"]["categoryIds"], ["cimrmani", "osada"])
        self.assertEqual(clips["a1"]["title"], "Hello GIF")
        self.assertEqual(clips["a1"]["keywords"], ["smoljak"])
        self.assertEqual(clips["b2"]["categoryIds"], ["cimrmani"])
        self.assertEqual(clips["b2"]["title"], "")
        self.assertEqual(clips["c3"]["keywords"], [])
        self.assertEqual(set(clips["c3"]), {"id", "url", "title", "categoryIds", "keywords"})
        self.assertEqual((self.source.read_bytes(), self.snapshot.read_bytes()), originals)

    def test_cimrman_display_policy_overrides_legacy_label_only(self) -> None:
        snapshot = json.loads(self.snapshot.read_text())
        snapshot["categories"] = [
            {"id": "cimrmani", "label": "Cimrmani"},
            {"id": "osada", "label": "OSADA — původní název"},
        ]
        self.snapshot.write_text(json.dumps(snapshot))
        originals = self.source.read_bytes(), self.snapshot.read_bytes()

        self.assertEqual(self.build(), 0)
        result = json.loads(self.output.read_text())
        self.assertEqual(
            result["categories"],
            [
                {"id": "cimrmani", "label": "Cimrman"},
                {"id": "osada", "label": "OSADA — původní název"},
            ],
        )
        self.assertEqual(result["gifs"][0]["categoryIds"], ["cimrmani", "osada"])
        self.assertEqual((self.source.read_bytes(), self.snapshot.read_bytes()), originals)

    def test_build_is_byte_and_mtime_idempotent(self) -> None:
        self.build()
        first, mtime = self.output.read_bytes(), self.output.stat().st_mtime_ns
        self.build()
        self.assertEqual(self.output.read_bytes(), first)
        self.assertEqual(self.output.stat().st_mtime_ns, mtime)
        self.assertEqual(self.build(check=True), 0)

    def test_curated_keywords_override_source_tags_even_when_intentionally_empty(self) -> None:
        curated = json.loads(self.source.read_text())
        curated["b2"]["keywords"] = []
        self.source.write_text(json.dumps(curated))
        snapshot = json.loads(self.snapshot.read_text())
        snapshot["gifs"][0]["tags"] = ["source-only", "sverak"]
        snapshot["gifs"][1]["tags"] = ["Česká televize", "osada", "Pelíšky", "smoljak", "televizor"]
        snapshot["gifs"][1]["categoryIds"] = ["osada"]
        snapshot["gifs"].append(
            {
                "id": "b2",
                "url": "https://giphy.com/gifs/b2",
                "title": "",
                "tags": ["must-not-replace-curated-empty"],
                "categoryIds": [],
            }
        )
        self.snapshot.write_text(json.dumps(snapshot))
        originals = self.source.read_bytes(), self.snapshot.read_bytes()
        self.build()
        rows = {row["id"]: row for row in json.loads(self.output.read_text())["gifs"]}
        self.assertEqual(rows["a1"]["keywords"], ["smoljak"])
        self.assertEqual(rows["b2"]["keywords"], [])
        self.assertEqual(rows["c3"]["keywords"], ["Pelíšky", "smoljak", "televizor"])
        self.assertEqual((self.source.read_bytes(), self.snapshot.read_bytes()), originals)

    def test_cleanup_uses_exact_normalized_aliases_and_preserves_other_categories_and_words(
        self,
    ) -> None:
        raw = [
            "Česká televize",
            "CESKATELEVIZE",
            "ivysílání",
            "českátelecize",
            "ceskatelevice",
            "ÓSADA",
            "Pelíšky",
            "sverak",
            "televizor",
            "czech",
            "český",
            "smojlak",
            "ctenisverak",
        ]
        expected = ("Pelíšky", "sverak", "televizor", "czech", "český", "smoljak")
        source = SnapshotGif("x1", "https://giphy.com/gifs/x1", "", tuple(raw), ("osada",))
        self.assertEqual(effective_keywords(None, source), expected)
        second = SnapshotGif("x1", source.url, source.title, expected, source.category_ids)
        self.assertEqual(effective_keywords(None, second), expected)

    def test_effective_keywords_deduplicate_case_and_diacritics_preserving_first_spelling(
        self,
    ) -> None:
        tags = ("Hurá", "hura", "HURA", "Svěrák", "sverak", "smojlak", "smoljak")
        source = SnapshotGif("x1", "https://giphy.com/gifs/x1", "", tags, ())
        self.assertEqual(effective_keywords(None, source), ("Hurá", "Svěrák", "smoljak"))
        self.assertEqual(source.tags, tags)
        self.assertEqual(
            clean_keywords(tags), ("Hurá", "hura", "HURA", "Svěrák", "sverak", "smoljak")
        )

    def test_common_category_fragments_are_removed_only_in_their_own_category(self) -> None:
        tags = ("divadlo", "jary", "djc", "tomas", "holy", "sverak", "smoljak")
        cimrman = SnapshotGif("x1", "https://giphy.com/gifs/x1", "", tags, ("cimrmani",))
        holy = SnapshotGif("x1", cimrman.url, "", tags, ("tomas-holy",))
        outside = SnapshotGif("x1", cimrman.url, "", tags, ())
        self.assertEqual(effective_keywords(None, cimrman), ("tomas", "holy", "sverak", "smoljak"))
        self.assertEqual(
            effective_keywords(None, holy), ("divadlo", "jary", "djc", "sverak", "smoljak")
        )
        self.assertEqual(effective_keywords(None, outside), tags)

    def test_search_review_uses_cleaned_source_tags_without_overriding_curated_empty_lists(
        self,
    ) -> None:
        curated = json.loads(self.source.read_text())
        curated["b2"]["keywords"] = []
        self.source.write_text(json.dumps(curated))
        snapshot = parse_snapshot(
            {
                "categories": [],
                "gifs": [
                    {
                        "id": "b2",
                        "url": "https://giphy.com/gifs/b2",
                        "title": "Česká televize GIF",
                        "tags": ["smoljak"],
                        "categoryIds": [],
                    },
                    {
                        "id": "c3",
                        "url": "https://giphy.com/gifs/c3",
                        "title": "Česká televize GIF",
                        "tags": ["czechtv", "smoljak"],
                        "categoryIds": [],
                    },
                ],
            }
        )
        self.assertEqual(
            review_catalog(load_catalog(self.source), snapshot)["missingSearchTextIds"], ["b2"]
        )

    def test_legacy_snapshot_reader_is_explicit_and_writer_always_adds_raw_tags(self) -> None:
        legacy = {
            "categories": [],
            "gifs": [
                {"id": "a1", "url": "https://giphy.com/gifs/a1", "title": "", "categoryIds": []}
            ],
        }
        with self.assertRaisesRegex(ValueError, "tags"):
            parse_snapshot(legacy)
        migrated = json.loads(snapshot_bytes(parse_snapshot(legacy, allow_legacy_tags=True)))
        self.assertEqual(migrated["gifs"][0]["tags"], [])

    def test_check_never_writes_stale_output(self) -> None:
        self.assertEqual(self.build(check=True), 1)
        self.assertFalse(self.output.exists())
        self.output.write_bytes(b"stale")
        self.assertEqual(self.build(check=True), 1)
        self.assertEqual(self.output.read_bytes(), b"stale")

    def test_output_cannot_replace_either_input(self) -> None:
        for target in (self.source, self.snapshot):
            self.output.unlink(missing_ok=True)
            self.output.symlink_to(target)
            with self.assertRaisesRegex(ValueError, "overwrite"):
                self.build()

    def test_unknown_categories_and_duplicate_gif_ids_fail_before_writing(self) -> None:
        self.output.write_bytes(b"previous")
        for gifs in [
            [
                {
                    "tags": [],
                    "id": "a1",
                    "url": "https://giphy.com/gifs/a1",
                    "title": "",
                    "categoryIds": ["unknown"],
                }
            ],
            [
                {
                    "tags": [],
                    "id": "a1",
                    "url": "https://giphy.com/gifs/a1",
                    "title": "",
                    "categoryIds": [],
                }
            ]
            * 2,
        ]:
            with self.subTest(gifs=gifs):
                self.snapshot.write_text(json.dumps({"categories": [], "gifs": gifs}))
                with self.assertRaises(ValueError):
                    self.build()
                self.assertEqual(self.output.read_bytes(), b"previous")

    def test_snapshot_cannot_be_another_keyword_source(self) -> None:
        with self.assertRaises(ValueError):
            parse_snapshot(
                {
                    "categories": [],
                    "gifs": [
                        {
                            "tags": [],
                            "id": "a1",
                            "url": "https://giphy.com/gifs/a1",
                            "title": "",
                            "categoryIds": [],
                            "keywords": ["not allowed"],
                        }
                    ],
                }
            )

    def test_category_ids_follow_the_frontend_url_contract(self) -> None:
        for category_id in ("Osada", "osada_2", "pelíšky", "-osada"):
            with self.subTest(category_id=category_id), self.assertRaises(ValueError):
                parse_snapshot(
                    {"categories": [{"id": category_id, "label": "Category"}], "gifs": []}
                )

    def test_curated_validation_preserves_raw_keywords_and_rejects_duplicate_keys(self) -> None:
        self.assertEqual(load_catalog(self.source)[0].keywords, ("smojlak", "ctenisverak"))
        self.source.write_text('{"a1": {}, "a1": {}}')
        with self.assertRaisesRegex(ValueError, "Duplicate JSON key"):
            load_catalog(self.source)

    def test_exact_keyword_policy_is_stable_and_idempotent(self) -> None:
        raw = [
            "smojlak",
            "smoljak",
            "bruckner",
            "brunker",
            "brukner",
            "wiegel",
            "weigel",
            "ctenisverak",
            "vlasysverak",
            "sveraknarozeniny",
            "tokazdyvi",
            "ahasverak",
            "notaktojo",
            "nojovlastne",
            "anoano",
            "poctasverak",
            "kromeme",
            "zlaterucicky",
            "travoltasverak",
            "sveraklooking",
            "cepel",
            "milou",
            "penice",
            "cetba",
            "pocta",
            "travolta",
            "svěrák",
            "Smoljak",
            "other",
            "other",
        ]
        expected = (
            "smoljak",
            "brukner",
            "weigel",
            "cepel",
            "milou",
            "penice",
            "cetba",
            "pocta",
            "travolta",
            "svěrák",
            "Smoljak",
            "other",
        )
        self.assertEqual(clean_keywords(raw), expected)
        self.assertEqual(clean_keywords(expected), expected)

    def test_review_flags_gaps_without_rewriting_or_guessing_metadata(self) -> None:
        snapshot = parse_snapshot(
            {
                "categories": [{"id": "osada", "label": "Osada"}],
                "gifs": [
                    {
                        "tags": [],
                        "id": "a1",
                        "url": "https://giphy.com/gifs/a1",
                        "title": "GIF by Česká televize",
                        "categoryIds": ["osada"],
                    },
                    {
                        "tags": [],
                        "id": "generic",
                        "url": "https://giphy.com/gifs/generic",
                        "title": "Ceskatelevize Czechtv GIF",
                        "categoryIds": ["osada"],
                    },
                    {
                        "tags": [],
                        "id": "empty",
                        "url": "https://giphy.com/gifs/empty",
                        "title": "",
                        "categoryIds": [],
                    },
                    {
                        "tags": [],
                        "id": "named",
                        "url": "https://giphy.com/gifs/named",
                        "title": "Žízeň GIF by Česká televize",
                        "categoryIds": [],
                    },
                ],
            }
        )
        expected = {
            "uncategorizedIds": ["empty", "named"],
            "missingSearchTextIds": ["empty", "generic"],
        }
        self.assertEqual(review_catalog(load_catalog(self.source), snapshot), expected)
        self.assertEqual(review_catalog(load_catalog(self.source), snapshot), expected)
        self.assertEqual(snapshot.gifs[0].title, "GIF by Česká televize")
        self.assertEqual(len(snapshot.gifs), 4)

    def test_atomic_replace_failure_keeps_previous_bytes_and_cleans_tempfile(self) -> None:
        self.output.write_bytes(b"previous")
        with (
            patch.object(Path, "replace", side_effect=OSError("disk error")),
            self.assertRaises(OSError),
        ):
            atomic_write(self.output, b"new")
        self.assertEqual(self.output.read_bytes(), b"previous")
        self.assertEqual(list(self.root.glob(".catalog.json.*")), [])


if __name__ == "__main__":
    unittest.main()
