import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parents[1] / "agent"))
import version_info as version


class VersionTests(unittest.TestCase):
    def test_installed_metadata_survives_checkout_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            module = Path(directory) / "version_info.py"
            stored = {"version": "1.1.0", "deployment_version": "1.1", "revision": "a" * 40,
                      "dirty": False, "installed_at": "2026-09-14T00:00:00+00:00"}
            module.with_name("version.json").write_text(json.dumps(stored))
            version.runtime_version.cache_clear()
            try:
                with patch.object(version, "__file__", str(module)), \
                     patch.object(version, "source_version", side_effect=AssertionError("must read installed copy")):
                    self.assertEqual(version.runtime_version(), stored)
            finally:
                version.runtime_version.cache_clear()

    def test_git_revision_and_dirty_source_are_reported_truthfully(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "VERSION").write_text("1.1.0\n")
            (root / "agent").mkdir()
            code = root / "agent" / "example.py"
            code.write_text("original\n")
            def git(*args):
                return subprocess.check_output(["git", "-C", directory, *args], text=True).strip()
            git("init", "-q")
            git("add", "VERSION", "agent")
            git("-c", "user.name=Version Test", "-c", "user.email=fixture@example.invalid",
                "commit", "-qm", "fixture")
            info = version.source_version(root)
            self.assertEqual(info["revision"], git("rev-parse", "HEAD"))
            self.assertEqual(info["deployment_version"], "1.1")
            self.assertFalse(info["dirty"])
            code.write_text("changed\n")
            self.assertTrue(version.source_version(root)["dirty"])

    def test_missing_git_metadata_is_unknown_not_the_latest_commit(self):
        with tempfile.TemporaryDirectory() as directory:
            (Path(directory) / "VERSION").write_text("1.1.0\n")
            with patch.object(version.subprocess, "run", side_effect=FileNotFoundError()):
                info = version.source_version(directory)
            self.assertIsNone(info["revision"])
            self.assertIsNone(info["dirty"])


if __name__ == "__main__":
    unittest.main()
