#!/usr/bin/env python3
"""Download the JavaScript/CSS libraries that custom web reports load from cdnjs (Python standard library only).

WebUI extensions may only load files from the WebUI server (CSP default-src 'self'), and the report iframe
inherits that policy, so a report's <script src="https://cdnjs.cloudflare.com/ajax/libs/..."> is blocked.
The renderer rewrites such URLs to local copies when it has them. This script puts those copies in
src/static/libs/cdnjs/<cdnjs path> (git-ignored) and writes src/static/libs/manifest.json listing them.

Integrity:
  - every file is checked against the SRI hash cdnjs publishes for it (api.cdnjs.com)
  - libs.lock.json (committed) records each file's sha256; later runs must match it exactly
    (use --update-lock after changing LIBRARIES on purpose)

Usage:
    python3 fetch_libs.py               download and verify into src/static/libs/
    python3 fetch_libs.py --update-lock rewrite libs.lock.json from what cdnjs serves now
"""

import argparse
import base64
import hashlib
import json
import posixpath
import re
import shutil
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

# cdnjs paths (under https://cdnjs.cloudflare.com/ajax/libs/) used by the reports in ../../webreports/.
# Files that a CSS file refers to with url(...) (fonts, images) are added automatically.
LIBRARIES = [
    "jquery/3.1.1/jquery.min.js",
    "jqueryui/1.12.1/jquery-ui.min.js",
    "jqueryui/1.12.1/jquery-ui.min.css",
    "datatables/1.10.13/js/jquery.dataTables.min.js",
    "datatables/1.10.13/css/jquery.dataTables.min.css",
    "datatables/1.10.19/js/jquery.dataTables.min.js",
    "datatables/1.10.19/css/jquery.dataTables.min.css",
    "d3/3.5.17/d3.js",
    "nvd3/1.8.5/nv.d3.js",
    "nvd3/1.8.5/nv.d3.css",
    "font-awesome/4.7.0/css/font-awesome.min.css",
    "font-awesome/5.3.1/js/all.js",
    # used by reports in BigFix sites (listed by the renderer on a test server)
    "jspdf-autotable/3.5.13/jspdf.plugin.autotable.min.js",
    "vue/3.3.8/vue.global.js",
    "datatables-plugins/1.10.15/api/fnSortNeutral.js",
]

# Other CDN URLs that are the same file as a cdnjs path above
ALIASES = {
    "https://use.fontawesome.com/releases/v5.3.1/js/all.js": "font-awesome/5.3.1/js/all.js",
    # DataTables' own CDN; not on cdnjs at 1.10.13, but byte-identical to cdnjs 1.10.15
    # (sha256 d77ccac87b03ec130409a37c02c9670f3763adecba426a197d091c196d7e4166, checked 31 Oct 2026)
    "https://cdn.datatables.net/plug-ins/1.10.13/api/fnSortNeutral.js": "datatables-plugins/1.10.15/api/fnSortNeutral.js",
}

CDN = "https://cdnjs.cloudflare.com/ajax/libs/"
API = "https://api.cdnjs.com/libraries/{name}/{version}?fields=sri"
HERE = Path(__file__).resolve().parent
DEST = HERE / "src" / "static" / "libs"
LOCK = HERE / "libs.lock.json"
MAX_BYTES = 8 * 1024 * 1024


def get(url, attempts=4):
    """GET with retries and exponential backoff."""
    for attempt in range(1, attempts + 1):
        try:
            with urllib.request.urlopen(url, timeout=60) as response:
                data = response.read(MAX_BYTES + 1)
            if len(data) > MAX_BYTES:
                sys.exit(f"ERROR: {url} is larger than {MAX_BYTES} bytes")
            return data
        except (urllib.error.URLError, TimeoutError) as err:
            if attempt == attempts:
                sys.exit(f"ERROR: {url} failed after {attempts} attempts: {err}")
            time.sleep(2**attempt)


def sri_for(path, cache):
    """The SRI string cdnjs publishes for a file, e.g. 'sha512-...'."""
    name, version, file_in_lib = path.split("/", 2)
    key = (name, version)
    if key not in cache:
        cache[key] = json.loads(get(API.format(name=name, version=version))).get("sri", {})
    return cache[key].get(file_in_lib)


def check_sri(data, sri):
    algorithm, _, expected = sri.partition("-")
    digest = base64.b64encode(hashlib.new(algorithm, data).digest()).decode()
    return digest == expected


def css_references(css_path, data):
    """Relative url(...) references in a CSS file, resolved to cdnjs paths."""
    refs = []
    for match in re.finditer(r"url\(\s*['\"]?([^'\")]+)['\"]?\s*\)", data.decode("utf-8", "replace")):
        ref = match.group(1).split("?")[0].split("#")[0].strip()
        # skip absolute URLs, and URL-encoded copies like jQuery UI's ThemeRoller comment: url(%22images%2F...%22)
        if not ref or ref.startswith(("data:", "http:", "https:", "//", "/")) or "%" in ref:
            continue
        resolved = posixpath.normpath(posixpath.join(posixpath.dirname(css_path), ref))
        if not resolved.startswith(".."):
            refs.append(resolved)
    return refs


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--update-lock", action="store_true", help="write libs.lock.json from the files downloaded now")
    args = parser.parse_args()

    lock = {} if args.update_lock or not LOCK.exists() else json.loads(LOCK.read_text())
    if not lock and not args.update_lock:
        print("No libs.lock.json yet: creating it from this download")
    sri_cache, files, queue = {}, {}, list(LIBRARIES)

    while queue:
        path = queue.pop(0)
        if path in files:
            continue
        data = get(CDN + path)
        sri = sri_for(path, sri_cache)
        if sri and not check_sri(data, sri):
            sys.exit(f"ERROR: {path} does not match the SRI hash cdnjs publishes ({sri[:20]}...)")
        digest = hashlib.sha256(data).hexdigest()
        if lock and path in lock and lock[path] != digest:
            sys.exit(f"ERROR: {path} sha256 {digest} does not match libs.lock.json; refusing (use --update-lock if intended)")
        files[path] = data
        note = "sri ok" if sri else "no SRI published (font/image); pinned by sha256"
        print(f"  {path} ({len(data):,} bytes, {note})")
        if path.endswith(".css"):
            queue.extend(css_references(path, data))

    missing = [p for p in lock if p not in files]
    if missing and not args.update_lock:
        sys.exit(f"ERROR: libs.lock.json lists files this run did not fetch: {missing}")

    # write to a temp folder, then swap, so a failure never leaves a half-written set
    DEST.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=".libs-", dir=DEST.parent))
    try:
        for path, data in files.items():
            target = staging / "cdnjs" / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
        manifest = {"format": 1, "base": CDN, "files": sorted(files), "aliases": ALIASES}
        (staging / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
        if DEST.exists():
            shutil.rmtree(DEST)
        staging.rename(DEST)
    finally:
        if staging.exists():
            shutil.rmtree(staging)

    if args.update_lock or not lock:
        LOCK.write_text(json.dumps({p: hashlib.sha256(d).hexdigest() for p, d in sorted(files.items())}, indent=2) + "\n")
        print(f"Wrote {LOCK.name} ({len(files)} files)")
    total = sum(len(d) for d in files.values())
    print(f"Installed {len(files)} files ({total:,} bytes) into {DEST.relative_to(HERE)}")


if __name__ == "__main__":
    main()
