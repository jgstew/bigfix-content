#!/usr/bin/env python3
"""Run BigFix Inventory scanner signatures through the real CIT scanner on a Windows host over SSH.

    WINHOST=user@host python3 win_scanner_test.py TESTDIR XSS_DIR SIGNATURE.xml [SIGNATURE.xml ...]

TESTDIR is the Windows test folder holding the CIT install in TESTDIR\\cit (e.g. C:\\bfi_sig_test_node).
XSS_DIR is a local copy of the scanner's config/xss folder (for level-3 validation).
Like scanner_test.py: every signature runs as "shipped" and "diag" (IS_INSTALLED skip removed).
Exit 1 on a schema failure, or if wscansw writes no output.
"""

import base64
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from xml.sax.saxutils import unescape

from signature_harness import collect, results, signatures_doc, warnings, with_fsscan


def ps(host, script):
    enc = base64.b64encode(script.encode("utf-16-le")).decode()
    return subprocess.run(["ssh", "-o", "BatchMode=yes", host, f"powershell -NoProfile -NonInteractive -EncodedCommand {enc}"],
                          capture_output=True, text=True, check=True).stdout


def main():
    host = os.environ.get("WINHOST")
    if not host or len(sys.argv) < 4:
        sys.exit(__doc__)
    testdir, xss, files = sys.argv[1], sys.argv[2], sys.argv[3:]
    fwd = testdir.replace("\\", "/")
    sigs, masks = collect(files)

    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        (tmp / "win_sigs.xml").write_text(signatures_doc(sigs, "WINDOWS"), encoding="utf-8")
        v = subprocess.run(["xmllint", "--nonet", "--noout", "--schema", str(Path(xss) / "signatures.xsd"), str(tmp / "win_sigs.xml")],
                           capture_output=True, text=True)
        if v.returncode:
            print(v.stderr, file=sys.stderr)
            return 1
        subprocess.run(["scp", "-q", f"{host}:{fwd}/cit/bin/config.xml", str(tmp / "config.xml")], check=True)
        # The FSScan scope must match wscansw's FSScanner plugin excludeDirectory attributes, or wscansw
        # treats the cached C:\ tree as invalid and every file query returns nothing.
        config = (tmp / "config.xml").read_text()
        plugin = re.search(r'<Plugin name="FSScanner".*?</Plugin>', re.sub(r"<!--.*?-->", "", config, flags=re.S), re.S)
        if not plugin:
            print(f"no active FSScanner plugin in {testdir}\\cit\\bin\\config.xml", file=sys.stderr)
            return 1
        excludes = [unescape(d, {"&quot;": '"'}) for d in
                    re.findall(r'<Attribute name="excludeDirectory" value="([^"]*)"', plugin.group(0))]
        (tmp / "win_config.xml").write_text(with_fsscan(config, "C:\\", excludes, masks))
        for name in ("win_sigs.xml", "win_config.xml"):
            subprocess.run(["scp", "-q", str(tmp / name), f"{host}:{fwd}/{name}"], check=True)
        quoted = testdir.replace("'", "''")   # inside a PowerShell single-quoted string
        out = ps(host, rf"""
$T = '{quoted}'; $B = "$T\cit\bin"
function Run($exe, $a, $tag) {{
  $p = Start-Process -FilePath "$B\$exe" -ArgumentList $a -WorkingDirectory $B -Wait -PassThru -NoNewWindow `
       -RedirectStandardOutput "$T\$tag.out.txt" -RedirectStandardError "$T\$tag.err.txt"
  "$tag rc=$($p.ExitCode)"
}}
Remove-Item "$T\sw.xml", "$T\sw_warn.xml" -ErrorAction SilentlyContinue
Run 'wscanfs.exe' @('-c', "$T\win_config.xml", '-reset') 'fs_reset'
Run 'wscanfs.exe' @('-c', "$T\win_config.xml", '-o', "$T\fs.xml") 'fs'
Run 'wscansw.exe' @('-i', "$T\win_sigs.xml", '-c', "$T\win_config.xml", '-o', "$T\sw.xml", '-e', "$T\sw_warn.xml") 'sw'
""")
        for name in ("sw.xml", "sw_warn.xml", "fs.xml"):
            subprocess.run(["scp", "-q", f"{host}:{fwd}/{name}", str(tmp / name)], check=False)
        sw = (tmp / "sw.xml").read_text(errors="replace") if (tmp / "sw.xml").exists() else None
        warn = (tmp / "sw_warn.xml").read_text(errors="replace") if (tmp / "sw_warn.xml").exists() else ""
        fs = (tmp / "fs.xml").read_text(errors="replace") if (tmp / "fs.xml").exists() else ""

    runs = [line for line in out.splitlines() if "rc=" in line]
    if sw is None:
        print(f"wscansw wrote no sw.xml ({', '.join(runs)}); see {testdir}\\cit\\logs\\traceCIT.log", file=sys.stderr)
        return 1
    print(json.dumps({"runs": runs, "file_masks": masks,
                      "fs_xml_files_listed": len(re.findall(r"<BasicFileInfo ", fs)),
                      "warnings": warnings(warn), "results": results(sw, sigs)}, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
