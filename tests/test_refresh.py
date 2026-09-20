import contextlib
import io
import json
import os
import tempfile
import unittest
from email.message import Message
from pathlib import Path
from unittest.mock import Mock, patch
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlsplit

from scripts.catalog import parse_catalog
from scripts.refresh import (
    API_URL,
    RemoteClip,
    SearchScan,
    fetch_search,
    load_api_key,
    main,
    merge_search,
    parse_remote_clip,
    read_page,
    refresh_catalog,
)


def record(clip_id: str) -> dict[str, object]:
    return {
        "id": clip_id,
        "url": f"https://giphy.com/gifs/clip-{clip_id}",
    }


def page(
    records: list[dict[str, object]], *, offset: int = 0, total: int | None = None
) -> dict[str, object]:
    return {
        "data": records,
        "pagination": {
            "count": len(records),
            "offset": offset,
            "total_count": len(records) if total is None else total,
        },
        "meta": {"status": 200},
    }


class RefreshTests(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.source = self.root / "source.json"
        self.report = self.root / "report.json"
        self.ignore = self.root / "ignore.csv"
        self.ignore.write_text("")
        self.source.write_text(
            json.dumps({"a1": {"url": "https://giphy.com/gifs/clip-a1", "keywords": ["smojlak"]}})
        )

    def test_follows_official_pagination_until_reported_total(self) -> None:
        fetch = Mock(
            side_effect=[
                page([record("a1")], total=2),
                page([record("b2")], offset=1, total=2),
            ]
        )
        with contextlib.redirect_stderr(io.StringIO()):
            scan = fetch_search(fetch)
        self.assertEqual(scan.pages, 2)
        self.assertEqual(scan.rows, 2)
        self.assertEqual([clip.id for clip in scan.clips], ["a1", "b2"])
        self.assertEqual(fetch.call_args_list[1].args, (1,))

    def test_rejects_invalid_incomplete_or_out_of_window_search_responses(self) -> None:
        for response in [
            {"data": [record("a1")]},
            page([record("a1")], offset=1),
            page([], total=2),
            page([record("../invalid")]),
            page([record("a1")], total=5001),
            {**page([record("a1")]), "meta": {"status": 403}},
            {**page([record("a1")]), "pagination": {"count": 2, "offset": 0, "total_count": 2}},
        ]:
            with (
                self.subTest(response=response),
                contextlib.redirect_stderr(io.StringIO()),
                self.assertRaises(ValueError),
            ):
                fetch_search(Mock(return_value=response))

    def test_identical_duplicates_are_reported_and_conflicting_duplicates_fail(self) -> None:
        response = page([record("a1"), record("a1")])
        with contextlib.redirect_stderr(io.StringIO()):
            scan = fetch_search(Mock(return_value=response))
        self.assertEqual(len(scan.clips), 1)
        self.assertEqual(scan.rows, 2)
        self.assertEqual(scan.duplicate_ids, ("a1",))
        response["data"] = [record("a1"), {**record("a1"), "url": "https://giphy.com/gifs/new-a1"}]
        with self.assertRaisesRegex(ValueError, "conflicting duplicate"):
            fetch_search(Mock(return_value=response))

    def test_nonterminal_duplicate_only_page_fails_without_following_next_offset(self) -> None:
        fetch = Mock(
            side_effect=[
                page([record("a1")], total=3),
                page([record("a1")], offset=1, total=3),
                page([record("b2")], offset=2, total=3),
            ]
        )
        with (
            contextlib.redirect_stderr(io.StringIO()),
            self.assertRaisesRegex(ValueError, "no new IDs"),
        ):
            fetch_search(fetch)
        self.assertEqual(fetch.call_count, 2)

    def test_merge_retains_unreturned_history_and_meaningful_near_matches(self) -> None:
        old = parse_catalog(
            {
                "a1": {"url": "https://giphy.com/gifs/clip-a1", "keywords": ["smojlak", "cepel"]},
                "b2": {"url": "https://giphy.com/gifs/clip-b2", "keywords": ["milou", "penice"]},
            }
        )
        scan = SearchScan((RemoteClip("a1", old[0].url),), 1, 1, 1, ())
        merged, report = merge_search(old, scan, set())
        parsed = {clip.id: clip for clip in parse_catalog(merged)}
        self.assertEqual(parsed["a1"].keywords, ("smoljak", "cepel"))
        self.assertEqual(parsed["b2"].keywords, ("milou", "penice"))
        self.assertEqual(report["notFoundInSearch"], ["b2"])
        self.assertFalse(report["collectionComplete"])

    def test_refresh_cleans_legacy_keywords_once_and_reports_exact_removals(self) -> None:
        old = parse_catalog(
            {
                "a1": {
                    "url": "https://giphy.com/gifs/clip-a1",
                    "keywords": ["smojlak", "smoljak", "ctenisverak", "sveraknarozeniny", "cepel"],
                }
            }
        )
        scan = SearchScan((RemoteClip("a1", old[0].url),), 1, 1, 1, ())
        first, report = merge_search(old, scan, set())
        self.assertEqual(parse_catalog(first)[0].keywords, ("smoljak", "cepel"))
        self.assertEqual(
            report["keywordCorrections"],
            [
                {"id": "a1", "from": "smojlak", "to": "smoljak"},
                {"id": "a1", "from": "ctenisverak", "to": None},
                {"id": "a1", "from": "sveraknarozeniny", "to": None},
            ],
        )
        second, second_report = merge_search(parse_catalog(first), scan, set())
        self.assertEqual(second, first)
        self.assertEqual(second_report["keywordCorrections"], [])

    def test_new_entries_require_curated_keywords_and_ignored_records_are_reported(self) -> None:
        old = parse_catalog(
            {"a1": {"url": "https://giphy.com/gifs/clip-a1", "keywords": ["existing"]}}
        )
        scan = SearchScan(
            (
                RemoteClip("a1", old[0].url),
                RemoteClip("b2", "https://giphy.com/gifs/clip-b2"),
                RemoteClip("c3", "https://giphy.com/gifs/clip-c3"),
            ),
            1,
            3,
            3,
            (),
        )
        merged, report = merge_search(old, scan, {"c3"})
        parsed = {clip.id: clip for clip in parse_catalog(merged)}
        self.assertEqual(parsed["a1"].keywords, ("existing",))
        self.assertEqual(parsed["b2"].keywords, ())
        self.assertNotIn("c3", parsed)
        self.assertEqual(report["ignoredNewIds"], ["c3"])
        self.assertEqual(report["needsKeywordReview"], ["b2"])
        self.assertEqual(report["newIds"], ["b2"])

    def test_pending_keyword_review_survives_repeated_refresh_and_cleanup(self) -> None:
        old = parse_catalog(
            {"a1": {"url": "https://giphy.com/gifs/clip-a1", "keywords": ["ctenisverak"]}}
        )
        scan = SearchScan(
            (RemoteClip("a1", old[0].url), RemoteClip("b2", "https://giphy.com/gifs/clip-b2")),
            1,
            2,
            2,
            (),
        )
        first, report = merge_search(old, scan, set())
        self.assertEqual(report["needsKeywordReview"], ["a1", "b2"])
        second, second_report = merge_search(parse_catalog(first), scan, set())
        self.assertEqual(second, first)
        self.assertEqual(second_report["newIds"], [])
        self.assertEqual(second_report["needsKeywordReview"], ["a1", "b2"])

    def test_failed_second_page_leaves_both_files_unchanged(self) -> None:
        original = self.source.read_bytes()
        self.report.write_bytes(b"previous report")
        fetch = Mock(
            side_effect=[
                page([record("a1")], total=2),
                OSError("network unavailable"),
            ]
        )
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(OSError):
            refresh_catalog(self.source, self.report, self.ignore, fetch=fetch)
        self.assertEqual(self.source.read_bytes(), original)
        self.assertEqual(self.report.read_bytes(), b"previous report")

    def test_successful_refresh_writes_valid_catalog_and_coverage_report(self) -> None:
        fetch = Mock(return_value=page([record("a1"), record("b2")]))
        with contextlib.redirect_stderr(io.StringIO()):
            report = refresh_catalog(self.source, self.report, self.ignore, fetch=fetch)
        self.assertEqual(report["catalogCount"], 2)
        self.assertEqual(report["sourceCount"], 2)
        self.assertEqual(report["newIds"], ["b2"])
        self.assertEqual(
            report["keywordCorrections"], [{"id": "a1", "from": "smojlak", "to": "smoljak"}]
        )
        self.assertEqual(json.loads(self.report.read_text()), report)
        self.assertEqual(set(json.loads(self.source.read_text())), {"a1", "b2"})

    def test_concurrent_source_change_is_never_overwritten(self) -> None:
        def fetch(_: int) -> object:
            self.source.write_bytes(b"a concurrent edit")
            return page([record("a1")])

        with (
            contextlib.redirect_stderr(io.StringIO()),
            self.assertRaisesRegex(ValueError, "changed during refresh"),
        ):
            refresh_catalog(self.source, self.report, self.ignore, fetch=fetch)
        self.assertEqual(self.source.read_bytes(), b"a concurrent edit")
        self.assertFalse(self.report.exists())

    def test_all_input_output_path_collisions_fail_before_fetching(self) -> None:
        report_alias = self.root / "report-alias.json"
        report_alias.symlink_to(self.ignore)
        source_alias = self.root / "source-alias.json"
        source_alias.symlink_to(self.source)
        original_source, original_ignore = self.source.read_bytes(), self.ignore.read_bytes()
        paths = [
            (self.source, self.source, self.ignore),
            (self.source, self.ignore, self.ignore),
            (self.source, self.report, self.source),
            (self.source, report_alias, self.ignore),
            (self.source, self.report, source_alias),
        ]
        for source, report, ignore in paths:
            with self.subTest(paths=(source, report, ignore)):
                fetch = Mock(return_value=page([record("a1")]))
                with self.assertRaisesRegex(ValueError, "distinct"):
                    refresh_catalog(source, report, ignore, fetch=fetch)
                fetch.assert_not_called()
                self.assertEqual(self.source.read_bytes(), original_source)
                self.assertEqual(self.ignore.read_bytes(), original_ignore)

    def test_invalid_report_destination_never_changes_source(self) -> None:
        self.report.mkdir()
        original = self.source.read_bytes()
        fetch = Mock(return_value=page([record("a1")]))
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(OSError):
            refresh_catalog(self.source, self.report, self.ignore, fetch=fetch)
        self.assertEqual(self.source.read_bytes(), original)
        self.assertEqual(list(self.root.glob(".*.json.*")), [])

    def test_failed_report_replacement_restores_original_source(self) -> None:
        original = self.source.read_bytes()
        self.report.write_bytes(b"previous report")
        real_replace = Path.replace

        def replace(path: Path, target: Path) -> Path:
            if target == self.report:
                raise OSError("report replacement failed")
            return real_replace(path, target)

        fetch = Mock(return_value=page([record("a1")]))
        with (
            patch.object(Path, "replace", replace),
            contextlib.redirect_stderr(io.StringIO()),
            self.assertRaisesRegex(OSError, "report replacement failed"),
        ):
            refresh_catalog(self.source, self.report, self.ignore, fetch=fetch)
        self.assertEqual(self.source.read_bytes(), original)
        self.assertEqual(self.report.read_bytes(), b"previous report")
        self.assertEqual(list(self.root.glob(".*.json.*")), [])

    def test_report_failure_preserves_later_concurrent_edit_and_reports_partial_update(
        self,
    ) -> None:
        real_replace = Path.replace

        def replace(path: Path, target: Path) -> Path:
            if target == self.report:
                self.source.write_bytes(b"a later concurrent edit")
                raise OSError("report replacement failed")
            return real_replace(path, target)

        fetch = Mock(return_value=page([record("a1")]))
        with (
            patch.object(Path, "replace", replace),
            contextlib.redirect_stderr(io.StringIO()),
            self.assertRaisesRegex(OSError, "source changed again; not rolled back"),
        ):
            refresh_catalog(self.source, self.report, self.ignore, fetch=fetch)
        self.assertEqual(self.source.read_bytes(), b"a later concurrent edit")
        self.assertFalse(self.report.exists())

    def test_failed_rollback_reports_partial_update(self) -> None:
        real_replace = Path.replace
        source_replacements = 0

        def replace(path: Path, target: Path) -> Path:
            nonlocal source_replacements
            if target == self.report:
                raise OSError("report replacement failed")
            source_replacements += 1
            if source_replacements > 1:
                raise OSError("rollback blocked")
            return real_replace(path, target)

        fetch = Mock(return_value=page([record("a1")]))
        with (
            patch.object(Path, "replace", replace),
            contextlib.redirect_stderr(io.StringIO()),
            self.assertRaisesRegex(OSError, "source rollback failed"),
        ):
            refresh_catalog(self.source, self.report, self.ignore, fetch=fetch)
        self.assertEqual(json.loads(self.source.read_text())["a1"]["keywords"], ["smoljak"])
        self.assertFalse(self.report.exists())

    def test_undocumented_tags_and_title_are_never_imported(self) -> None:
        raw = {
            **record("b2"),
            "tags": ["sveraknarozeniny", "ctenisverak", "sveraklooking"],
            "title": "Smoljak hate GIF",
        }
        fetch = Mock(return_value=page([raw]))
        with contextlib.redirect_stderr(io.StringIO()):
            report = refresh_catalog(self.source, self.report, self.ignore, fetch=fetch)
        catalog = json.loads(self.source.read_text())
        self.assertEqual(catalog["b2"]["keywords"], [])
        self.assertEqual(catalog["a1"]["keywords"], ["smoljak"])
        self.assertEqual(report["needsKeywordReview"], ["b2"])
        self.assertFalse(report["collectionComplete"])

    def test_documented_http_giphy_page_url_is_upgraded_before_validation(self) -> None:
        clip = parse_remote_clip({**record("a1"), "url": "http://giphy.com/gifs/clip-a1"})
        self.assertEqual(clip.url, "https://giphy.com/gifs/clip-a1")
        for url in [
            "http://example.com/gifs/clip-a1",
            "http://giphy.com.example.com/gifs/clip-a1",
            "http://user@giphy.com/gifs/clip-a1",
            "http://giphy.com:80/gifs/clip-a1",
            "http://giphy.com/gifs/clip-a1?unexpected=value",
            "http://giphy.com/gifs/clip-a1#fragment",
            "http://giphy.com/gifs/clip-b2",
        ]:
            with self.subTest(url=url), self.assertRaises(ValueError):
                parse_remote_clip({**record("a1"), "url": url})

    def test_api_key_comes_from_environment_or_ignored_legacy_file(self) -> None:
        key_file = self.root / "API_KEY"
        key_file.write_text("file-test-key\n")
        with patch.dict(os.environ, {"GIPHY_API_KEY": "env-test-key"}, clear=True):
            self.assertEqual(load_api_key(key_file), "env-test-key")
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(load_api_key(key_file), "file-test-key")
            key_file.unlink()
            with self.assertRaisesRegex(ValueError, "GIPHY_API_KEY"):
                load_api_key(key_file)

    def test_missing_key_cli_fails_before_requests_or_writes(self) -> None:
        original = self.source.read_bytes()
        error = io.StringIO()
        with (
            patch("scripts.refresh.load_api_key", side_effect=ValueError("Set GIPHY_API_KEY")),
            patch("scripts.refresh.read_page") as request,
            contextlib.redirect_stderr(error),
        ):
            result = main(
                [
                    "--source",
                    str(self.source),
                    "--report",
                    str(self.report),
                    "--ignore",
                    str(self.ignore),
                ]
            )
        self.assertEqual(result, 1)
        self.assertIn("GIPHY_API_KEY", error.getvalue())
        self.assertNotIn("Traceback", error.getvalue())
        request.assert_not_called()
        self.assertEqual(self.source.read_bytes(), original)
        self.assertFalse(self.report.exists())

    def test_requests_use_official_endpoint_and_key_is_not_exposed_in_errors(self) -> None:
        key = "private-test-key"
        errors = [
            HTTPError(f"{API_URL}?api_key={key}", 403, f"bad key: {key}", Message(), None),
            URLError(f"failed request api_key={key}"),
        ]
        for error in errors:
            with (
                self.subTest(error=type(error).__name__),
                patch("scripts.refresh.urlopen", side_effect=error) as open_url,
            ):
                with self.assertRaises(ValueError) as caught:
                    read_page(key, 50)
                self.assertNotIn(key, str(caught.exception))
                self.assertIsNone(caught.exception.__cause__)
                request = open_url.call_args.args[0]
                parts = urlsplit(request.full_url)
                self.assertEqual(f"{parts.scheme}://{parts.netloc}{parts.path}", API_URL)
                self.assertEqual(parse_qs(parts.query)["channel_ids"], ["26940091"])
                self.assertEqual(parse_qs(parts.query)["q"], ["cimrman"])
                self.assertEqual(parse_qs(parts.query)["offset"], ["50"])


if __name__ == "__main__":
    unittest.main()
