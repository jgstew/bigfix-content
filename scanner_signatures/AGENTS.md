# scanner_signatures: BigFix Inventory scanner signatures

This folder holds **BigFix Inventory (BFI) software signatures**: XML files that
tell the BFI scanner (CIT: `wscanfs`, `wscansw`) how to recognize a piece of
software and its version on an endpoint. They're imported into BigFix
Inventory as custom catalog content. The same format is used in
[bigfix/CommunityContent `Signatures/`](https://github.com/bigfix/CommunityContent/tree/main/Signatures).

Everything below was verified with the CIT scanner **11.0.44.0**
(`linux-x86_64_11.0.44.0.tgz`) on Debian 12, Ubuntu 24.04 and Rocky Linux 9
(amd64 containers), and with `w64-ix86_11.0.44.0.zip` on Windows Server 2022
(section 5.6), in October 2026. Facts marked *(not verified)* weren't.
macOS wasn't scanned with a real macOS scanner: the macOS-only paths were
tested by planting the same files in a Linux container.

| File | What it detects |
|---|---|
| `software_PHP_all_Affected_by_CVE-2026-109618_and_CVE-2026-109619-0.AFFECTED.xml` | PHP affected by CVE-2026-109618 / CVE-2026-109619: 5 signatures (Windows `php.exe`, Linux `NEWS`, PHP source tree, Debian/Ubuntu dpkg, RPM) |
| `software_Node.js_all_Affected_by_CVE-2026-111497-0.AFFECTED.xml` | Node.js affected by CVE-2026-111497 (Brotli): 5 signatures (Windows `node.exe`, Windows MSI, `include/node/node_version.h` layouts, dpkg, RPM). Section 8. |
| `software_Node.js_ANY-0.any_version.xml` | Every Node.js found, with its version: the same 5 signatures, no version filter. Section 8. |
| `software_Electron_ANY-0.any_version.xml` | Electron (embeds Node.js), with the Electron version: 2 signatures (macOS framework `Info.plist`, unpacked Electron distribution). Section 8. |

## 1. File format

A signature file has two layers.

### Outer layer: `SoftwareIdentityCatalog`

```xml
<?xml version="1.0" encoding="utf-8"?>
<SoftwareIdentityCatalog exportTimeStamp="2026-10-26T16:54:24Z">
   <Software name="..." vendor="..." uniqueId="<uuid>" version="0.AFFECTED">
    <Signature uniqueId="<uuid>" modified="<dateTime>" created="<dateTime>">
      <ExtendedSignature>
        <![CDATA[<MultipleInstance>...</MultipleInstance>]]>
      </ExtendedSignature>
    </Signature>
    <!-- more <Signature> elements: one Software can have many detection methods -->
   </Software>
</SoftwareIdentityCatalog>
```

Rules from the outer schema (`SoftwareIdentityCatalog.xsd`, see section 3):

- `Software@name`, `@vendor`: 1-250 characters, required. `@version`: required, and must match `([0-9]{1,18}\..*)|\*`. `0.AFFECTED`, `0.SAFE` and `0.any_version` are the usual pseudo-versions for vulnerability signatures.
- `uniqueId` (on `Software` and `Signature`): exactly 36 characters, lowercase `[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`. New signatures get a new `uuid.uuid4()`. Never reuse another signature's ID.
- `created` / `modified`: `xs:dateTime`, e.g. `2026-10-26T23:53:39Z`. Update `modified` whenever a signature's body changes.
- A `Signature` holds **either** a basic `<AND><OR><File .../></OR></AND>` (or `PackageFilter`) rule **or** one `<ExtendedSignature>`. All signatures here are extended.
- The outer schema types `ExtendedSignature` as "anything": **it doesn't check the CDATA at all.**

### Inner layer: the CDATA body (the XSS signature language)

The CDATA is itself XML, in the scanner's signature language. It's parsed by
the scanner, so entities inside it work (`&#10;` is a newline). Its schema
ships with the scanner, in `<CIT>/config/xss/` (`signatures.xsd` plus
`coreplugin.xsd`, `fssplugin.xsd`, `regplugin.xsd`, `csplugin.xsd`,
`xmlplugin.xsd`), with namespace `http://www.ibm.com/Tivoli/Signatures`.
Those files and the scanner are **HCL-licensed: don't commit them here**.
Download them when needed (section 4.1).

Shape of a body:

```xml
<MultipleInstance>
  <Iterator export="true" name="INSTALL_PATH"> <!-- one Instance per value -->
    <Vector filter="*/usr/bin/"><FindFilePathEx appendFileName="false" name="php"/></Vector>
  </Iterator>
  <Instance>
    <Variable export="false" name="x"> ...expression... </Variable>
    <Condition withVariable="x"><Action do="SKIP" onValue="false"/></Condition>
    <Variable export="true" name="DETAILED_VER"> ... </Variable>
    <Variable export="true" name="IS_INSTALLED"> ...version-range test... </Variable>
    <Condition withVariable="IS_INSTALLED"><Action do="SKIP" onValue="false"/></Condition>
  </Instance>
</MultipleInstance>
```

- `export="true"` variables are reported for each instance that isn't skipped. Keep the convention every signature here and in CommunityContent follows: export `INSTALL_PATH`, `DETAILED_VER` and `IS_INSTALLED`.
- `Condition` + `Action do="SKIP" onValue="false"` (or `"true"`, or `""` for empty) drops the instance. Skip as early as possible: missing file, too large, wrong package.
- Variables are substituted as `$(NAME)` inside any attribute, including in the middle of strings: `absolutePath="$(INSTALL_PATH)../NEWS"`, `searchedString="Package: $(file_name)-cli"`.

## 2. Scanner behavior (verified; these decide whether a signature works)

| Construct | Behavior |
|---|---|
| `FindFilePathEx name="..."` / `names="a,b"` | Searches the **file index built by `wscanfs`**, not the disk. A file whose name isn't in the scan config's `FileMask` list is never found. Wildcards work (`php*`). With `appendFileName="false"` it returns the folder (`/usr/bin/`); with `"true"` the full path (`/usr/bin/php8.2`). |
| `FindFilePathEx` and symlinks | **Symlinks are skipped.** `name="php"` never finds Debian/Ubuntu `/usr/bin/php`, which is a symlink to `/etc/alternatives/php`. On RHEL it's a real file and is found. |
| `FindFilePathEx` on Windows | Works, **if the `FSScan` scope matches the `wscansw` `FSScanner` plugin's `excludeDirectory` attributes** in the same config. The sample `config.xml` has `excludeDirectory="C:\dir_to_exclude"`; an `FSScan` without that `ExcludeDirectory` makes every file query return nothing (section 5.6). |
| `FindFilePath name=... rootPath=...` | Also queries the `wscanfs` index (a name missing from `FileMask` isn't found), limited to `rootPath`. |
| `WinFileInfo absolutePath=... field="version"` | Windows file version, always 4 parts: `php.exe` 8.3.35 gives `8.3.35.0`, `node.exe` 22.23.3 gives `22.23.3.0`. `Compare type="version"` pads with zeros: `22.23.4.0` **eq** `22.23.4`, and `8.3.35.0` < `8.3.36`. |
| `MsiProductList filter="..."` | Windows Installer products. **`filter` matches the product code** (`{8077DB9D-...}`), not the name: `filter="Node.js"` and `"Node*"` return nothing. List them all and check `MsiProductInfo field="name"`. |
| `MsiProductInfo code=... field=...` | `name`, `version`, `vendor`, `installDir`, `installDate`. The Node.js MSI gives `version` `22.23.3` and an **empty** `installDir`. |
| `RegKeyValue key="HKEY_LOCAL_MACHINE\..." entry="..." section="64or32"` | Returns the value. A missing key or entry returns `""` and doesn't drop the instance. |
| `Vector filter="..."` | The pattern must match the **whole** string. `*/usr/bin/` matches the folder returned with `appendFileName="false"`. To filter full paths (`appendFileName="true"`), use `*/usr/bin/*`. |
| `FileExists`, `ReadFile`, `FileInfoCompare` | Read the disk directly. No index or `FileMask` needed. |
| `ReadFile` | Always guard it with `FileExists` and `FileInfoCompare field="size" relation="le" value="5120000"` (repo convention: 512 KB-5 MB). |
| `StringCrop` | `startString`, `endString`, `inputString` are required, plus `seekFrom="left"` or `"right"`. Returns the text between the first `startString` and the next `endString`. `startString=""` crops from the beginning: `StringCrop endString="-" startString=""` on `8.2.35-1~deb12u1` gives `8.2.35`. Wrap it in `<VectorToScalar>` when the result is used as a scalar (the majority pattern). |
| `StringCrop`: separator not found | A `startString` that isn't there crops from the beginning; an `endString` that isn't there (or `""`) runs to the end. So `start=":" end=""` on `18.20.4+dfsg` returns it unchanged, and chained crops (`:`, `-`, `+`, `~`) are safe when a separator is absent. On a multi-line file, a missing `startString` returns the first line, so check with `Contains` first. |
| `StringCrop seekFrom="right"` | `startString="" endString="."` returns the text before the **last** `.`: `22.23.4.0` gives `22.23.4`, but `22.23.4` gives `22.23`. Use it only when the part count is known (`WinFileInfo` is always 4). `endString="include/node/"` on `/opt/node/include/node/` gives `/opt/node/`. |
| `Contains inputString=... searchedString=... position="contains\|start\|end"` | Boolean. Takes **attributes**, not child elements. |
| `ValueOf value="$(a).$(b).$(c)"` | Joins variables (there's also `Concat`). |
| `Vector` with several children | Union: `<Vector><DpkgProductList filter="nodejs"/><DpkgProductList filter="libnode*"/></Vector>` iterates both. |
| A failing scalar expression | Drops the **whole instance** (with a "Scalar expression [...] failed" warning): e.g. `ReadFile` on a missing file, or `XmlValue`. That's why every `ReadFile` is guarded. |
| `XmlValue file=... xpath=...` | Failed on Apple XML plists (which have a `DOCTYPE` with an external DTD), with a simple `following-sibling` XPath. Use `ReadFile` + `StringCrop` instead. |
| An `<Instance>` with no children | Invalid: "Not enough children for [Instance]", and nothing matches. Probes need at least one `Variable`. |
| `DpkgProductList filter="php*-common" type="any"` | Native dpkg provider. Iterates **package names** (`php8.2-common`, `php-common`). Only installed packages: Debian's known-but-absent `libnode64`/`libnode72`/... aren't listed. |
| `DpkgProductInfo code=... field=...` | `field` is one of `name`, `version`, `displayVersion`, `description`. `version` = dpkg version, e.g. `8.2.35-1~deb12u1`, `8.3.6-0ubuntu0.24.04.13`, metapackage `2:93`. |
| `RpmProductList filter="*php-common-*" type="any"` | Iterates **name-version-release.arch** strings (`php-common-8.0.30-8.el9_8.1.x86_64`), so a filter needs a trailing `-*` or `*`. A leading `*` works (it also matches Remi `php83-php-common-...`). |
| `RpmProductInfo field="version"` | **Returns `8.0.30.8.el9_8.1`** (version.release joined with a dot), which `Compare type="version"` **can't** handle. Use `field="displayVersion"` (`8.0.30-8.el9_8.1`) and crop at `-`. `displayVersion` **leaves out the epoch**: RHEL's `nodejs` is `1:16.20.2-8.el9_4` and gives `16.20.2-8.el9_4`. Other fields: `name`, `release`, `vendor`, `arch`, `installDir` (comma list, e.g. `/etc/,/usr/,/var/lib/`), `installDate`, ... |
| `Compare relation="lt\|le\|eq\|ne\|ge\|gt" type="version\|string\|cistring\|integer\|hex\|boolean"` | `version` compares dotted numbers. Feed it clean `X.Y.Z` (crop distro suffixes first). |
| A provider missing on the OS | E.g. `RpmProductList` on Debian or `DpkgProductList` on RHEL: a *warning* ("Vector expression [...] failed"). That signature matches nothing, and the others still run. This is expected. |
| `PackageInfoMatch name vendor version` | Boolean match against installed packages. Used by some CommunityContent signatures *(behavior not verified here)*. |

The complete element and attribute list is in the XSS schema (section 3, level 3).
When in doubt, write a probe signature that exports intermediate values
(section 4.3) instead of guessing.

## 3. Writing a signature

1. **Pick evidence the scanner can read without running the software.** In order of preference:
   - **A package database** (`DpkgProductList`/`RpmProductList` + `*Info`, Windows `MsiProductList` + `MsiProductInfo`): reliable versions, no file search.
   - **Version resources** (`WinFileInfo absolutePath=... field="version"` on Windows).
   - **A small version file next to the binary** (`ReadFile` + `StringCrop`), with a size guard.
2. **Make the version test identical across all signatures of one `Software`.** Write the `IS_INSTALLED` block once and copy it verbatim (or generate it), so every detection method uses the same affected ranges.
3. **Crop versions to `X.Y.Z`** before `Compare type="version"`: dpkg `8.3.6-0ubuntu0.24.04.13` becomes `8.3.6`, RPM `displayVersion` `8.0.30-8.el9_8.1` becomes `8.0.30`.
4. **Skip metapackages and non-matching names explicitly.** Debian's `php-common` is version `2:93`; skip it with `Compare relation="ne" type="string"`.
5. **Remember distro backports.** A version comparison flags Debian/Ubuntu/RHEL builds whose security fixes were backported into an old version number (e.g. RHEL 9 PHP `8.0.30`, Ubuntu `8.3.6`). Say so in the PR or description. A signature can't tell.
6. **One `Software` can be reported by several signatures on one machine** (e.g. RHEL: the `NEWS` signature and the RPM signature both report PHP). Decide whether that's acceptable.
7. **Validate and test** (sections 4 and 5) before publishing.

Templates (from the PHP file; `<IS_INSTALLED block>` is the shared version-range test):

```xml
<!-- Debian/Ubuntu: dpkg package version -->
<MultipleInstance><Iterator export="false" name="PKG"><DpkgProductList filter="php*-common" type="any"/></Iterator><Instance>
<Variable export="false" name="not_meta"><Compare relation="ne" type="string"><ValueOf value="$(PKG)"/><ValueOf value="php-common"/></Compare></Variable><Condition withVariable="not_meta"><Action do="SKIP" onValue="false"/></Condition>
<Variable export="false" name="package_version"><DpkgProductInfo code="$(PKG)" field="version"/></Variable>
<Variable export="true" name="DETAILED_VER"><VectorToScalar><StringCrop endString="-" inputString="$(package_version)" seekFrom="left" startString=""/></VectorToScalar></Variable><Condition withVariable="DETAILED_VER"><Action do="SKIP" onValue=""/></Condition>
<Variable export="true" name="INSTALL_PATH"><ValueOf value="/usr/lib/php/"/></Variable>
<IS_INSTALLED block></Instance></MultipleInstance>

<!-- RPM: displayVersion, not version -->
<MultipleInstance><Iterator export="false" name="PKG"><RpmProductList filter="*php-common-*" type="any"/></Iterator><Instance>
<Variable export="false" name="package_version"><RpmProductInfo code="$(PKG)" field="displayVersion"/></Variable>
<Variable export="true" name="DETAILED_VER"><VectorToScalar><StringCrop endString="-" inputString="$(package_version)" seekFrom="left" startString=""/></VectorToScalar></Variable><Condition withVariable="DETAILED_VER"><Action do="SKIP" onValue=""/></Condition>
<Variable export="true" name="INSTALL_PATH"><RpmProductInfo code="$(PKG)" field="installDir"/></Variable>
<IS_INSTALLED block></Instance></MultipleInstance>
```

## 4. Validation (four levels; run all of them)

The outer schema alone proves almost nothing: it never looks inside the CDATA.
A wrong element name, attribute or `field` value only shows up at levels 3-4.

### Level 1: outer schema

The schema is `SoftwareIdentityCatalog.xsd`. The same file is
CommunityContent's `.github/actions/validate-signatures-xsd/signature.xsd`
(identical), and it ships in the PyPI package `validate-bes-xml`:

```bash
XSD=$(uvx --from validate-bes-xml python -c "import validate_bes_xml, pathlib; print(pathlib.Path(validate_bes_xml.__file__).parent / 'schemas' / 'SoftwareIdentityCatalog.xsd')")
xmllint --nonet --noout --schema "$XSD" scanner_signatures/*.xml
```

### Level 2: every CDATA body is well-formed XML

```bash
python3 - scanner_signatures/*.xml <<'EOF'
import re, sys, xml.dom.minidom
for f in sys.argv[1:]:
    for i, body in enumerate(re.findall(r"<!\[CDATA\[(.*?)\]\]>", open(f, encoding="utf-8").read(), re.S), 1):
        xml.dom.minidom.parseString(body)
        print(f"{f}: signature {i} well-formed")
EOF
```

### Level 3: the scanner's own signature schema (XSS)

Wrap every body in the scanner's input document and validate it against
`<CIT>/config/xss/signatures.xsd`. This catches unknown elements, attributes and
`field`/`relation`/`type` values. The test harness (section 5.2) does this
automatically before scanning and exits 1 on failure. By hand:

```xml
<Signatures xmlns="http://www.ibm.com/Tivoli/Signatures" version="1.0">
  <Signature guid="<32 hex chars>"><Metadata><AnyMetadataTag>label</AnyMetadataTag></Metadata>
    <Platforms><Platform type="LINUX"/></Platforms>   <!-- WINDOWS, LINUX, AIX, SOLARIS, HPUX, ... -->
    <MultipleInstance>...the CDATA body...</MultipleInstance>
  </Signature>
</Signatures>
```

```bash
xmllint --nonet --noout --schema <CIT>/config/xss/signatures.xsd wrapped.xml
```

### Level 4: behavior with the real scanner (section 5)

The only level that proves the signature finds the software and extracts the right version.

### Repo hooks that also run

The `bigfix-content` pre-commit config runs `check-xml`, `trailing-whitespace`
and `end-of-file-fixer` on these files. `.github/workflows/xmlvalidate.yaml`
checks XML syntax. None of them check signature content.

## 5. Running and testing signatures

No BigFix client or server is needed. The CIT scanner installs and runs on
its own, and `wscansw -i <file>` evaluates a signature file directly.

### 5.1 Install the CIT scanner

Same bundle and `wcitinst` command as HCL's **Install or Upgrade Scanner (11.0.44.0)** task.
Works in any glibc x86_64 Linux. On Apple Silicon, use `--platform linux/amd64`
containers. An `aarch64` bundle exists too
(`linux-aarch64_11.0.44.0.tgz`, SHA256 `366df5cf2d15c757bcb20efc0b4adeeb4b3c241996afd64b65d8e232c1f57a76`) *(not tested)*.
Needs `curl`, `gzip`, `tar` and `sha256sum`.

```sh
#!/bin/sh
# Install the BigFix Inventory CIT scanner (wscanfs/wscansw) without a BigFix client.
# Same bundle and wcitinst command as HCL's "Install or Upgrade Scanner (11.0.44.0)" task.
set -eu
CIT_DIR=${CIT_DIR:-/opt/cit}
URL=https://software.bigfix.com/download/tema/scanner/11.0.44.0-20260915-1200/linux-x86_64_11.0.44.0.tgz
SHA256=6bb1a635d24c9b3bf45e2ce7bdeee68c7ae8d72d4caeae79026594d5cddfb131
work=$(mktemp -d)
cd "$work"
curl -fsSL -o citbundle.tgz "$URL"
echo "$SHA256  citbundle.tgz" | sha256sum -c -
gzip -dc citbundle.tgz | tar -xf -
chmod 500 wcitinst
mkdir -p "$CIT_DIR"
./wcitinst i BFI-PRIVATE -s "$work/CIT_linuxX64.spb" -d "$CIT_DIR" -c "$CIT_DIR/logs" -p > "$CIT_DIR/install.log" 2>&1
tail -1 "$CIT_DIR/install.log"
ls "$CIT_DIR/bin/wscanfs" "$CIT_DIR/bin/wscansw" "$CIT_DIR/config/xss/signatures.xsd"
```

Run a scanner with `LANG=C.UTF-8 LD_LIBRARY_PATH=$CIT_DIR/bin $CIT_DIR/bin/<wscanfs|wscansw> ...`
(this is what HCL's `runscanner.sh` does). `wscansw -?` and `wscanfs -?` print usage.

The installed tree (`$CIT_DIR`) is self-contained (it bundles its own `libstdc++`). Copying it
(`tar` it up, `docker cp`, untar) into another container with the target software
works. That's how the Ubuntu and Rocky tests below were run.

### 5.2 The test harness

`scanner_test.py` runs on the host (needs Python 3.9+, `docker`, `xmllint`) against a
running container that has the scanner and the software under test.

1. It wraps every signature twice: **shipped** (as written) and **diag** (with the
   `IS_INSTALLED` skip removed, so the extracted version shows even when it isn't affected).
2. It validates them against the scanner's XSS schema (level 3).
3. It writes a Linux `FSScan` config. The bundled `bin/config.xml` is a Windows sample.
   The new config includes `/` (minus `/proc`, `/sys`, `/dev`, `/run`), with `FileMask`s
   taken from the signatures' own `FindFilePathEx` names.
4. It runs `wscanfs -reset`, `wscanfs`, then `wscansw`, and prints JSON results per signature.

```python
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
```

Example (container `php-debian`, with the scanner installed at `/opt/cit`):

```bash
docker run -d --platform linux/amd64 --name php-debian debian:12 sleep infinity
docker cp install_cit.sh php-debian:/tmp/
docker exec php-debian sh -c 'apt-get update -qq && apt-get install -y -qq --no-install-recommends curl ca-certificates php-cli && sh /tmp/install_cit.sh'
python3 scanner_test.py php-debian /opt/cit scanner_signatures/software_PHP_*.xml
```

### 5.3 Expected results for the PHP file (verified)

`#n` is the signature's position in the file. A dash means no match.

| Container (PHP) | #1 Windows | #2 Linux NEWS | #3 source tree | #4 dpkg | #5 RPM |
|---|---|---|---|---|---|
| Debian 12 `debian:12` + `php-cli` (8.2.35, **fixed**) | - | - | - | shipped -, **diag 8.2.35 / false** | - |
| Ubuntu 24.04 `ubuntu:24.04` + `php-cli` (8.3.6) | - | - | - | **8.3.6 / true** | - |
| Rocky 9 `rockylinux:9` + `php-cli` (8.0.30) | - | **8.0.30 / true** | - | - | **8.0.30 / true** |
| Debian 12 + a planted `/srv/build/php-src/main/php.h` and `../NEWS` with `21 Nov 2025, PHP 8.3.28` | - | - | **8.3.28 / true** | as above | - |

Expected warnings: `RpmProductList` failed (Debian/Ubuntu) and `DpkgProductList` failed (Rocky).
Signature #1 (Windows) is covered in section 5.6, where it matches with the corrected scan config.

### 5.4 Probing scanner behavior

To learn what an expression returns, write a signature that **exports every intermediate
variable** and has no `Condition`s, run it through the harness, and read the JSON. For example:

```xml
<MultipleInstance><Iterator export="true" name="PKG"><RpmProductList filter="php*" type="any"/></Iterator><Instance>
<Variable export="true" name="V"><RpmProductInfo code="$(PKG)" field="version"/></Variable>
<Variable export="true" name="DV"><RpmProductInfo code="$(PKG)" field="displayVersion"/></Variable>
</Instance></MultipleInstance>
```

That's how the symlink, `Vector filter` and `RpmProductInfo version` behaviors in section 2 were found.

### 5.5 Installing through the real BigFix task instead (optional)

[bigfix-actionscript-runner](https://github.com/jgstew/bigfix-actionscript-runner) can run
HCL's **Install or Upgrade Scanner (11.0.44.0)** `.bes` inside a container, with `qna` from the
BigFix client package unpacked into `/opt/BESClient` (`dpkg -x` into a temp folder; never into `/`,
which breaks Debian's `/lib` symlinks). It worked with these workarounds:

- `--no-preflight`: [jgstew/pre-commit-bigfix#54](https://github.com/jgstew/pre-commit-bigfix/issues/54) (false E302/E500 on indented `createfile` end markers).
- Run a copy of the task with the other platforms' `citbundle.tgz`/`bzip2` prefetch lines removed: [jgstew/bigfix-actionscript-runner#8](https://github.com/jgstew/bigfix-actionscript-runner/issues/8) (all prefetches are downloaded, and same-name files overwrite each other).
- `--sandbox /tmp/bfsandbox --set '(parameter "scannerdatasfolder" as string) & "/" & computer id as string & "changeCacheAndLogsFolder.log"=>/tmp/bfsandbox/tools/scanner/1234567changeCacheAndLogsFolder.log'`: `computer id` needs a running client.
- `--execute`. The scanner then lives in `/opt/BESClient/tools/scanner/internal`, and `runscanner.sh /opt/BESClient <scanner> <args>` runs it.

Use this to test the task itself. For testing signatures, section 5.1 is simpler.

### 5.6 Windows (verified)

Tested on Windows Server 2022 over SSH (PowerShell 5.1, run as an administrator). Send multi-line
scripts as `powershell -NoProfile -NonInteractive -EncodedCommand <base64 of the UTF-16LE script>`
to avoid quoting problems. The encoded command must fit cmd's 8191-character line limit (about a
3 KB script); split longer scripts into parts. All paths stay under one test folder.

**Install (verified).** These are the same steps as HCL's task. Its `7za e` extracts the bundle
flat, and its redistributable DLLs are only needed when `api-ms-win-crt*` is missing from System32.

```powershell
$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$T = 'C:\bfi_sig_test'
New-Item -ItemType Directory -Force -Path "$T\installer", "$T\download" | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem
function Get-Verified($url, $sha256) {
    $f = Join-Path "$T\download" ([IO.Path]::GetFileName($url))
    Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $f
    if ((Get-FileHash $f -Algorithm SHA256).Hash.ToLower() -ne $sha256) { throw "SHA256 mismatch: $url" }
    $f
}
function Expand-Flat($zip, $dest) {   # like '7za e': no folders
    $a = [IO.Compression.ZipFile]::OpenRead($zip)
    foreach ($e in $a.Entries) { if ($e.Name) { [IO.Compression.ZipFileExtensions]::ExtractToFile($e, (Join-Path $dest $e.Name), $true) } }
    $a.Dispose()
}
Expand-Flat (Get-Verified 'https://software.bigfix.com/download/tema/scanner/11.0.44.0-20260915-1200/w64-ix86_11.0.44.0.zip' 'fcf79e161867103d5223a26ed13f012a031528a28bf24de7e05277c57cc8254c') "$T\installer"
$p = Start-Process -FilePath "$T\installer\wcitinst.exe" -Wait -PassThru -NoNewWindow -RedirectStandardOutput "$T\installer\installCITlog.txt" `
    -ArgumentList @('i', 'BFI-PRIVATE', '-s', "`"$T\installer\CIT_win64.spb`"", '-d', "`"$T\cit`"", '-c', "`"$T\cit\logs`"", '-p')
"wcitinst exit code: $($p.ExitCode)"   # 0, log ends with "Done."
if (-not (Get-ChildItem "$env:WINDIR\System32" -Filter 'api-ms-win-crt*' -ErrorAction SilentlyContinue)) {
    Expand-Flat (Get-Verified 'https://software.bigfix.com/download/tema/scanner/api-ms-win_redist_dlls_x64.zip' '1dff7809092e300b023eb61646fa5e428bd4c2479e6363aae872ede8264ff581') "$T\cit\bin"
}
```

- `BFI-PRIVATE` installs a private copy. On a host that already had a system CIT 9.2.23
  (`%WINDIR%\cit\cit.ini`, from an existing BigFix client), `%WINDIR%\cit` was unchanged
  (same files and hashes before and after). Registry changes weren't checked.
- The scanner's file cache lives in `$T\cit\cache_data\__<user>` (`Cit.properties`:
  `fscanner.provider=provider_cache2`, `globalCache=false`).
- To remove everything: `Remove-Item -Recurse -Force C:\bfi_sig_test`.

**Test fixture (verified):** the official
`https://windows.php.net/downloads/releases/archives/php-8.3.35-nts-Win32-vs16-x64.zip`
(SHA256 `25a8e2ac9ff30f1d768d1447c09a600617fa6e6082729f6e95f008b59c91fe45`), expanded into
`$T\php`. Its `php.exe` has `FileVersion 8.3.35`, which is in the affected range.

**Scan config: the one setting that matters.** `wscansw` reads its file-search settings from the
`FSScanner` plugin in the same `config.xml`. The sample has
`<Attribute name="excludeDirectory" value="C:\dir_to_exclude"/>`. If the `FSScan` element
(`wscanfs`) doesn't exclude the same folders, `wscansw` decides the cached `C:\` tree doesn't match
(`traceCIT.log`: `FS_Cache2::executeQueryCacheOnlyEx - Existing tree for 'C:\' in the cache is not valid. Removing it, then recreating.`),
and **every `FindFilePathEx` returns nothing**. So the `FSScan` element must be:

```xml
<FSScan version="1.0" priority="normal"><IncludeDirectory value="C:\"/><ExcludeDirectory value="C:\dir_to_exclude"/>
  <FileMask value="php.exe"/><!-- one per FindFilePathEx name --><Age value="0"/><Timeout value="1800"/><OutputData value="BASIC"/></FSScan>
```

That was the cause of the earlier "unresolved `FindFilePathEx` problem". Before the fix, these
didn't help: running `wscansw` before `wscanfs`, `Age` 0 or 60, or a `-reset` before each run.
`FindFilePath rootPath="C:\some\folder\"` did work without the fix; `rootPath="C:\"` didn't. A
real BigFix Inventory deployment writes its own scan config, so this is most likely a test-setup
issue, not a signature issue *(inferred, not verified on a real deployment)*. The `bf-scanner`
service wasn't needed for these tests.

**Run:** `wscanfs.exe -c <config> -reset`, `wscanfs.exe -c <config> -o fs.xml`, then
`wscansw.exe -i <sigs> -c <config> -o sw.xml -e warn.xml`. Use `Start-Process -Wait` with
`-RedirectStandardOutput` and `-RedirectStandardError`. `wscansw -l MAX` writes a detailed trace
to stderr, and `$T\cit\logs\traceCIT.log` accumulates across runs. The `wscanfs` walk of `C:\` took
about 45 seconds. "path too long" messages for very deep folders are just skipped paths.

**Harness.** `win_scanner_test.py` does all of this from the Mac/Linux side, the same way as
`scanner_test.py`: shipped and diag copies, level-3 validation, a config with the plugin's
excludes copied into `FSScan`, `scp` both files to the test folder, run, copy `sw.xml` back:

```python
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
```

```bash
WINHOST=<user>@<windows-host> python3 win_scanner_test.py 'C:\bfi_sig_test_node' <local copy of CIT config/xss> scanner_signatures/*.xml
```

**Results for the PHP file** (fixture: `$T\php`, above):

| What | Result |
|---|---|
| Signature #1 as shipped and diag, with the fixed config | **`C:\bfi_sig_test\php\` `8.3.35.0` / true**, plus other `php.exe` copies already on the host (8.3.35 / true, 8.3.36 / false in diag) |
| Before the config fix | No match (`FindFilePathEx` returned nothing). With its iterator replaced by a fixed path the result was the same `8.3.35.0` / true |

Node.js and Electron results on Windows are in section 8.4.

## 6. CI (future)

Everything above runs unattended on a GitHub `ubuntu-latest` (x86_64) runner. Suggested jobs:

1. **lint** (fast, every PR touching `scanner_signatures/**`):
   - Level 1 (outer XSD via `validate-bes-xml`) and level 2 (CDATA well-formed).
   - Repo conventions: unique lowercase UUIDs across the whole folder, `modified` updated on changed signatures, a size guard before every `ReadFile`, and an identical `IS_INSTALLED` block within each file. Each is a short Python check.
2. **scanner** (behavior):
   - Download and verify the CIT bundle with section 5.1's pinned URL and SHA256. Cache it with `actions/cache`, keyed on the SHA256. Install it once on the runner, then `tar` the tree.
   - Use a matrix of containers, one per expected-results row: `debian:12`, `ubuntu:24.04`, `rockylinux:9`, each with the software installed and the scanner tree copied in (for Node, also the section 8.3 rows: official tarballs, NodeSource, the Rocky `nodejs:22` module). Run `scanner_test.py` in each; it also performs level 3.
   - Compare the JSON with a checked-in expectations file, e.g. `scanner_signatures/tests/<signature file>.expected.json`, mapping container to signature `#n` to `[DETAILED_VER, IS_INSTALLED]` for shipped and diag. Fail on any difference.
   - Fixtures that a package manager can't provide (e.g. a source tree) are planted by a small setup script per row.
3. **Never commit HCL files** (scanner binaries, `config/xss/*.xsd`, `config.xml`). Download them in CI.
4. **Windows:** a `windows-latest` job can install the scanner with section 5.6's verified
   PowerShell and run the signatures with the section 5.6 config (`FSScan` excludes matching the
   `FSScanner` plugin's), including `FindFilePathEx`. Fixtures: the PHP zip and the Node zips and
   MSI from section 8.4.

## 7. Publishing to CommunityContent

CommunityContent keeps signatures as top-level `Signatures/*.xml`. Its PR workflow validates
them against `signature.xsd` (level 1 only). Run levels 2-4 here first. The PHP file here is
the same as `Signatures/software_PHP_all_Affected_by_CVE-2026-109618_and_CVE-2026-109619-0.AFFECTED.xml`
on CommunityContent's `php-signature-fixes` branch. Keep the two in sync.

The Node.js and Electron files aren't in CommunityContent yet.

## 8. Node.js and Electron

Three files share one design:

- `software_Node.js_all_Affected_by_CVE-2026-111497-0.AFFECTED.xml` (CVE)
- `software_Node.js_ANY-0.any_version.xml` (inventory)
- `software_Electron_ANY-0.any_version.xml`

The two Node files have the **same 5 detection bodies** and differ only in the `IS_INSTALLED` block.
All three use vendor `OpenJS Foundation`. They're meant to complement the YARA scan
(jgstew/tools `YARA/node/`), not replace it: see section 8.5 for what only YARA sees.

### 8.1 What they report

**CVE-2026-111497** (Brotli decoder out-of-bounds write). Source: the nodejs.org
"October 2026 security releases" advisory. It says the flaw "affects Node.js 26.x, 24.x, and
22.x", lists the releases 22.23.4, 24.22.1 and 26.12.1, and says "End-of-Life versions are
always affected when a security release occurs". As decided for this content, every end-of-life
line counts as affected:

| Affected (`IS_INSTALLED=true`) | Not affected |
|---|---|
| `< 22.23.4` (every older line, including 20.x and earlier) | `22.23.4`-`22.x` |
| `23.0.0`-`< 24.22.1` (all of 23.x) | `24.22.1`-`24.x` |
| `25.0.0`-`< 26.12.1` (all of 25.x) | `26.12.1` and later, including 27+ |

- **False positives are accepted, but false negatives must not increase.** So:
  - Very old Node with no Brotli support at all is also flagged.
  - Distro packages are compared by version number only. They may backport the fix, or build
    against the system Brotli library, so a flagged distro build (e.g. RHEL's `nodejs:22` module
    `22.23.2`) needs the distro's advisory *(not checked per distro)*.
- Versions are cropped to `X.Y.Z` before comparing, so a `22.23.4-rc.1` pre-release counts as fixed.
- **Electron isn't in the CVE file.** Electron builds Node against Chromium's Brotli *(reported in
  the reference YARA content; not verified here)*, so Node's fixed versions don't apply to it.

**Inventory** (`Node.js ANY`, `Electron ANY`, version `0.any_version`): every instance found,
`IS_INSTALLED` is `true` whenever `DETAILED_VER` isn't empty.

**Electron's embedded Node version isn't readable** without the YARA scan. The Electron version
is, and `https://releases.electronjs.org/releases.json` maps it to Node (its `node` field):
44.7.0 → 24.21.0, 43.7.7 → 24.21.0, 39.8.8 → 22.22.1, 19.1.8 → 16.14.2 (checked October 2026).

### 8.2 Detection methods

| # | Node.js | Evidence | `DETAILED_VER` | `INSTALL_PATH` |
|---|---|---|---|---|
| 1 | Windows `node.exe` (zip, MSI, any copy in the scan scope) | `FindFilePathEx name="node.exe"` + `WinFileInfo field="version"` | `22.23.3.0` cropped right at `.` → `22.23.3` | folder of `node.exe` |
| 2 | Windows MSI from nodejs.org (also winget and Chocolatey, which run it *(not verified)*) | `MsiProductList` (all), keep `name` = `Node.js`; `MsiProductInfo field="version"` | `22.23.3` | `HKLM\SOFTWARE\Node.js` `InstallPath` (the MSI's `installDir` is empty) |
| 3 | Linux/macOS official layouts: tarball, nvm, `/usr/local` (Docker `node` images, `n`), Homebrew Cellar, NodeSource `.deb`. Also expected, as they unpack the same tarball: fnm, Volta, asdf, the macOS `.pkg` *(not tested)* | `FindFilePathEx name="node_version.h"` in `*/include/node/`, require `../../bin/node`, read it (4 KB) | `NODE_MAJOR_VERSION`.`MINOR`.`PATCH` | `<root>/bin/` |
| 4 | Debian/Ubuntu, NodeSource `.deb` | `DpkgProductList` `nodejs` + `libnode*`, skip `*-dev` | dpkg version minus epoch, `-…`, `+…`, `~…` | `/usr/` |
| 5 | RHEL/Rocky/Alma (appstream and modules), Fedora, NodeSource `.rpm`, `nodejs<NN>` names | `RpmProductList filter="nodejs*"`, skip names ending `-devel`, `-docs`, `-full-i18n`, `-packaging`, `-debuginfo`, `-debugsource` | `displayVersion`, cropped the same way | `RpmProductInfo installDir` |

| # | Electron | Evidence | `DETAILED_VER` | `INSTALL_PATH` |
|---|---|---|---|---|
| 1 | macOS: any Electron app (every app bundles the framework) | `FindFilePathEx name="Info.plist"` in `*/Electron Framework.framework/Versions/*/Resources/`, `CFBundleVersion` from the XML plist | Electron version as written (`43.7.7`, GoTo's `39.8.8-29`) | the `.app` folder |
| 2 | Windows/Linux: an unpacked Electron distribution (`node_modules/electron/dist`, the release zips) | `FindFilePathEx name="LICENSES.chromium.html"`, require `electron` or `electron.exe` and a `version` file next to it | contents of `version` | that folder |

Why these:
- **The `node` binary itself isn't searched for.** It's 25-125 MB with the version only inside
  (`node.js/v<ver>`, which the scanner can't pattern-search), and distro `node` is a 26 KB
  launcher.
- **`node_version.h` has been in every official tarball checked** (8.17.0 to 26.12.1) and in
  Homebrew's Cellar. It's only 4 KB.
- **Requiring `../../bin/node`** keeps node-gyp's header caches (`~/.cache/node-gyp/<ver>/include/node`)
  out. Those are headers, not runtimes.
- **The Windows zips have no `include/`**, so signature #1 uses the version resource.
- **Packaged Electron apps on Windows/Linux** (VS Code, Slack, ...) have **no `version` file**
  (checked: the VS Code Linux build) and no other small file with a version, so they're out of
  reach (section 8.5).

### 8.3 Expected results on Linux (verified)

Scanner 11.0.44.0, `scanner_test.py`. Containers: `debian:12`, `ubuntu:24.04`, `rockylinux:9`, `node:24.10.0`
(amd64). Official builds were checked against each release's `SHASUMS256.txt`, and the Electron
zip against Electron's `SHASUMS256.txt`. The CVE column shows shipped `IS_INSTALLED`. The ones
marked false show only in the diag copy. The inventory file reports every row with
`IS_INSTALLED=true`.

**Header layouts** (Node #3), all in the Debian container:

| Fixture (planted) | `DETAILED_VER` | CVE |
|---|---|---|
| Official tarballs in `/opt/node-v<ver>-linux-x64`: 8.17.0, 16.20.2, 18.20.8, 20.20.2, 22.23.3, 23.11.1, 24.22.0, 25.9.0, 26.12.0 | same as the release | true |
| Official tarballs 22.23.4, 24.22.1, 26.12.1 | same | **false** (fixed) |
| nvm layout `/root/.nvm/versions/node/v22.23.3` (copy of the tarball) | 22.23.3 | true |
| `/usr/local/bin/node` + `/usr/local/include/node` (Docker image / `n` layout, 20.20.2) | 20.20.2 | true |
| Homebrew-style `/home/linuxbrew/.linuxbrew/Cellar/node/26.12.1/{bin,include}` (simulated with the official build) | 26.12.1 | false |
| Debian `libnode-dev` (`/usr/include/node` + `/usr/bin/node`) | 18.20.4 | true |
| Official Docker image `node:24.10.0` (amd64, its own container: `/usr/local/bin/node` + `/usr/local/include/node`) | 24.10.0 | true |
| node-gyp header cache `/root/.cache/node-gyp/24.22.0/include/node` (no `bin/node`) | no match | - |

**Packages** (Node #4 dpkg, #5 RPM):

| Container (packages) | Matches | CVE |
|---|---|---|
| Debian 12 + `nodejs` `18.20.4+dfsg-1~deb12u3`, `libnode108`, `libnode-dev` | #4: 2 × `18.20.4` (`nodejs`, `libnode108`; `-dev` skipped), #3: 1 × 18.20.4 (above) | true |
| Ubuntu 24.04 + `nodejs` `18.19.1+dfsg-6ubuntu5` (`libnode109`) | #4: 2 × `18.19.1` | true |
| Debian 12 + NodeSource 22.x `nodejs` `22.23.4-1nodesource1` | #4: `22.23.4`, #3: `22.23.4` (`/usr/include/node`) | false |
| Rocky 9 + `nodejs` `1:16.20.2-8.el9_4` (`nodejs-libs`, `nodejs-docs`, `nodejs-full-i18n`) | #5: 2 × `16.20.2` (`nodejs`, `nodejs-libs`) | true |
| Rocky 9 + module `nodejs:22` `1:22.23.2-2.module+el9.8.0+...` | #5: 2 × `22.23.2` | true (see backports, 8.1) |
| Rocky 9 + NodeSource 24.x `nodejs` `24.22.1-1nodesource` | #5: `24.22.1` | false |

**Electron**, in the Debian container:

| Fixture | Electron # | `DETAILED_VER` |
|---|---|---|
| macOS framework `Info.plist` copied from VS Code and GoTo into `/Applications/<app>.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Resources/` | 1 | `43.7.7`, `39.8.8-29` (`INSTALL_PATH` `/Applications/<app>.app/`) |
| Official `electron-v44.7.0-linux-x64.zip` unpacked in `/opt/electron-44.7.0` and `/root/proj/node_modules/electron/dist` | 2 | `44.7.0` (both) |
| VS Code Linux build in `/opt/VSCode` (packaged app, no `version` file) | - | no match |

Expected warnings: the providers missing on each OS (`MsiProductList` "could not be resolved",
`RpmProductList`/`DpkgProductList` "failed").

### 8.4 Windows results (verified)

Windows Server 2022, scanner 11.0.44.0, `win_scanner_test.py` (section 5.6). Test folder
`C:\bfi_sig_test_node`, with a separate CIT install in `cit\`. Fixtures:

- **Zips:** official `node-v<ver>-win-x64.zip` (8.17.0, 20.20.2, 22.23.3, 24.22.1, 26.12.0),
  SHA256-checked against `SHASUMS256.txt`, in `node\`.
- **MSI:** `node-v22.23.3-x64.msi`, installed with
  `msiexec /i <msi> /qn ADDLOCAL=NodeRuntime INSTALLDIR=C:\bfi_sig_test_node\msi\nodejs\`
  (runtime only, no PATH change). This registers an Uninstall entry (`{8077DB9D-18D9-4DAF-8CA6-B8CAE42EB734}`, `Node.js`, publisher
  `Node.js Foundation`) and `HKLM\SOFTWARE\Node.js` (`InstallPath`, `Version`). It's left installed:
  remove it with `msiexec /x {8077DB9D-18D9-4DAF-8CA6-B8CAE42EB734} /qn`.
- **Electron:** `electron-v44.7.0-win32-x64.zip` (SHA256-checked), in `electron\`.

| Signature | Result |
|---|---|
| Node #1 `node.exe` | 6 instances: the 5 zips and the MSI copy, `DETAILED_VER` = release version (`WinFileInfo` `X.Y.Z.0` cropped). CVE: 24.22.1 false, the rest true |
| Node #2 MSI | `22.23.3`, `INSTALL_PATH` `C:\bfi_sig_test_node\msi\nodejs\`, CVE true |
| Node #3-#5 | no match (no such files or packages on Windows) |
| Electron #2 | `44.7.0`, `INSTALL_PATH` the unpacked zip |

### 8.5 What these signatures can't see (the YARA scan can)

| Case | Why it's out of reach | YARA (`YARA/node/node_detect.yar`) |
|---|---|---|
| Electron apps on Windows/Linux (VS Code, Slack, Teams, ...) | No small file with the Electron or Node version | `Node_Electron_Version`: Electron and embedded Node versions |
| Node version inside any Electron app (all platforms) | Only in the binary (`node.js/v<ver>`) | `Node_Electron_Version` |
| Node SEA (single-executable apps, e.g. GitHub Copilot CLI), vercel/pkg, nexe | One renamed executable, no headers | `Node_Runtime_Version` (`node.js/v`, or release URL + ABI symbol for pkg) |
| Node embedded as a library (Adobe `libnode.dylib`, VMware Fusion, Adobe's `*.node` runtime) | No headers or package | `Node_Runtime_Version` / `Node_Binary_Broad` |
| A bare `node` / `node.exe` copied without its `include/` (Linux/macOS), or renamed | Nothing readable next to it (Windows: only if named `node.exe`) | `Node_Runtime_Version` |
| Alpine (`apk`) packages, musl | No `apk` provider; the Linux CIT bundle is glibc-only | `Node_Runtime_Version` |
| Bun, Deno | Not Node.js; not detected (like the YARA rules, which report Bun only as `node unknown`) | `Node_Binary_Broad` |

Native addons (`*.node` in `node_modules`) aren't runtimes and aren't reported, as in the YARA
rules' version output.

### 8.6 Duplicates (expected)

One install can be reported more than once, always with the same version:
- dpkg `nodejs` + `libnode<ABI>`, and RPM `nodejs` + `nodejs-libs`, on the same machine.
- A NodeSource `.deb` or Debian `libnode-dev` adds signature #3 (`/usr/include/node`).
- On Windows, an MSI install is found by #1 (its `node.exe`) and #2.

### 8.7 Not tested

- A real macOS scanner (the macOS layouts were planted in Linux), `MacPkgList` for the nodejs.org
  `.pkg` (not used: the `.pkg` installs `/usr/local/include/node`, which #3 covers *(not verified)*).
- winget/Chocolatey/Scoop installs; the 32-bit (`x86`) MSI; `nodejs<NN>` RPM names (SUSE, Amazon
  Linux 2023); Fedora; snap.
- A real BigFix Inventory deployment (all results here are from standalone CIT).
- Pre-release Node builds (e.g. `-rc` or nightly headers), and Electron's `version` file on macOS
  dists (macOS uses the plist).
