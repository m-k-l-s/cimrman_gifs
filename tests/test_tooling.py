import tomllib
import unittest
from urllib.parse import urlsplit

from scripts.catalog import ROOT


class ToolingTests(unittest.TestCase):
    def test_locked_python_dependencies_use_public_package_hosts(self) -> None:
        lock = tomllib.loads((ROOT / "uv.lock").read_text(encoding="utf-8"))
        for package in lock["package"]:
            if "registry" not in package["source"]:
                continue
            with self.subTest(package=package["name"]):
                self.assertEqual(package["source"]["registry"], "https://pypi.org/simple")
                for artifact in [package["sdist"], *package["wheels"]]:
                    url = urlsplit(artifact["url"])
                    self.assertEqual(url.scheme, "https")
                    self.assertEqual(url.hostname, "files.pythonhosted.org")


if __name__ == "__main__":
    unittest.main()
