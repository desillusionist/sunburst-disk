# Sunburst Disk 0.3.6

A bug-fix release for the **Rust + Tauri v2** macOS disk analyzer.

## Changes since 0.3.5

- **Fixed the in-app updater.** *Check for Updates…* downloaded the new version
  correctly, but then could not open the installer because it invoked a system
  tool at the wrong path (`/usr/sbin/hdiutil` instead of `/usr/bin/hdiutil`), so
  every update ended with “The disk image could not be opened”.
- **Download now finishes the job**: it mounts the image and opens its Finder
  window, so you drag Sunburst Disk onto the **Applications** alias and reopen it.
- A new test, `update_binaries_exist`, pins the absolute paths the updater uses so
  a mistake like this fails in CI rather than at runtime.

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
- **In-app updates**: *Check for Updates…* in the app menu downloads the new
  release itself, opens it in Finder and skips Gatekeeper — no browser, no
  Terminal command.
- **Hidden Space diagnostics**: purgeable space (Foundation volume capacities),
  local APFS snapshots and the remaining protected-space difference.

## Downloads

**Apple Silicon (arm64) only** — Intel Macs are not supported in this release.

| File | Size | Notes |
|---|---|---|
| `Sunburst Disk_0.3.6_aarch64.dmg` | ~6 MB | macOS 11+, Apple Silicon (M-series) |
| `Sunburst Disk.app` | ~8.6 MB | same build, unpacked |

Requirements: **macOS 11 or later on Apple Silicon (arm64)**.

## Install

1. Download and open the `.dmg`.
2. Drag **Sunburst Disk** into *Applications*.

> Updating from 0.3.5? Its in-app updater is broken, so install this release once
> by downloading it here; from 0.3.6 onward *Check for Updates…* works. If you
> download through a browser, macOS will warn: right-click the app → **Open**, or
> run
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

## Documentation

- `docs/electron-to-tauri-migration.md` — architecture and Electron→Tauri parity notes.
- `README.md` — features, build instructions and project layout.

Licensed under the [MIT License](LICENSE).
