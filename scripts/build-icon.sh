#!/usr/bin/env bash
# Compile the Icon Composer bundle (src-tauri/icons/Sunburst Disk.icon) into the
# macOS 26+ asset-catalog icon (Assets.car, which carries the light/dark/tinted
# appearances) plus a fallback .icns, using `actool`.
#
# Requires Xcode. The outputs are committed to src-tauri/icons, so a normal
# `tauri build` does not need Xcode — run this only when the .icon changes.
set -euo pipefail

cd "$(dirname "$0")/.."

ICON_SRC="src-tauri/icons/Sunburst Disk.icon"
ICON_NAME="Sunburst Disk"
OUT_DIR="$(mktemp -d)"
trap 'rm -rf "$OUT_DIR"' EXIT

xcrun actool "$ICON_SRC" \
  --compile "$OUT_DIR" \
  --platform macosx \
  --minimum-deployment-target 26.0 \
  --app-icon "$ICON_NAME" \
  --output-partial-info-plist "$OUT_DIR/partial.plist" \
  --target-device mac \
  --output-format human-readable-text

cp "$OUT_DIR/Assets.car" "src-tauri/icons/Assets.car"
cp "$OUT_DIR/$ICON_NAME.icns" "src-tauri/icons/icon.icns"
echo "Wrote src-tauri/icons/Assets.car and src-tauri/icons/icon.icns"
