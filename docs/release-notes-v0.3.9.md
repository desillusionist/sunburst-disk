# Sunburst Disk 0.3.9

The **Rust + Tauri v2** macOS disk analyzer with an interactive sunburst.

## Changes since 0.3.8

- **Fixed: a cloud folder could show an approximate size (≥) even after
  “Calculate exact size”.** Cloud walks stopped descending at **8 levels deep**, and
  any directory at that frontier was marked not-fully-walked — which propagated up,
  so a folder looked **exact while you were inside it** and **approximate one level
  up**. On a real folder (`My Drive/assets/logos/a content library [content
  models]/a project`) the project bottomed out at exactly 8 levels, so the parent
  read `≥ <redacted-size>` and the child `≥ <redacted-size>` even though every file had been counted.
  The depth limit is now **64** for the bounded walks and effectively uncapped
  (**1024**) for the opt-in exact walk, so “exact” means exact. That folder now
  reads an exact **<redacted-size>** (all children) and the project an exact **<redacted-size>**.
  Entry and time caps are unchanged, so the protection against a runaway walk stays.
- No other behaviour changed. Everything from 0.3.8 — the read-only cloud tree and
  sunburst, the capped folder walk with the opt-in *Calculate exact size* action,
  and the deletion refusal for cloud items — is unchanged.

## Highlights

- **Native Rust core.** In-process scanner with `du -x` parity — one filesystem,
  system junk and cloud FileProvider domains pruned, every physical object counted
  once (filesystem boundaries, firmlinks and hardlinks de-duplicated by
  `(st_dev, st_ino)`).
- **Interactive sunburst + matching content tree**, with a details inspector,
  Quick Look, Reveal in Finder, Open With and a read-only archive viewer.
- **Review-first by design.** Nothing is deleted automatically; removal goes to
  the macOS Trash and protected system paths are refused.
- **Cloud Storage panel** with a read-only cloud tree; a folder's size is always the
  sum of its contents (never a directory's own inode size), and a folder that is not
  fully measured reads as a lower bound (**≥**) with an opt-in exact walk.
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
| `Sunburst.Disk_0.3.9_aarch64.dmg` | ~6 MB | macOS 11+, Apple Silicon (M-series) |
| `Sunburst.Disk_aarch64.app.tar.gz` | ~6 MB | updater artifact for *Check for Updates…* |

Requirements: **macOS 11 or later on Apple Silicon (arm64)**.

## Install

1. Download and open the `.dmg`.
2. Drag **Sunburst Disk** into *Applications*.

> Updating from 0.3.8? Use *Check for Updates…* in the app menu — the image is not
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
- Cloud figures are approximate by nature: a provider lists only what macOS has
  browsed, and the top-level provider scan is time-bounded. A folder you open is
  measured under a generous cap, and offered an exact walk if the cap binds.

## Documentation

- `docs/electron-to-tauri-migration.md` — architecture and Electron→Tauri parity notes.
- `README.md` — features, build instructions and project layout.

Licensed under the [MIT License](LICENSE).
