# Sunburst Disk 0.3.7

The **Rust + Tauri v2** macOS disk analyzer with an interactive sunburst.

## Changes since 0.3.6

- **Fixed: Smart Clean could hang for many minutes.** To find duplicate files it
  read (hashed) up to 400 files — and with iCloud *Desktop & Documents* enabled,
  `~/Documents` holds **dataless placeholders**, so reading one made macOS
  *download* it. The preview sat there fetching your documents and pulled your data
  over the network. It now only considers files that are actually on this Mac,
  which takes the preview from minutes to well under a second. Directory sizes are
  also measured with a bounded, cloud-aware walk instead of `du -sk -x`.
- **New: “Cloud Storage” on the home page.** A read-only panel showing, for every
  connected provider (Google Drive, Dropbox, OneDrive, iCloud Drive, …):
  - how much the drive holds **in the cloud** versus what it costs **on this Mac**,
  - how many files are **not downloaded**,
  - the **largest items stored locally**, each with *Reveal in Finder*,
  - plus the local space the **cloud clients** themselves keep (indexes and
    caches) — real disk space on a full drive.
  It never downloads, deletes or uses any cloud API, and it warns when iCloud is
  also syncing Desktop & Documents so those bytes aren't counted twice.
- The home page's *System Smart Clean* button was redundant (the drive page's
  **Smart Clean → Current Storage** is the same scope), so **Cloud Storage** takes
  its place. Smart Clean itself is unchanged.

## Highlights

- **Native Rust core.** In-process scanner with `du -x` parity — one filesystem,
  system junk and cloud FileProvider domains pruned, every physical object counted
  once (filesystem boundaries, firmlinks and hardlinks de-duplicated by
  `(st_dev, st_ino)`).
- **Interactive sunburst + matching content tree**, with a details inspector,
  Quick Look, Reveal in Finder, Open With and a read-only archive viewer.
- **Review-first by design.** Nothing is deleted automatically; removal goes to
  the macOS Trash and protected system paths are refused.
- **Smart Clean preview** across Safe / Moderate / High tiers, each candidate with
  a reason, a verification note and an age.
- **In-app updates**: *Check for Updates…* in the app menu downloads the new
  release itself, opens it in Finder and skips Gatekeeper.
- **Hidden Space diagnostics**: purgeable space, local APFS snapshots and the
  remaining protected-space difference.

## Downloads

**Apple Silicon (arm64) only** — Intel Macs are not supported in this release.

| File | Size | Notes |
|---|---|---|
| `Sunburst Disk_0.3.7_aarch64.dmg` | ~6 MB | macOS 11+, Apple Silicon (M-series) |
| `Sunburst Disk.app` | ~8.7 MB | same build, unpacked |

Requirements: **macOS 11 or later on Apple Silicon (arm64)**.

## Install

1. Download and open the `.dmg`.
2. Drag **Sunburst Disk** into *Applications*.

> Updating from 0.3.6? Use *Check for Updates…* in the app menu — the image is not
> quarantined and opens directly. If you download through a browser instead, macOS
> will warn: right-click the app → **Open**, or run
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
- The Cloud Storage panel is informational: cloud figures are approximate, because
  a provider lists only what macOS has browsed and macOS reports a placeholder's
  full size without downloading it.

## Documentation

- `docs/electron-to-tauri-migration.md` — architecture and Electron→Tauri parity notes.
- `README.md` — features, build instructions and project layout.

Licensed under the [MIT License](LICENSE).
