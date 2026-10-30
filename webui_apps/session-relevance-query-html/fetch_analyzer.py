#!/usr/bin/env python3
"""Download the bigfix-relevance-analyzer browser build into src/static/analyzer/ (Python standard library only).

The analyzer (https://github.com/jgstew/bigfix-relevance-analyzer, MIT) is published with each GitHub release as
bigfix-relevance-analyzer-web.zip: manifest.json, editor.js, glue.mjs and gzipped WebAssembly cores. The page loads
it in the background; without it the page still runs session relevance with a plain text box.

The release and the zip's SHA-256 are pinned below. To move to a new release, update both from the release's
SHA256SUMS.txt (the line for ./bigfix-relevance-analyzer-web.zip).

Usage:
    python3 fetch_analyzer.py            download, verify, and install into src/static/analyzer/
    python3 fetch_analyzer.py --dry-run  download and verify, but leave src/static/analyzer/ unchanged
"""

import argparse
import hashlib
import io
import json
import shutil
import sys
import tempfile
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

ANALYZER_VERSION = "1.43.0"
ZIP_SHA256 = "912995c34ef1d9598ea43b29eedbaddc70d754b98a97d7bda0dab81ba569466d"
ZIP_URL = (
    "https://github.com/jgstew/bigfix-relevance-analyzer/releases/download/"
    f"v{ANALYZER_VERSION}/bigfix-relevance-analyzer-web.zip"
)

HERE = Path(__file__).resolve().parent
DEST = HERE / "src" / "static" / "analyzer"
MAX_ZIP_BYTES = 64 * 1024 * 1024  # the 1.43.0 zip is about 8.5 MB; refuse anything absurd
SKIP_FILES = {"index.html"}  # the analyzer's own playground page, not part of the manifest


def download(url, attempts=4):
    """GET url with retries and exponential backoff; returns the body bytes."""
    for attempt in range(1, attempts + 1):
        try:
            with urllib.request.urlopen(url, timeout=60) as response:
                data = response.read(MAX_ZIP_BYTES + 1)
            if len(data) > MAX_ZIP_BYTES:
                sys.exit(f"ERROR: {url} is larger than {MAX_ZIP_BYTES} bytes")
            return data
        except (urllib.error.URLError, TimeoutError) as err:
            if attempt == attempts:
                sys.exit(f"ERROR: downloading {url} failed after {attempts} attempts: {err}")
            delay = 2 ** attempt
            print(f"  download failed ({err}); retrying in {delay}s")
            time.sleep(delay)


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def check_manifest(files):
    """Validate the set the way the analyzer's consumer contract asks (tools/playground-wasm/SPLIT_ANALYZER.md)."""
    try:
        manifest = json.loads(files["manifest.json"])
    except (KeyError, json.JSONDecodeError) as err:
        sys.exit(f"ERROR: manifest.json missing or invalid: {err}")
    if manifest.get("format") != 1 or manifest.get("package") != "bigfix-relevance-analyzer":
        sys.exit("ERROR: unknown manifest format or package; refusing the set")
    if manifest.get("version") != ANALYZER_VERSION:
        sys.exit(f"ERROR: manifest version {manifest.get('version')} is not the pinned {ANALYZER_VERSION}")

    entries = [manifest["editor"], manifest["glue"], *manifest["cores"]]
    for entry in entries:
        path = entry["path"]
        if "/" in path or ".." in path or path not in files:
            sys.exit(f"ERROR: manifest names {path!r}, which is missing or not a bare file name")
        data = files[path]
        if len(data) != entry["size"] or sha256(data) != entry["sha256"]:
            sys.exit(f"ERROR: {path} does not match manifest.json (size or sha256)")
    unused = set(files) - {e["path"] for e in entries} - {"manifest.json"}
    if unused:
        sys.exit(f"ERROR: zip has files the manifest does not list: {sorted(unused)}")
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dry-run", action="store_true", help="download and verify only; do not touch src/")
    args = parser.parse_args()

    print(f"Downloading bigfix-relevance-analyzer {ANALYZER_VERSION} web build")
    print(f"  {ZIP_URL}")
    data = download(ZIP_URL)
    digest = sha256(data)
    if digest != ZIP_SHA256:
        sys.exit(f"ERROR: zip sha256 {digest} does not match the pinned {ZIP_SHA256}")
    print(f"  {len(data):,} bytes, sha256 matches the pinned value")

    files = {}
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        for info in archive.infolist():
            name = info.filename
            if info.is_dir() or "/" in name or "\\" in name or ".." in name:
                sys.exit(f"ERROR: unexpected entry {name!r} in zip (the set is one flat folder)")
            if name in SKIP_FILES:
                continue
            files[name] = archive.read(info)

    manifest = check_manifest(files)
    print(f"  manifest.json OK: version {manifest['version']}, {len(manifest['cores'])} cores, every file matches")

    if args.dry_run:
        print("Dry run: src/static/analyzer/ not changed")
        return

    # write to a temp folder next to DEST, then swap, so a failure never leaves a half-written set
    DEST.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=".analyzer-", dir=DEST.parent))
    try:
        for name, content in files.items():
            (staging / name).write_bytes(content)
        if DEST.exists():
            shutil.rmtree(DEST)
        staging.rename(DEST)
    finally:
        if staging.exists():
            shutil.rmtree(staging)
    total = sum(len(c) for c in files.values())
    print(f"Installed {len(files)} files ({total:,} bytes) into {DEST.relative_to(HERE)}")


if __name__ == "__main__":
    main()
