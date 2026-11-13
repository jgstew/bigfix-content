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
