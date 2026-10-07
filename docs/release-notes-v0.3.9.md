# Sunburst Disk 0.3.9

The **Rust + Tauri v2** macOS disk analyzer with an interactive sunburst.

> 0.3.8 was an internal build; these notes cover everything since the last public release, 0.3.7.

## Changes since 0.3.7

- **New: scan a cloud provider as a read-only sunburst + content tree.** The Cloud Storage panel gained a per-provider **Scan** action that opens that provider in the normal sunburst + content-tree view — browsing only. No file is ever read or downloaded, and cloud items can never be deleted, collected, or sent to Smart Clean. Because enumerating a cloud mirror is slow, the walk is bounded: the provider chart appears under a time/entry cap and reads as a lower bound (**≥**); opening a folder measures it under a generous cap; and a per-folder **Calculate exact size** runs a full, cancellable walk when you want an exact figure. A folder's size is always the sum of its contents, never a directory's own inode size.
- **Fixed: a cloud folder could show an approximate size (≥) even after "Calculate exact size."** Cloud walks stopped descending at **8 levels deep**, so any directory at that frontier was marked not-fully-walked. That propagated upward, so a deep folder could look exact while you were inside it but approximate one level up — even though every file had already been counted. The depth limit is now **64** for bounded walks and effectively uncapped (**1024**) for the opt-in exact walk, so "exact" means exact. Entry and time caps are unchanged, so the protection against a runaway walk stays.

## Highlights

- **Native Rust core.** In-process scanner with `du -x` parity — one filesystem, system junk and cloud FileProvider domains pruned, every physical object counted once (`(st_dev, st_ino)` de-duplication).
- **Interactive sunburst + matching content tree**, with a details inspector, Quick Look, Reveal in Finder, Open With and a read-only archive viewer.
- **Review-first by design.** Nothing is deleted automatically; removal goes to the macOS Trash and protected system paths are refused.
- **Cloud Storage**: the informational per-provider panel (cloud vs. on-Mac size, un-downloaded file counts, largest local items) plus the new read-only Scan → sunburst + tree described above.
- **Smart Clean preview** across Safe / Moderate / High tiers, each candidate with a reason, a verification note and an age.
- **In-app updates**: *Check for Updates…* downloads the new release, opens it in Finder and skips Gatekeeper.
- **Hidden Space diagnostics**: purgeable space, local APFS snapshots and the remaining protected-space difference.

## Downloads

**Apple Silicon (arm64) only** — Intel Macs are not supported in this release.

| File | Size | Notes |
|---|---|---|
| `Sunburst.Disk_0.3.9_aarch64.dmg` | ~6 MB | macOS 11+, Apple Silicon (M-series) |
| `Sunburst.Disk_aarch64.app.tar.gz` | ~6 MB | updater artifact for *Check for Updates…* |

## Install

1. Download and open the `.dmg`.
2. Drag **Sunburst Disk** into *Applications*.

> Updating from 0.3.7? Use *Check for Updates…* in the app menu — the image is not quarantined and opens directly. If you download through a browser, right-click the app → **Open**, or run `xattr -dr com.apple.quarantine "/Applications/Sunburst Disk.app"`.

For **Hidden Space** and the integrated **Terminal**, grant Full Disk Access in *System Settings → Privacy & Security → Full Disk Access*.

## Notes

- **Apple Silicon (arm64) only.** Intel is not supported yet.
- Writes are limited to the macOS Trash and the opt-in, password-scoped admin Terminal mode.
- Cloud figures are approximate by nature: a provider lists only what macOS has browsed, and the top-level provider scan is time-bounded. A folder you open is measured under a generous cap, with an exact walk offered if the cap binds.

Licensed under the [MIT License](LICENSE).
