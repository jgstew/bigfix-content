# scanner_signatures: BigFix Inventory scanner signatures

This folder holds **BigFix Inventory (BFI) software signatures**: XML files that
tell the BFI scanner (CIT: `wscanfs`, `wscansw`) how to recognize a piece of
software and its version on an endpoint. They're imported into BigFix
Inventory as custom catalog content. The same format is used in
[bigfix/CommunityContent `Signatures/`](https://github.com/bigfix/CommunityContent/tree/main/Signatures).

Everything below was verified with the CIT scanner **11.0.44.0**
(`linux-x86_64_11.0.44.0.tgz`) on Debian 12, Ubuntu 24.04 and Rocky Linux 9
(amd64 containers), and with `w64-ix86_11.0.44.0.zip` on Windows Server 2022
(section 5.6, partly), in October 2026. Facts marked *(not verified)* weren't.

| File | What it detects |
|---|---|
| `software_PHP_all_Affected_by_CVE-2026-109618_and_CVE-2026-109619-0.AFFECTED.xml` | PHP affected by CVE-2026-109618 / CVE-2026-109619: 5 signatures (Windows `php.exe`, Linux `NEWS`, PHP source tree, Debian/Ubuntu dpkg, RPM) |

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
| `FindFilePathEx` on Windows | **Unresolved:** in a standalone Windows install it returned nothing, though `wscanfs` walked and listed the files (section 5.6). Don't treat a Windows file-based signature as tested until a real BigFix Inventory scan matches it. |
| `WinFileInfo absolutePath=... field="version"` | Windows file version as 4 parts: `php.exe` 8.3.35 gives `8.3.35.0`. `Compare type="version"` against 3-part ranges works (`8.3.35.0` < `8.3.36`). |
| `Vector filter="..."` | The pattern must match the **whole** string. `*/usr/bin/` matches the folder returned with `appendFileName="false"`. To filter full paths (`appendFileName="true"`), use `*/usr/bin/*`. |
| `FileExists`, `ReadFile`, `FileInfoCompare` | Read the disk directly. No index or `FileMask` needed. |
| `ReadFile` | Always guard it with `FileExists` and `FileInfoCompare field="size" relation="le" value="5120000"` (repo convention: 512 KB-5 MB). |
| `StringCrop` | `startString`, `endString`, `inputString` are required, plus `seekFrom="left"` or `"right"`. Returns the text between the first `startString` and the next `endString`. `startString=""` crops from the beginning: `StringCrop endString="-" startString=""` on `8.2.35-1~deb12u1` gives `8.2.35`. Wrap it in `<VectorToScalar>` when the result is used as a scalar (the majority pattern). |
| `DpkgProductList filter="php*-common" type="any"` | Native dpkg provider. Iterates **package names** (`php8.2-common`, `php-common`). |
| `DpkgProductInfo code=... field=...` | `field` is one of `name`, `version`, `displayVersion`, `description`. `version` = dpkg version, e.g. `8.2.35-1~deb12u1`, `8.3.6-0ubuntu0.24.04.13`, metapackage `2:93`. |
| `RpmProductList filter="*php-common-*" type="any"` | Iterates **name-version-release.arch** strings (`php-common-8.0.30-8.el9_8.1.x86_64`), so a filter needs a trailing `-*` or `*`. A leading `*` works (it also matches Remi `php83-php-common-...`). |
| `RpmProductInfo field="version"` | **Returns `8.0.30.8.el9_8.1`** (version.release joined with a dot), which `Compare type="version"` **can't** handle. Use `field="displayVersion"` (`8.0.30-8.el9_8.1`) and crop at `-`. Other fields: `name`, `release`, `vendor`, `arch`, `installDir` (comma list, e.g. `/etc/,/usr/,/var/lib/`), `installDate`, ... |
| `Compare relation="lt|le|eq|ne|ge|gt" type="version|string|cistring|integer|hex|boolean"` | `version` compares dotted numbers. Feed it clean `X.Y.Z` (crop distro suffixes first). |
| `Contains position="contains|start|end"` | Boolean. |
| A provider missing on the OS | E.g. `RpmProductList` on Debian or `DpkgProductList` on RHEL: a *warning* ("Vector expression [...] failed"). That signature matches nothing, and the others still run. This is expected. |
| `PackageInfoMatch name vendor version` | Boolean match against installed packages. Used by some CommunityContent signatures *(behavior not verified here)*. |

The complete element and attribute list is in the XSS schema (section 3, level 3).
When in doubt, write a probe signature that exports intermediate values
(section 4.3) instead of guessing.

## 3. Writing a signature

1. **Pick evidence the scanner can read without running the software.** In order of preference:
   - **A package database** (`DpkgProductList`/`RpmProductList` + `*Info`): reliable versions, no file search.
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
Signature #1 (Windows) is covered in section 5.6. Its version logic is verified, but its `FindFilePathEx` file search isn't.

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

### 5.6 Windows (partly verified)

Tested on Windows Server 2022 over SSH (PowerShell 5.1, run as an administrator). Send multi-line
scripts as `powershell -NoProfile -NonInteractive -EncodedCommand <base64 of the UTF-16LE script>`
to avoid quoting problems. All paths stay under one test folder.

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

**Scan:**
- Wrap signature #1 as in level 3, with `<Platform type="WINDOWS"/>`.
- Make the scan config from `$T\cit\bin\config.xml`, replacing its `FSScan` element with
  `<FSScan version="1.0" priority="normal"><IncludeDirectory value="C:\"/><FileMask value="php.exe"/><Age value="60"/><Timeout value="1800"/><OutputData value="BASIC"/></FSScan>`.
- Copy both files over with `scp` (`scp f jgstew@host:C:/bfi_sig_test/`).
- Run `wscanfs.exe -c <config> -reset`, `wscanfs.exe -c <config> -o fs.xml`, then
  `wscansw.exe -i <sigs> -c <config> -o sw.xml -e warn.xml`. Use `Start-Process -Wait` with
  `-RedirectStandardOutput` and `-RedirectStandardError`. `wscansw -l MAX` writes a detailed
  trace to stderr, and `$T\cit\logs\traceCIT.log` accumulates across runs.
- The `wscanfs` walk of `C:\` took about 45 seconds. "path too long" messages for very deep
  folders are just skipped paths.

**Results for signature #1 (PHP 8.3.35):**

| What | Result |
|---|---|
| `wscanfs` | Walked `C:\` and listed every `php.exe` in `fs.xml` (4 copies) |
| Signature #1 as shipped, and the diag copy | **No match.** `FindFilePathEx name="php.exe"` returned nothing |
| Signature #1 with only its iterator replaced by `<Vector><ValueOf value="C:\bfi_sig_test\php\"/></Vector>` | **`DETAILED_VER=8.3.35.0`, `IS_INSTALLED=true`** for both shipped and diag: the `WinFileInfo` read and the version test are correct |

**The unresolved `FindFilePathEx` problem:**
- The `wscansw` trace shows the query `Executing fs query [FILENAME]=="php.exe"` returning
  `vector size=0`, then "Signature ... skipped because no instances are available".
- `traceCIT.log` shows `FS_Cache2::executeQueryCacheOnlyEx - Existing tree for 'C:\' in the cache is not valid. Removing it, then recreating.`
  during `wscansw`, and the cache's file table (`fsc_fil.dat`) stays about 250 bytes.
- Preprocessing does register the pattern (`FindFilePathEx::emitPrereqFile ... Pattern emitted: php.exe`).
- None of these changed the result: running `wscansw` before `wscanfs`, `Age` 0 or 60, a `-reset`
  before each run.
- The same approach works on Linux.
- On Windows, BigFix Inventory 11 also installs the **BigFix Scanner service** (`bf-scanner`,
  `bf-scanner-windows-amd64.zip` in the install task), which this setup doesn't include. Real
  deployments may rely on it for file searches *(not verified)*.

Next steps to resolve it:
1. Install the scanner with the real task on a Windows BigFix client, through
   bigfix-actionscript-runner (section 5.5) or a real action, so `bf-scanner` is present.
2. Or run a real BigFix Inventory software scan on a Windows endpoint, and check the signature's
   result in BigFix Inventory.

## 6. CI (future)

Everything above runs unattended on a GitHub `ubuntu-latest` (x86_64) runner. Suggested jobs:

1. **lint** (fast, every PR touching `scanner_signatures/**`):
   - Level 1 (outer XSD via `validate-bes-xml`) and level 2 (CDATA well-formed).
   - Repo conventions: unique lowercase UUIDs across the whole folder, `modified` updated on changed signatures, a size guard before every `ReadFile`, and an identical `IS_INSTALLED` block within each file. Each is a short Python check.
2. **scanner** (behavior):
   - Download and verify the CIT bundle with section 5.1's pinned URL and SHA256. Cache it with `actions/cache`, keyed on the SHA256. Install it once on the runner, then `tar` the tree.
   - Use a matrix of containers, one per expected-results row: `debian:12`, `ubuntu:24.04`, `rockylinux:9`, each with the software installed and the scanner tree copied in. Run `scanner_test.py` in each; it also performs level 3.
   - Compare the JSON with a checked-in expectations file, e.g. `scanner_signatures/tests/<signature file>.expected.json`, mapping container to signature `#n` to `[DETAILED_VER, IS_INSTALLED]` for shipped and diag. Fail on any difference.
   - Fixtures that a package manager can't provide (e.g. a source tree) are planted by a small setup script per row.
3. **Never commit HCL files** (scanner binaries, `config/xss/*.xsd`, `config.xml`). Download them in CI.
4. **Windows:** a `windows-latest` job can install the scanner with section 5.6's verified
   PowerShell and check version logic (fixed-path copies of a signature). File-based
   matching (`FindFilePathEx`) can't be tested that way until the section 5.6 problem is
   resolved.

## 7. Publishing to CommunityContent

CommunityContent keeps signatures as top-level `Signatures/*.xml`. Its PR workflow validates
them against `signature.xsd` (level 1 only). Run levels 2-4 here first. The PHP file here is
the same as `Signatures/software_PHP_all_Affected_by_CVE-2026-109618_and_CVE-2026-109619-0.AFFECTED.xml`
on CommunityContent's `php-signature-fixes` branch. Keep the two in sync.
