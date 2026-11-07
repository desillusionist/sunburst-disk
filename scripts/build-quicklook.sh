#!/usr/bin/env bash
# Build the Quick Look helper for BOTH architectures and lipo them into one
# universal binary.
#
# The helper is bundled as a resource and spawned as a child process, so an
# arm64-only build silently breaks Quick Look on Intel Macs. Requires Xcode's
# Swift toolchain (which ships both SDK slices).
set -euo pipefail

cd "$(dirname "$0")/.."

OUT_DIR="$(mktemp -d)"
trap 'rm -rf "$OUT_DIR"' EXIT

# macOS 11 is the first release that runs both slices, and matches the app's
# minimumSystemVersion.
for arch in arm64 x86_64; do
  swiftc -O -target "${arch}-apple-macos11.0" \
    electron/quicklook-preview.swift \
    -framework Cocoa -framework QuickLookUI \
    -o "$OUT_DIR/quicklook-preview-$arch"
done

lipo -create \
  "$OUT_DIR/quicklook-preview-arm64" \
  "$OUT_DIR/quicklook-preview-x86_64" \
  -output electron/quicklook-preview
chmod 755 electron/quicklook-preview

echo "Built $(lipo -archs electron/quicklook-preview) -> electron/quicklook-preview"
