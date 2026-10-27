#!/usr/bin/env bash
# Fails if any compiled native binary bundled in a packaged app is built for the
# wrong CPU architecture. node-pty loads build/Release/pty.node before its
# prebuilds, so a binary compiled for the build machine's arch can end up in an
# app packaged for a different arch and break the terminal at runtime.
#
# Usage: check-native-arch.sh <app.asar.unpacked dir> <expected `file` arch string>
set -euo pipefail

dir="$1"
expected="$2"

if [ ! -d "$dir" ]; then
  echo "::error::$dir does not exist"
  exit 1
fi

status=0
found=0
while IFS= read -r -d '' module; do
  description="$(file -b "$module")"
  # build/Release also holds build logs and dependency lists; only check binaries.
  # Not just *.node: on macOS node-pty also compiles a spawn-helper executable.
  if [[ "$description" != ELF* && "$description" != Mach-O* ]]; then
    continue
  fi
  found=1
  if [[ "$description" == *"$expected"* ]]; then
    echo "ok   $module"
  else
    echo "::error::$module is not $expected: $description"
    status=1
  fi
done < <(find "$dir" -path '*/build/Release/*' -type f -print0)

if [ "$found" -eq 0 ]; then
  echo "no compiled native modules in $dir (prebuilds only)"
fi
exit "$status"
