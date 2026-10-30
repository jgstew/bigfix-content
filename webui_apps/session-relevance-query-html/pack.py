#!/usr/bin/env python3
"""Package src/ as a BigFix WebUI extension (.webui) with only the Python standard library.

Produces the same layout as the WebUI SDK template's `npm run packit`:

    output/<name>-<version>.webui   (a zip)
      package.json                  package.json from this folder, plus "main": "./index.html"
      <name>-<version>/index.html   everything under src/
      <name>-<version>/static/...

Usage:
    python3 pack.py            build output/<name>-<version>.webui
    python3 pack.py --dry-run  validate and list what would be packaged, write nothing
"""

import argparse
import json
import re
import sys
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
SRC_DIR = HERE / "src"
OUT_DIR = HERE / "output"

# same rules the template's validatePackage.js enforces
NAME_RE = re.compile(r"^[a-z0-9_-]+$")
VERSION_RE = re.compile(r"^\d+(\.\d+)*$")

# editor/OS clutter that should never ship
SKIP_NAMES = {".DS_Store", "Thumbs.db"}


def load_package_json():
    path = HERE / "package.json"
    try:
        package = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as err:
        sys.exit(f"ERROR: cannot read {path}: {err}")

    name = package.get("name", "")
    version = package.get("version", "")
    if not NAME_RE.match(name):
        sys.exit(f"ERROR: package.json name {name!r} must match {NAME_RE.pattern}")
    if not VERSION_RE.match(version):
        sys.exit(f"ERROR: package.json version {version!r} must match {VERSION_RE.pattern}")
    if not package.get("displayName"):
        sys.exit("ERROR: package.json needs a displayName; WebUI shows it in the Extensions menu")

    package["main"] = "./index.html"
    return package


def source_files():
    if not (SRC_DIR / "index.html").is_file():
        sys.exit(f"ERROR: {SRC_DIR / 'index.html'} not found")
    return sorted(p for p in SRC_DIR.rglob("*") if p.is_file() and p.name not in SKIP_NAMES)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dry-run", action="store_true", help="validate and list files without writing the package")
    args = parser.parse_args()

    package = load_package_json()
    root = f"{package['name']}-{package['version']}"
    files = source_files()
    if not (SRC_DIR / "static" / "analyzer" / "manifest.json").is_file():
        print("WARNING: src/static/analyzer/ is missing; run fetch_analyzer.py first.")
        print("         Without it the package runs session relevance only (no analyzer, no Auto mode).")
    out_path = OUT_DIR / f"{root}.webui"

    print(f"Packaging {package['displayName']} as {out_path.relative_to(HERE)}")
    for path in files:
        print(f"  {root}/{path.relative_to(SRC_DIR).as_posix()}")
    if args.dry_run:
        print("Dry run: nothing written")
        return

    OUT_DIR.mkdir(exist_ok=True)
    with zipfile.ZipFile(out_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        archive.writestr("package.json", json.dumps(package, indent=2) + "\n")
        for path in files:
            archive.write(path, f"{root}/{path.relative_to(SRC_DIR).as_posix()}")

    print(f"Wrote {out_path.relative_to(HERE)} ({out_path.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
