# Sunburst Disk 0.4.1

The **Rust + Tauri v2** macOS disk analyzer with an interactive sunburst.

> A small follow-up to 0.4.0.

## Changes since 0.4.0

- **Every cloud-trash label now follows the provider you are viewing.** The basket
  button, the confirmation title, body and button, the success message, the
  recovery note, the empty state, the legend `+` and the context menu all derive
  from the detected provider through one helper — so none can fall back to a
  hard-coded “Google Drive”.
- **Recovery wording matches where the item actually goes.** For Google Drive the
  app says “Google Drive Trash” and offers an “Open Google Drive Trash” button; for
  iCloud Drive it says “Recently Deleted” — recoverable in the Files app or at
  iCloud.com — with no button, because iCloud has no Trash page.
- **“Open Google Drive Trash” opens the account you scanned.** It targets
  `https://drive.google.com/drive/trash?authuser=<account>` for the provider being
  viewed (derived from the `GoogleDrive-<email>` folder), so it always lands on the
  right Drive and survives adding or removing accounts.
- **⌘Z un-stages basket items.** You can undo the last add or remove in the cloud
  basket before anything is trashed. This is a local list undo only — it can never
  trigger a trash or a restore.
- **A note on the Cloud Storage panel** now clarifies that it lists system cloud
  mirrors (macOS File Provider) only, and that a sync folder in a custom location
  (for example Dropbox on an external drive) should be scanned as a regular folder.

## Downloads

**Apple Silicon (arm64) only** — Intel Macs are not supported in this release.

| File | Size | Notes |
|---|---|---|
| `Sunburst.Disk_0.4.1_aarch64.dmg` | ~6 MB | macOS 11+, Apple Silicon (M-series) |
| `Sunburst.Disk_aarch64.app.tar.gz` | ~6 MB | updater artifact for *Check for Updates…* |

## Notes

- **Apple Silicon (arm64) only.** The rest of 0.4.0 is unchanged.
- Recovery of a trashed cloud item is via the provider — Google Drive Trash, or
  iCloud’s “Recently Deleted” — for about 30 days. There is no in-app un-trash yet;
  restoring an item from the provider is under review.

Licensed under the [MIT License](LICENSE).
