"""Repair old csdn2md archives whose CSDN equations point to missing assets."""

import argparse
import json
import re
import zipfile
from html.parser import HTMLParser
from pathlib import Path


IMAGE = re.compile(r"!\[(.*?)\]\((\./[^\n]+?)\)")
HTML_IMAGE = re.compile(r'''<img\b(?:"[^"]*"|'[^']*'|[^'">])*>''', re.IGNORECASE)
BROKEN_FORMULA_PATH = re.compile(r"\./assets/\d+_\d+$")


class ImageAttributes(HTMLParser):
    def handle_starttag(self, tag, attrs):
        if tag == "img":
            self.attributes = dict(attrs)


def repair_markdown(text, names):
    count = 0

    def recover(latex, target, original):
        nonlocal count
        if target[2:] in names or not BROKEN_FORMULA_PATH.fullmatch(target) or not latex.strip():
            return original
        count += 1
        # Preserve the document's paragraph boundaries; only replace the broken reference.
        return "$" + latex.strip() + "$"

    def replace_html(match):
        parser = ImageAttributes()
        parser.feed(match[0])
        attrs = getattr(parser, "attributes", {})
        return recover(attrs.get("alt") or "", attrs.get("src") or "", match[0])

    text = IMAGE.sub(lambda match: recover(*match.groups(), match[0]), text)
    return HTML_IMAGE.sub(replace_html, text), count


def repair_archive(source, output_dir):
    target = output_dir / (source.stem + "_已修复.zip")
    if target.exists():
        raise FileExistsError(f"Output already exists: {target}")
    changed = {}
    with zipfile.ZipFile(source) as original, zipfile.ZipFile(target, "w") as repaired:
        names = set(original.namelist())
        repaired.comment = original.comment
        for info in original.infolist():
            payload = original.read(info)
            if info.filename.endswith(".md"):
                bom = payload.startswith(b"\xef\xbb\xbf")
                markdown, count = repair_markdown(payload.decode("utf-8-sig"), names)
                if count:
                    payload = markdown.encode("utf-8-sig" if bom else "utf-8")
                    changed[info.filename] = count
            repaired.writestr(info, payload, compresslevel=1)

    with zipfile.ZipFile(source) as original, zipfile.ZipFile(target) as repaired:
        assert original.namelist() == repaired.namelist(), "Archive entries changed"
        for info in original.infolist():
            if info.filename not in changed:
                assert repaired.getinfo(info.filename).CRC == info.CRC, info.filename
        assert repaired.testzip() is None, "Corrupt ZIP entry"
        remaining = []
        for name in repaired.namelist():
            if name.endswith(".md"):
                text = repaired.read(name).decode("utf-8-sig")
                remaining.extend((name, m[2]) for m in IMAGE.finditer(text) if m[2][2:] not in names)
                for match in HTML_IMAGE.finditer(text):
                    parser = ImageAttributes()
                    parser.feed(match[0])
                    src = parser.attributes.get("src") or ""
                    if src.startswith("./") and src[2:] not in names:
                        remaining.append((name, src))
        if remaining:
            raise ValueError(f"Unresolved image references: {remaining[:5]}")
    return {"source": str(source), "output": str(target), "formulas_repaired": sum(changed.values()),
            "articles_changed": changed, "missing_markdown_images": len(remaining)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archives", nargs="+", type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    args = parser.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    results = []
    for source in args.archives:
        result = repair_archive(source, args.output_dir)
        results.append(result)
        print(json.dumps(result, ensure_ascii=False), flush=True)
    (args.output_dir / "repair-report.json").write_text(
        json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
