from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path

import embed as e


def _vault(root: Path) -> None:
    (root / "a.md").write_text("# A\n\nalpha\n")
    (root / "sub").mkdir()
    (root / "sub" / "b.md").write_text("beta\n")
    (root / ".obsidian").mkdir()
    (root / ".obsidian" / "x.md").write_text("ignored\n")
    (root / ".trash").mkdir()
    (root / ".trash" / "y.md").write_text("ignored\n")
    (root / "c.txt").write_text("not markdown\n")


class StoreTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / "vault"
        self.root.mkdir()
        _vault(self.root)
        self.conn = e.connect(Path(self.tmp.name) / "idx.sqlite")
        self.spec = e.FolderSpec("V", str(self.root), e.DEFAULT_MODEL, 512,
                                 e.DEFAULT_INCLUDE, e.DEFAULT_EXCLUDE)

    def tearDown(self) -> None:
        self.conn.close()
        self.tmp.cleanup()

    def test_walk_skips_dot_dirs_and_non_markdown(self) -> None:
        self.assertEqual(sorted(e.walk(self.spec)), ["a.md", "sub/b.md"])

    def test_folder_roundtrip_and_path_conflict(self) -> None:
        e.upsert_folder(self.conn, self.spec)
        self.assertEqual(e.get_folder(self.conn, "V"), self.spec)
        with self.assertRaises(e.EmbedError):
            e.upsert_folder(self.conn, e.FolderSpec("V", "/elsewhere", e.DEFAULT_MODEL, 512,
                                                    e.DEFAULT_INCLUDE, e.DEFAULT_EXCLUDE))

    def test_unindexed_folder_lists_everything_as_changed(self) -> None:
        e.upsert_folder(self.conn, self.spec)
        [row] = e.list_folders(self.conn)
        self.assertEqual((row["files"], row["chunks"], row["changed"], row["indexed_at"]),
                         (0, 0, 2, None))
        ch = e.plan_changes(self.conn, self.spec)
        self.assertEqual(sorted(ch.added), ["a.md", "sub/b.md"])

    def test_delete_cascades(self) -> None:
        e.upsert_folder(self.conn, self.spec)
        self.assertTrue(e.delete_folder(self.conn, "V"))
        self.assertFalse(e.delete_folder(self.conn, "V"))
        self.assertEqual(e.list_folders(self.conn), [])

    def test_index_path_honours_env(self) -> None:
        os.environ["MODELCTL_VAULT_INDEX"] = "/tmp/x.sqlite"
        try:
            self.assertEqual(e.index_path(), Path("/tmp/x.sqlite"))
        finally:
            del os.environ["MODELCTL_VAULT_INDEX"]
