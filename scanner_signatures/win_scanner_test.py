#!/usr/bin/env python3
"""Run BigFix Inventory scanner signatures through the real CIT scanner on a Windows host over SSH.

    WINHOST=user@host python3 win_scanner_test.py TESTDIR XSS_DIR SIGNATURE.xml [SIGNATURE.xml ...]

TESTDIR is the Windows test folder holding the CIT install in TESTDIR\\cit (e.g. C:\\bfi_sig_test_node).
XSS_DIR is a local copy of the scanner's config/xss folder (for level-3 validation).
Like scanner_test.py: every signature runs as "shipped" and "diag" (IS_INSTALLED skip removed).
"""

import base64
import json
import os
import re
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path

NS = "http://www.ibm.com/Tivoli/Signatures"
IS_INSTALLED_SKIP = '<Condition withVariable="IS_INSTALLED"><Action do="SKIP" onValue="false"/></Condition>'
HOST = os.environ["WINHOST"]


def ps(script):
    enc = base64.b64encode(script.encode("utf-16-le")).decode()
    return subprocess.run(["ssh", "-o", "BatchMode=yes", HOST, f"powershell -NoProfile -NonInteractive -EncodedCommand {enc}"],
                          capture_output=True, text=True, check=True).stdout


def main():
    testdir, xss, files = sys.argv[1], sys.argv[2], sys.argv[3:]
    fwd = testdir.replace("\\", "/")
    sigs, masks = [], set()
    for f in files:
        text = Path(f).read_text(encoding="utf-8")
        for n, body in enumerate(re.findall(r"<!\[CDATA\[(.*?)\]\]>", text, re.S), 1):
            masks.update(re.findall(r'<FindFilePathEx[^>]*\bnames?="([^"]+)"', body))
            if IS_INSTALLED_SKIP not in body:
                print(f"warning: {Path(f).name}#{n} has no IS_INSTALLED skip; diag = shipped", file=sys.stderr)
            for kind, b in (("shipped", body), ("diag", body.replace(IS_INSTALLED_SKIP, ""))):
                sigs.append((f"{kind}:{Path(f).name}#{n}", uuid.uuid4().hex, b))
    masks = sorted({m for v in masks for m in re.split(r"[,;]", v) if m})
    doc = f'<?xml version="1.0" encoding="UTF-8"?>\n<Signatures xmlns="{NS}" version="1.0">\n' + "\n".join(
        f'<Signature guid="{g}"><Metadata><AnyMetadataTag>{label}</AnyMetadataTag></Metadata>'
        f'<Platforms><Platform type="WINDOWS"/></Platforms>{b}</Signature>' for label, g, b in sigs) + "\n</Signatures>\n"

    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        (tmp / "win_sigs.xml").write_text(doc, encoding="utf-8")
        v = subprocess.run(["xmllint", "--nonet", "--noout", "--schema", str(Path(xss) / "signatures.xsd"), str(tmp / "win_sigs.xml")],
                           capture_output=True, text=True)
        if v.returncode:
            print(v.stderr, file=sys.stderr)
            return 1
        subprocess.run(["scp", "-q", f"{HOST}:{fwd}/cit/bin/config.xml", str(tmp / "config.xml")], check=True)
        # The FSScan scope must match wscansw's FSScanner plugin excludeDirectory attributes, or wscansw
        # treats the cached C:\ tree as invalid and every file query returns nothing.
        active = re.sub(r"<!--.*?-->", "", (tmp / "config.xml").read_text(), flags=re.S)
        plugin = re.search(r'<Plugin name="FSScanner".*?</Plugin>', active, re.S).group(0)
        excludes = re.findall(r'<Attribute name="excludeDirectory" value="([^"]*)"', plugin)
        fsscan = ('<FSScan version="1.0" priority="normal"><IncludeDirectory value="C:\\"/>'
                  + "".join(f'<ExcludeDirectory value="{d}"/>' for d in excludes)
                  + "".join(f'<FileMask value="{m}"/>' for m in masks)
                  + '<Age value="0"/><Timeout value="1800"/><OutputData value="BASIC"/></FSScan>')
        config = re.sub(r"<FSScan .*?</FSScan>", lambda _: fsscan, (tmp / "config.xml").read_text(), count=1, flags=re.S)
        (tmp / "win_config.xml").write_text(config)
        for name in ("win_sigs.xml", "win_config.xml"):
            subprocess.run(["scp", "-q", str(tmp / name), f"{HOST}:{fwd}/{name}"], check=True)
        out = ps(rf"""
$T = '{testdir}'; $B = "$T\cit\bin"
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
            subprocess.run(["scp", "-q", f"{HOST}:{fwd}/{name}", str(tmp / name)], check=False)
        sw = (tmp / "sw.xml").read_text(errors="replace") if (tmp / "sw.xml").exists() else ""
        warn = (tmp / "sw_warn.xml").read_text(errors="replace") if (tmp / "sw_warn.xml").exists() else ""
        fs = (tmp / "fs.xml").read_text(errors="replace") if (tmp / "fs.xml").exists() else ""

    by_guid = {g: label for label, g, _ in sigs}
    result = {label: [] for label, _, _ in sigs}
    for g, body in re.findall(r'<MatchedSignature guid="(\w+)">(.*?)</MatchedSignature>', sw, re.S):
        result[by_guid[g]].append(dict(re.findall(r'<Variable name="(\w+)" value="([^"]*)"', body)))
    print(json.dumps({"runs": [line for line in out.splitlines() if "rc=" in line], "file_masks": masks,
                      "fs_xml_files_listed": len(re.findall(r"<BasicFileInfo ", fs)),
                      "warnings": sorted(set(re.findall(r"<Info>([^<]*)", warn))), "results": result}, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
