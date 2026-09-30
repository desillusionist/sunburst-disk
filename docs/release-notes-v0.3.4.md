# Sunburst Disk 0.3.4

In-app updates: the **Rust + Tauri v2** macOS disk analyzer with an interactive
sunburst can now download and open its own next version.

## Changes since 0.3.3

- **“Check for Updates…” now does the update in-app.** Choose it from the app
  menu (below *About Sunburst Disk*); if a newer version exists, click
  **Download**. Sunburst Disk fetches the release DMG itself — with a progress
  indicator — mounts it and opens its Finder window, so you just drag the app
  onto the **Applications** alias. No browser, no Terminal command.
- Because the app performs the download, the image it saves is **not quarantined**,
  so the copy you install opens without the “unidentified developer” warning. No
  notarization is involved.
- Nothing is installed behind your back: the download is never verified by
  signature, the DMG is never installed automatically, and the final drag is
  always yours.

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
| `Sunburst Disk_0.3.4_aarch64.dmg` | ~6 MB | macOS 11+, Apple Silicon (M-series) |
| `Sunburst Disk.app` | ~8.6 MB | same build, unpacked |

Requirements: **macOS 11 or later on Apple Silicon (arm64)**.

## Install

1. Download and open the `.dmg`.
2. Drag **Sunburst Disk** into *Applications*.

> Installed via *Check for Updates…* inside the app? The image is not
> quarantined and the app opens directly. If you downloaded it through a browser
> instead, macOS will warn: right-click the app → **Open**, or run
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
- The update DMG is saved to your Downloads folder, and the app must be dragged
  into `Applications` to replace the old copy.

## Documentation

- `docs/electron-to-tauri-migration.md` — architecture and Electron→Tauri parity notes.
- `README.md` — features, build instructions and project layout.

Licensed under the [MIT License](LICENSE).
