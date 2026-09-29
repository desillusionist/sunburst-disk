# Sunburst Disk 0.3.3

A small polish release: the **Rust + Tauri v2** macOS disk analyzer with an
interactive sunburst.

## Changes since 0.3.2

- **“Check for Updates…” moved into the app menu**, directly under
  *About Sunburst Disk*, where you would expect it.
- The check now reports its result in a **native dialog** — with a **Download**
  button when a newer version is available — instead of the old footer button.
  It compares your version with the newest GitHub release; it never downloads or
  installs anything by itself.

## Highlights

- **Native Rust core.** In-process scanner with `du -x` parity — one filesystem,
  system junk and cloud FileProvider domains pruned, and every physical object
  counted once (filesystem boundaries, firmlinks and hardlinks de-duplicated by
  `(st_dev, st_ino)`).
- **Interactive sunburst + matching content tree**, with a details inspector,
  Quick Look, Reveal in Finder, Open With and a read-only archive viewer.
- **Review-first by design.** Nothing is deleted automatically. Removal goes to
  the macOS Trash; protected system paths are refused; Hidden Space and admin
  Terminal act only after explicit, per-session authorization.
- **Smart Clean preview** across Safe / Moderate / High tiers: caches, logs,
  stale installers, duplicate files, language-model weights, Apple device
  backups and Xcode/simulator data — each with a reason, a verification note and
  a candidate age.
- **Hidden Space diagnostics**: purgeable space (Foundation volume capacities),
  local APFS snapshots and the remaining protected-space difference.
- **Live folder updates** via FSEvents, themes (Classic/Matrix), a drag-and-drop
  Collector, and a **macOS 26 icon** with light/dark/tinted variants.

## Downloads

**Apple Silicon (arm64) only** — Intel Macs are not supported in this release.

| File | Size | Notes |
|---|---|---|
| `Sunburst Disk_0.3.3_aarch64.dmg` | ~6 MB | macOS 11+, Apple Silicon (M-series) |
| `Sunburst Disk.app` | ~8.6 MB | same build, unpacked |

Requirements: **macOS 11 or later on Apple Silicon (arm64)**.

## Install

1. Download and open the `.dmg`.
2. Drag **Sunburst Disk** into *Applications*.

> The build is **not notarized**. If macOS refuses to open it, right-click the app
> → **Open**, or run:
> ```bash
> xattr -dr com.apple.quarantine "/Applications/Sunburst Disk.app"
> ```

For **Hidden Space** and the integrated **Terminal**, grant Full Disk Access in
*System Settings → Privacy & Security → Full Disk Access*.

## Notes

- **Apple Silicon (arm64) only.** Requires an M-series Mac; Intel is not
  supported yet.
- Writes are limited to the macOS Trash and the opt-in, password-scoped admin
  Terminal mode.
- Archive contents are virtual and read-only; they cannot be deleted, collected
  or written through the Terminal.
- “Check for Updates…” fetches the release list from GitHub; it offers the
  releases page instead if GitHub cannot be reached.

## Documentation

- `docs/electron-to-tauri-migration.md` — architecture and Electron→Tauri parity notes.
- `README.md` — features, build instructions and project layout.

Licensed under the [MIT License](LICENSE).
