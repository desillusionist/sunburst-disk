# Sunburst Disk 0.3.1

**A fast, safety-first macOS disk-space analyzer with an interactive sunburst.**
A maintenance release of the **Rust + Tauri v2** app: the original React
interface on a native Rust core instead of Electron.

## Changes since 0.3.0

- **Locked `hidden space...` slice** is now a neutral outline — the pale-red is
  reserved for the unlocked session — and on hover it fades from its normal look
  all the way to fully transparent.
- **Content-tree header:** the title scrolls automatically while you hover a
  slice, the redundant `preview` / `top 100` badges are gone, and Sort & Filter
  is a compact icon button.
- **Smart Clean:** each candidate now shows its age, and safe, regenerable caches
  unused for 60+ days get a "consider cleaning" hint; the list is ordered
  largest-first.

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
  backups and Xcode/simulator data — each with a reason and a verification note.
- **Hidden Space diagnostics**: purgeable space (Foundation volume capacities),
  local APFS snapshots and the remaining protected-space difference.
- **Live folder updates** via FSEvents, themes (Classic/Matrix), a drag-and-drop
  Collector, and a **macOS 26 icon** with light/dark/tinted variants built from an
  Icon Composer bundle.

## Downloads

**Apple Silicon (arm64) only** — Intel Macs are not supported in this release.

| File | Size | Notes |
|---|---|---|
| `Sunburst Disk_0.3.1_aarch64.dmg` | ~6 MB | macOS 11+, Apple Silicon (M-series) |
| `Sunburst Disk.app` | ~8.6 MB | same build, unpacked |

Requirements: **macOS 11 or later on Apple Silicon (arm64)**. A universal
(Intel + Apple Silicon) build is planned for a later release.

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
- Ask Siri requires a one-time shortcut setup — see
  `docs/how-to-create-sunburst-disk-ask-siri-shortcut.md`.

## Documentation

- `docs/electron-to-tauri-migration.md` — architecture and Electron→Tauri parity notes.
- `README.md` — features, build instructions and project layout.

Licensed under the [MIT License](LICENSE).
