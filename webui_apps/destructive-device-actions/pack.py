#!/usr/bin/env python3
"""Package src/ as a BigFix WebUI extension: output/<name>-<version>.webui.

    python3 pack.py            build it
    python3 pack.py --dry-run  validate and list what would be packaged, write nothing

The packaging itself is shared by the plain HTML/JS apps: see ../shared/webui_pack.py.
"""

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.dont_write_bytecode = True  # no __pycache__ in ../shared
sys.path.insert(0, str(HERE.parent / "shared"))
import webui_pack  # noqa: E402

# files from ../shared, packaged as static/js/<file name> next to the app's own scripts
SHARED_FILES = ["webui-relevance.js", "webui-frame.js", "webui-api.js", "webui-log.js"]

# action templates, from the repo's actions/ folder so there is one copy of each (actions.js lists them)
ACTIONS_DIR = HERE.parent.parent / "actions"
EXTRA_FILES = [(ACTIONS_DIR / name, f"static/templates/{name}") for name in ["Wipe_MDM_device_from_WebUI.bes.mustache"]]

if __name__ == "__main__":
    webui_pack.main(HERE, SHARED_FILES, extra_files=EXTRA_FILES)
