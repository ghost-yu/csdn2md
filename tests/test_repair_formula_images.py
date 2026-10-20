import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from repair_formula_images import repair_archive, repair_markdown


class RepairFormulaImagesTests(unittest.TestCase):
    def test_nested_formula_brackets_are_preserved(self):
        text, count = repair_markdown(r"shape ![[196, 768]](./assets/01_2)", set())
        self.assertEqual(text, "shape $[196, 768]$")
        self.assertEqual(count, 1)

    def test_existing_images_and_unrelated_missing_images_are_untouched(self):
        text = "![x](./assets/01_2) ![photo](./assets/missing.png)"
        self.assertEqual(repair_markdown(text, {"assets/01_2"}), (text, 0))

    def test_html_formula_images_decode_entities(self):
        text, count = repair_markdown(
            '<img src="./assets/02_6" alt="x &amp; y" style="height:2em;" />', set())
        self.assertEqual(text, "$x & y$")
        self.assertEqual(count, 1)

    def test_zip_preserves_assets_and_original_archive(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "article.zip"
            with zipfile.ZipFile(source, "w") as archive:
                archive.writestr("article.md", "![x](./assets/01_2) ![photo](./assets/photo.png)")
                archive.writestr("assets/photo.png", b"image bytes")
            original = source.read_bytes()
            result = repair_archive(source, root)
            self.assertEqual(result["formulas_repaired"], 1)
            self.assertEqual(source.read_bytes(), original)
            with zipfile.ZipFile(result["output"]) as archive:
                self.assertEqual(archive.read("assets/photo.png"), b"image bytes")
                self.assertIn(b"$x$", archive.read("article.md"))
            with self.assertRaises(FileExistsError):
                repair_archive(source, root)


if __name__ == "__main__":
    unittest.main()
