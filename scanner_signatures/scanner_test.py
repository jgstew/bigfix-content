#!/usr/bin/env python3
"""Run BigFix Inventory scanner signatures through the real CIT scanner in a container.

    python3 scanner_test.py CONTAINER CIT_DIR SIGNATURE.xml [SIGNATURE.xml ...]

For each <Signature> in each SoftwareIdentityCatalog file it scans with:
  shipped  the ExtendedSignature exactly as written
  diag     the same with the IS_INSTALLED skip removed, so the version it
           extracts is reported even when that version isn't affected
Prints one JSON object: label -> list of matched instances (exported variables).
Exit 1 if a signature body fails the scanner's own schema (CIT_DIR/config/xss),
or if wscansw writes no output.
"""

import json
import subprocess
import sys
import tempfile
from pathlib import Path

from signature_harness import collect, results, signatures_doc, warnings, with_fsscan

EXCLUDES = ["/proc", "/sys", "/dev", "/run"]


def sh(container, script, check=True):
    return subprocess.run(["docker", "exec", container, "sh", "-c", script], check=check, capture_output=True, text=True)


def cit(container, cit_dir, args):
    env = f"LANG=C.UTF-8 LD_LIBRARY_PATH={cit_dir}/bin"
    return sh(container, f"cd /tmp && {env} {cit_dir}/bin/{args} >/dev/null 2>&1; echo $?").stdout.strip()


def main():
    if len(sys.argv) < 4:
        sys.exit(__doc__)
    container, cit_dir, files = sys.argv[1], sys.argv[2], sys.argv[3:]
    sigs, masks = collect(files)

    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        (tmp / "test_sigs.xml").write_text(signatures_doc(sigs, "LINUX"), encoding="utf-8")
        # 1. the scanner's own signature-language schema (CIT_DIR/config/xss)
        subprocess.run(["docker", "cp", f"{container}:{cit_dir}/config/xss", str(tmp / "xss")], check=True)
        v = subprocess.run(["xmllint", "--nonet", "--noout", "--schema", str(tmp / "xss" / "signatures.xsd"), str(tmp / "test_sigs.xml")],
                           capture_output=True, text=True)
        if v.returncode:
            print(v.stderr, file=sys.stderr)
            return 1
        # 2. a Linux FSScan config: the shipped config.xml is a Windows sample
        subprocess.run(["docker", "cp", f"{container}:{cit_dir}/bin/config.xml", str(tmp / "config.xml")], check=True)
        (tmp / "linux_config.xml").write_text(with_fsscan((tmp / "config.xml").read_text(), "/", EXCLUDES, masks))
        for name in ("test_sigs.xml", "linux_config.xml"):
            subprocess.run(["docker", "cp", str(tmp / name), f"{container}:/tmp/{name}"], check=True)
        # 3. index the files the signatures look for, then evaluate the signatures.
        # Remove the last run's output first: containers are reused, and a failed wscansw writes none.
        sh(container, "rm -f /tmp/sw.xml /tmp/sw_warn.xml")
        cit(container, cit_dir, "wscanfs -c /tmp/linux_config.xml -reset")
        cit(container, cit_dir, "wscanfs -c /tmp/linux_config.xml -o /tmp/fs.xml")
        rc = cit(container, cit_dir, "wscansw -i /tmp/test_sigs.xml -c /tmp/linux_config.xml -o /tmp/sw.xml -e /tmp/sw_warn.xml")
        out = sh(container, "cat /tmp/sw.xml", check=False)
        warn = sh(container, "cat /tmp/sw_warn.xml", check=False).stdout

    if out.returncode:
        print(f"wscansw rc={rc} wrote no /tmp/sw.xml; see {cit_dir}/logs/traceCIT.log in {container}", file=sys.stderr)
        return 1
    print(json.dumps({"wscansw_rc": rc, "file_masks": masks, "warnings": warnings(warn),
                      "results": results(out.stdout, sigs)}, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
