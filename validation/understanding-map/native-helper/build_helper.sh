#!/bin/sh
set -eu
TASK_HELPER_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
TASK_APP="$TASK_HELPER_ROOT/Understanding Map Navigator.app"
mkdir -p "$TASK_APP/Contents/MacOS"
TASK_SWIFT_CACHE=$(mktemp -d "${TMPDIR:-/tmp}/understanding-map-swift.XXXXXX")
trap 'rm -rf -- "$TASK_SWIFT_CACHE"' EXIT
swiftc -O -module-cache-path "$TASK_SWIFT_CACHE" \
  -framework AppKit -framework ApplicationServices \
  "$TASK_HELPER_ROOT/MapNavigator.swift" -o "$TASK_APP/Contents/MacOS/MapNavigator"
cp "$TASK_HELPER_ROOT/Info.plist" "$TASK_APP/Contents/Info.plist"
codesign --force --sign - --identifier local.understanding-map.navigator "$TASK_APP"
printf 'Built %s\n' "$TASK_APP"
printf 'Build only: no application was opened or controlled.\n'
