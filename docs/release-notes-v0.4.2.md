# Sunburst Disk 0.4.2

The **Rust + Tauri v2** macOS disk analyzer with an interactive sunburst.

> A small follow-up to 0.4.1.

## Changes since 0.4.1

- **The “Available Offline” cloud view is now sized by what is on this Mac.** With
  the filter active, the sunburst’s slices and centre hub use the downloaded
  (`localBytes`) figures instead of the cloud logical sizes, and the header total
  and legend rows match. “Available Online” and the other views still use cloud
  sizes.
- **The home screen shows a spinner while it enumerates connected disks.** With
  many mounted volumes that call can take a moment; the themed spinner (and
  “Checking connected disks…”) replaces the empty list until it finishes.

## Downloads

**Apple Silicon (arm64) only** — Intel Macs are not supported in this release.

| File | Size | Notes |
|---|---|---|
| `Sunburst.Disk_0.4.2_aarch64.dmg` | ~6 MB | macOS 11+, Apple Silicon (M-series) |
| `Sunburst.Disk_aarch64.app.tar.gz` | ~6 MB | updater artifact for *Check for Updates…* |

## Notes

- **Apple Silicon (arm64) only.** Everything else from 0.4.1 is unchanged.
- Cloud actions remain explicit and confirmed: nothing is deleted automatically,
  and moving cloud items to the provider’s Trash still requires the typed-count
  confirmation.

Licensed under the [MIT License](LICENSE).
