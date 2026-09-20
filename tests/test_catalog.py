import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts.catalog import (
    DEFAULT_SOURCE,
    atomic_write,
    build_catalog,
    load_catalog,
    main,
    parse_catalog,
    serialize_catalog,
)


class CatalogTests(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.source = self.root / "source.json"
        self.output = self.root / "catalog.json"
        self.entries: dict[str, object] = {
            "b2": {"url": "https://giphy.com/gifs/second-b2", "keywords": []},
            "a1": {"url": "https://giphy.com/gifs/first-a1", "keywords": ["život", "smrt"]},
        }
        self.write_source(self.entries)

    def write_source(self, entries: object) -> None:
        self.source.write_text(json.dumps(entries, ensure_ascii=False), encoding="utf-8")

    def test_build_preserves_all_entries_and_source(self) -> None:
        original = self.source.read_bytes()
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(build_catalog(self.source, self.output), 0)
        catalog = json.loads(self.output.read_text())
        self.assertEqual([clip["id"] for clip in catalog], ["a1", "b2"])
        self.assertEqual(catalog[0]["keywords"], ["život", "smrt"])
        self.assertEqual(catalog[1]["keywords"], [])
        self.assertEqual(catalog[0]["gif"], "https://media.giphy.com/media/a1/giphy.gif")
        self.assertEqual(catalog[0]["mp4"], "https://media.giphy.com/media/a1/giphy.mp4")
        self.assertEqual(catalog[0]["webp"], "https://media.giphy.com/media/a1/200w.webp")
        self.assertEqual(self.source.read_bytes(), original)

    def test_check_does_not_create_or_modify_output(self) -> None:
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(build_catalog(self.source, self.output, check=True), 1)
        self.assertFalse(self.output.exists())
        self.output.write_bytes(b"stale")
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(build_catalog(self.source, self.output, check=True), 1)
        self.assertEqual(self.output.read_bytes(), b"stale")

    def test_output_is_deterministic_and_unchanged_files_keep_mtime(self) -> None:
        with contextlib.redirect_stdout(io.StringIO()):
            build_catalog(self.source, self.output)
            original = self.output.read_bytes()
            mtime = self.output.stat().st_mtime_ns
            self.write_source(dict(reversed(list(self.entries.items()))))
            build_catalog(self.source, self.output)
            self.assertEqual(build_catalog(self.source, self.output, check=True), 0)
        self.assertEqual(self.output.read_bytes(), original)
        self.assertEqual(self.output.stat().st_mtime_ns, mtime)

    def test_curated_source_cannot_be_overwritten_even_through_symlink(self) -> None:
        self.output.symlink_to(self.source)
        with self.assertRaisesRegex(ValueError, "must not overwrite"):
            build_catalog(self.source, self.source)
        with self.assertRaisesRegex(ValueError, "must not overwrite"):
            build_catalog(self.source, self.output)

    def test_invalid_source_never_changes_existing_output(self) -> None:
        invalid: list[object] = [
            {},
            [],
            {"../bad": {"url": "https://giphy.com/gifs/../bad", "keywords": []}},
            {"a1": {"url": "http://giphy.com/gifs/a1", "keywords": []}},
            {"a1": {"url": "https://example.com/gifs/a1", "keywords": []}},
            {"a1": {"url": "https://giphy.com/gifs/a2", "keywords": []}},
            {"a1": {"url": "https://giphy.com/gifs/a1", "keywords": None}},
            {"a1": {"url": "https://giphy.com/gifs/a1", "keywords": [""]}},
            {"a1": {"url": "https://giphy.com/gifs/a1", "keywords": [3]}},
            {"a1": {"url": "https://giphy.com/gifs/a1", "keywords": [], "extra": 1}},
        ]
        self.output.write_bytes(b"existing")
        for entries in invalid:
            with self.subTest(entries=entries):
                self.write_source(entries)
                with self.assertRaises(ValueError):
                    build_catalog(self.source, self.output)
                self.assertEqual(self.output.read_bytes(), b"existing")

    def test_duplicate_json_keys_are_rejected(self) -> None:
        self.source.write_text('{"a1": {}, "a1": {}}')
        with self.assertRaisesRegex(ValueError, "Duplicate JSON key"):
            load_catalog(self.source)

    def test_failed_atomic_replace_keeps_previous_file_and_removes_temporary(self) -> None:
        self.output.write_bytes(b"previous")
        with (
            patch.object(Path, "replace", side_effect=OSError("disk error")),
            self.assertRaisesRegex(OSError, "disk error"),
        ):
            atomic_write(self.output, b"new")
        self.assertEqual(self.output.read_bytes(), b"previous")
        self.assertEqual(list(self.root.glob(".catalog.json.*")), [])

    def test_cli_reports_invalid_source_without_traceback(self) -> None:
        self.source.write_text("{broken")
        error = io.StringIO()
        with contextlib.redirect_stderr(error):
            result = main(["build", "--source", str(self.source), "--output", str(self.output)])
        self.assertEqual(result, 1)
        self.assertIn("catalog:", error.getvalue())
        self.assertNotIn("Traceback", error.getvalue())

    def test_entire_curated_catalog_is_preserved(self) -> None:
        source = json.loads(DEFAULT_SOURCE.read_text(encoding="utf-8"))
        catalog = load_catalog(DEFAULT_SOURCE)
        self.assertEqual(len(catalog), len(source))
        self.assertEqual({clip.id for clip in catalog}, set(source))
        for clip in catalog:
            self.assertEqual(clip.url, source[clip.id]["url"])
            self.assertEqual(list(clip.keywords), source[clip.id]["keywords"])

    def test_serialization_cleans_legacy_keywords_stably_without_changing_raw_input(self) -> None:
        keywords = [
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
        clips = parse_catalog(
            {"a1": {"url": "https://giphy.com/gifs/clip-a1", "keywords": keywords}}
        )
        first = serialize_catalog(clips)
        output = json.loads(first)[0]
        self.assertEqual(
            output["keywords"],
            [
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
            ],
        )
        self.assertEqual(clips[0].keywords, tuple(keywords))
        corrected = parse_catalog({"a1": {"url": output["url"], "keywords": output["keywords"]}})
        self.assertEqual(serialize_catalog(corrected), first)

    def test_offline_build_applies_cleanup_without_rewriting_source(self) -> None:
        self.write_source(
            {"a1": {"url": "https://giphy.com/gifs/a1", "keywords": ["smojlak", "ctenisverak"]}}
        )
        original = self.source.read_bytes()
        with contextlib.redirect_stdout(io.StringIO()):
            build_catalog(self.source, self.output)
            first = self.output.read_bytes()
            build_catalog(self.source, self.output)
        self.assertEqual(json.loads(first)[0]["keywords"], ["smoljak"])
        self.assertEqual(self.output.read_bytes(), first)
        self.assertEqual(self.source.read_bytes(), original)


if __name__ == "__main__":
    unittest.main()
