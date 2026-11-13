"""Shared code for scanner_test.py (Linux container) and win_scanner_test.py (Windows over SSH).

Builds the shipped/diag signature document, the FSScan element, and parses wscansw output.
"""

import re
import sys
import uuid
from pathlib import Path
from xml.sax.saxutils import escape, unescape

NS = "http://www.ibm.com/Tivoli/Signatures"
IS_INSTALLED_SKIP = '<Condition withVariable="IS_INSTALLED"><Action do="SKIP" onValue="false"/></Condition>'


def collect(files):
    """Return ([(label, guid, body)], sorted file masks) for every <Signature> body in files."""
    sigs, masks = [], set()
    for f in files:
        text = Path(f).read_text(encoding="utf-8")
        for n, body in enumerate(re.findall(r"<!\[CDATA\[(.*?)\]\]>", text, re.S), 1):
            # unescape before splitting, so the ';' of an entity like &amp; isn't taken as a separator
            for v in re.findall(r'<FindFilePathEx[^>]*\bnames?="([^"]+)"', body):
                masks.update(m for m in re.split(r"[,;]", unescape(v, {"&quot;": '"', "&apos;": "'"})) if m)
            if IS_INSTALLED_SKIP not in body:
                print(f"warning: {Path(f).name}#{n} has no IS_INSTALLED skip; diag = shipped", file=sys.stderr)
            for kind, b in (("shipped", body), ("diag", body.replace(IS_INSTALLED_SKIP, ""))):
                sigs.append((f"{kind}:{Path(f).name}#{n}", uuid.uuid4().hex, b))
    return sigs, sorted(masks)


def signatures_doc(sigs, platform):
    return f'<?xml version="1.0" encoding="UTF-8"?>\n<Signatures xmlns="{NS}" version="1.0">\n' + "\n".join(
        f'<Signature guid="{g}"><Metadata><AnyMetadataTag>{label}</AnyMetadataTag></Metadata>'
        f'<Platforms><Platform type="{platform}"/></Platforms>{b}</Signature>' for label, g, b in sigs) + "\n</Signatures>\n"


def with_fsscan(config, include, excludes, masks):
    """Replace the first <FSScan> element in config.xml text with one for include/excludes/masks."""
    def attr(v):
        return escape(v, {'"': "&quot;"})
    fsscan = (f'<FSScan version="1.0" priority="normal"><IncludeDirectory value="{attr(include)}"/>'
              + "".join(f'<ExcludeDirectory value="{attr(d)}"/>' for d in excludes)
              + "".join(f'<FileMask value="{attr(m)}"/>' for m in masks)
              + '<Age value="0"/><Timeout value="1800"/><OutputData value="BASIC"/></FSScan>')
    # a function replacement: Windows paths and masks contain backslashes
    return re.sub(r"<FSScan .*?</FSScan>", lambda _: fsscan, config, count=1, flags=re.S)


def results(sw, sigs):
    """label -> list of matched instances (exported variables) from wscansw's sw.xml."""
    by_guid = {g: label for label, g, _ in sigs}
    result = {label: [] for label, _, _ in sigs}
    for g, body in re.findall(r'<MatchedSignature guid="(\w+)">(.*?)</MatchedSignature>', sw, re.S):
        result[by_guid[g]].append(dict(re.findall(r'<Variable name="(\w+)" value="([^"]*)"', body)))
    return result


def warnings(warn):
    return sorted(set(re.findall(r"<Info>([^<]*)", warn)))
