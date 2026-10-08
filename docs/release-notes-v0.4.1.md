# Sunburst Disk 0.4.1

The **Rust + Tauri v2** macOS disk analyzer with an interactive sunburst.

> A small follow-up to 0.4.0.

## Changes since 0.4.0

- **Provider-aware cloud-trash labels.** The cloud basket and its confirmation now name the provider you are viewing — Google Drive, iCloud Drive, OneDrive, Dropbox … — instead of always saying “Google Drive”.
- **“Open Google Drive Trash” follows the account you scanned.** It opens `https://drive.google.com/drive/trash?authuser=<account>` for the provider actually being viewed (derived from the `GoogleDrive-<email>` folder), so it always lands on the right Drive and survives adding or removing accounts. It uses the account email, not a positional account slot.
- **⌘Z un-stages basket items.** You can undo the last add or remove in the cloud basket before anything is trashed. This is a local list undo only — it can never trigger a trash or a restore.

## Downloads

**Apple Silicon (arm64) only** — Intel Macs are not supported in this release.

| File | Size | Notes |
|---|---|---|
| `Sunburst.Disk_0.4.1_aarch64.dmg` | ~6 MB | macOS 11+, Apple Silicon (M-series) |
| `Sunburst.Disk_aarch64.app.tar.gz` | ~6 MB | updater artifact for *Check for Updates…* |

## Notes

- **Apple Silicon (arm64) only.** The rest of 0.4.0 is unchanged.
- Recovery of a trashed cloud item is via your provider's Trash (~30 days). There is no in-app un-trash yet; restoring an item from the provider's Trash is under review.

Licensed under the [MIT License](LICENSE).
