# Sunburst Disk 0.4.4

The **Rust + Tauri v2** macOS disk analyzer with an interactive sunburst.

> One universal build: the same download now runs natively on Apple Silicon and
> on Intel.

## Changes since 0.4.3

- **Universal release.** The app and its bundled Quick Look helper are now built
  for both architectures and merged into one binary, so there is a single DMG
  instead of an Apple-Silicon-only one. Intel Macs running macOS 11 or later can
  use every feature — scanning, the sunburst, Quick Look previews, the Terminal
  and its administrator writes, cloud views and Move & Symlink.
- **Nothing else changed.** This release is the 0.4.3 feature set, rebuilt
  universal; no behaviour is different on either architecture.

## Downloads

| File | Size | Notes |
|---|---|---|
| `Sunburst.Disk_0.4.4_universal.dmg` | ~8 MB | macOS 11+, Apple Silicon **and** Intel |
| `Sunburst.Disk_universal.app.tar.gz` | ~8 MB | the same app bundle, archived |

**One download.** The universal build contains both slices; macOS picks the
native one automatically, so there is nothing to choose and no Rosetta overhead.

## Notes

- **Local scans remain review-only.** Nothing is deleted automatically; cloud
  items still move to the provider's Trash only on explicit, typed confirmation.
- On macOS 26+ the app shows the dark/tinted icon variant; earlier versions use
  the standard icon.
- Licensed under the [MIT License](LICENSE).
