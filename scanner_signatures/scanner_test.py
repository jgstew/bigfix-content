#!/usr/bin/env python3
"""Run BigFix Inventory scanner signatures through the real CIT scanner in a container.

    python3 scanner_test.py CONTAINER CIT_DIR SIGNATURE.xml [SIGNATURE.xml ...]

For each <Signature> in each SoftwareIdentityCatalog file it scans with:
  shipped  the ExtendedSignature exactly as written
  diag     the same with the IS_INSTALLED skip removed, so the version it
           extracts is reported even when that version isn't affected
Prints one JSON object: label -> list of matched instances (exported variables).
Exit 1 if a signature body fails the scanner's own schema (CIT_DIR/config/xss).
"""

import json
import re
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path

NS = "http://www.ibm.com/Tivoli/Signatures"
IS_INSTALLED_SKIP = '<Condition withVariable="IS_INSTALLED"><Action do="SKIP" onValue="false"/></Condition>'
EXCLUDES = ["/proc", "/sys", "/dev", "/run"]


def sh(container, script, check=True):
    return subprocess.run(["docker", "exec", container, "sh", "-c", script], check=check, capture_output=True, text=True)


def cit(container, cit_dir, args):
    env = f"LANG=C.UTF-8 LD_LIBRARY_PATH={cit_dir}/bin"
    return sh(container, f"cd /tmp && {env} {cit_dir}/bin/{args} >/dev/null 2>&1; echo $?").stdout.strip()


def main():
    container, cit_dir, files = sys.argv[1], sys.argv[2], sys.argv[3:]
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
        f'<Platforms><Platform type="LINUX"/></Platforms>{b}</Signature>' for label, g, b in sigs) + "\n</Signatures>\n"

    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        (tmp / "test_sigs.xml").write_text(doc, encoding="utf-8")
        # 1. the scanner's own signature-language schema (CIT_DIR/config/xss)
        subprocess.run(["docker", "cp", f"{container}:{cit_dir}/config/xss", str(tmp / "xss")], check=True)
        v = subprocess.run(["xmllint", "--nonet", "--noout", "--schema", str(tmp / "xss" / "signatures.xsd"), str(tmp / "test_sigs.xml")],
                           capture_output=True, text=True)
        if v.returncode:
            print(v.stderr, file=sys.stderr)
            return 1
        # 2. a Linux FSScan config: the shipped config.xml is a Windows sample
        subprocess.run(["docker", "cp", f"{container}:{cit_dir}/bin/config.xml", str(tmp / "config.xml")], check=True)
        fsscan = ('<FSScan version="1.0" priority="normal">' + '<IncludeDirectory value="/"/>'
                  + "".join(f'<ExcludeDirectory value="{d}"/>' for d in EXCLUDES)
                  + "".join(f'<FileMask value="{m}"/>' for m in masks)
                  + '<Age value="0"/><Timeout value="1800"/><OutputData value="BASIC"/></FSScan>')
        config = re.sub(r"<FSScan .*?</FSScan>", fsscan, (tmp / "config.xml").read_text(), count=1, flags=re.S)
        (tmp / "linux_config.xml").write_text(config)
        for name in ("test_sigs.xml", "linux_config.xml"):
            subprocess.run(["docker", "cp", str(tmp / name), f"{container}:/tmp/{name}"], check=True)
        # 3. index the files the signatures look for, then evaluate the signatures
        cit(container, cit_dir, "wscanfs -c /tmp/linux_config.xml -reset")
        cit(container, cit_dir, "wscanfs -c /tmp/linux_config.xml -o /tmp/fs.xml")
        rc = cit(container, cit_dir, "wscansw -i /tmp/test_sigs.xml -c /tmp/linux_config.xml -o /tmp/sw.xml -e /tmp/sw_warn.xml")
        out = sh(container, "cat /tmp/sw.xml").stdout
        warn = sh(container, "cat /tmp/sw_warn.xml", check=False).stdout

    by_guid = {g: label for label, g, _ in sigs}
    result = {label: [] for label, _, _ in sigs}
    for g, body in re.findall(r'<MatchedSignature guid="(\w+)">(.*?)</MatchedSignature>', out, re.S):
        result[by_guid[g]].append(dict(re.findall(r'<Variable name="(\w+)" value="([^"]*)"', body)))
    print(json.dumps({"wscansw_rc": rc, "file_masks": masks, "warnings": sorted(set(re.findall(r"<Info>([^<]*)", warn))),
                      "results": result}, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
