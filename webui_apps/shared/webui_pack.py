"""Package a plain HTML/JS app's src/ as a BigFix WebUI extension (.webui), with only the Python standard library.

Shared by the plain HTML/JS apps in webui_apps/: each app's pack.py lists the shared files it needs and calls main().
Produces the same layout as the WebUI SDK template's `npm run packit`:

    output/<name>-<version>.webui   (a zip)
      package.json                  package.json from the app folder, plus "main": "./index.html"
      <name>-<version>/index.html   everything under src/
      <name>-<version>/static/...   plus each shared file, as static/js/<file name> unless mapped elsewhere

Usage (from the app folder):
    python3 pack.py            build output/<name>-<version>.webui
    python3 pack.py --dry-run  validate and list what would be packaged, write nothing
"""

import argparse
import json
import re
import sys
import zipfile
from pathlib import Path

SHARED_DIR = Path(__file__).resolve().parent

# same rules the template's validatePackage.js enforces
NAME_RE = re.compile(r"^[a-z0-9_-]+$")
VERSION_RE = re.compile(r"^\d+(\.\d+)*$")

# editor/OS clutter that should never ship
SKIP_NAMES = {".DS_Store", "Thumbs.db"}


def load_package_json(app_dir):
    path = app_dir / "package.json"
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


def source_files(app_dir, shared_files, extra_files):
    """(path on disk, path inside the package) for every file to ship."""
    src_dir = app_dir / "src"
    if not (src_dir / "index.html").is_file():
        sys.exit(f"ERROR: {src_dir / 'index.html'} not found")
    files = [(p, p.relative_to(src_dir).as_posix()) for p in sorted(src_dir.rglob("*")) if p.is_file() and p.name not in SKIP_NAMES]
    for name in shared_files:
        path = SHARED_DIR / name
        if not path.is_file():
            sys.exit(f"ERROR: shared file {path} not found")
        files.append((path, f"static/js/{Path(name).name}"))
    for path, inside in extra_files:
        if not path.is_file():
            sys.exit(f"ERROR: {path} not found")
        files.append((path, inside))
    return files


def main(app_dir, shared_files, extra_files=(), warnings=()):
    """app_dir: the app folder. shared_files: paths under shared/, packaged as static/js/<file name>.
    extra_files: (path on disk, path inside the package) for files from elsewhere in the repo.
    warnings: (file under src/, message) pairs, printed when that file is missing."""
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dry-run", action="store_true", help="validate and list files without writing the package")
    args = parser.parse_args()

    app_dir = Path(app_dir).resolve()
    package = load_package_json(app_dir)
    root = f"{package['name']}-{package['version']}"
    files = source_files(app_dir, shared_files, extra_files)
    for path, message in warnings:
        if not (app_dir / "src" / path).is_file():
            print(f"WARNING: {message}")
    out_dir = app_dir / "output"
    out_path = out_dir / f"{root}.webui"

    print(f"Packaging {package['displayName']} as {out_path.relative_to(app_dir)}")
    for path, inside in files:
        print(f"  {root}/{inside}")
    if args.dry_run:
        print("Dry run: nothing written")
        return

    out_dir.mkdir(exist_ok=True)
    with zipfile.ZipFile(out_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        archive.writestr("package.json", json.dumps(package, indent=2) + "\n")
        for path, inside in files:
            archive.write(path, f"{root}/{inside}")

    print(f"Wrote {out_path.relative_to(app_dir)} ({out_path.stat().st_size:,} bytes)")
