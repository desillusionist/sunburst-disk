# Sunburst Disk 0.3.8

The **Rust + Tauri v2** macOS disk analyzer with an interactive sunburst.

## Changes since 0.3.7

- **New: explore a cloud drive before you open Finder.** The **Cloud Storage**
  panel now has a **Scan** action for every provider (Google Drive, Dropbox,
  OneDrive, iCloud Drive, …). It opens that provider as a **read-only** sunburst
  and content tree, so you can see how the drive is laid out and where its space
  goes.
  - **Logical size.** Cloud views measure the size a file takes *in the cloud* —
    including items you have **not** downloaded — not the space it uses on this Mac.
    macOS reports a placeholder's full size without fetching it, so the chart
    reflects the whole drive, not just the files already on this Mac. The banner and
    the legend's *cloud content (not on-disk)* row label it as such.
  - **Nothing is downloaded or deleted, ever.** The walk only lists directories and
    reads metadata; it never opens a file, so browsing a cloud drive cannot pull
    your data over the network. Every item in a cloud view is marked read-only, and
    the collector, Smart Clean and deletion are disabled while you are in one.
  - **Honest about partial results.** Streaming providers list slowly, so the
    top-level snapshot is **bounded** and stops at a time limit; it says so in the
    banner and marks the sizes as lower bounds. A folder's size is always the
    **sum of its contents** (never a directory's own inode size), and a folder that
    was not fully scanned shows **≥** its size — or *partial* when it has not been
    loaded at all.
  - **Opening a folder fills in its sizes.** A folder is walked under a generous
    cap, so most folders show real sizes at once (no **≥**). If a folder is too big
    to finish, it stays a lower bound and a **Calculate exact size** button appears
    for that folder — the Finder *Get Info* equivalent — which walks it completely,
    with a live item count and a Cancel button. A routine folder open never starts
    a runaway walk. iCloud Drive is fast and usually complete; Google Drive is the
    slow case.
- The read-only cloud banner, an indeterminate progress bar with a running item
  count, and a cancel button make a cloud scan always finish or stop on request.

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
- **Cloud Storage panel**: cloud-versus-local footprint per provider, the local
  space the cloud clients keep, and (new) a read-only cloud tree.
- **In-app updates**: *Check for Updates…* in the app menu downloads the new
  release itself, opens it in Finder and skips Gatekeeper.
- **Hidden Space diagnostics**: purgeable space, local APFS snapshots and the
  remaining protected-space difference.

## Downloads

**Apple Silicon (arm64) only** — Intel Macs are not supported in this release.

| File | Size | Notes |
|---|---|---|
| `Sunburst Disk_0.3.8_aarch64.dmg` | ~6 MB | macOS 11+, Apple Silicon (M-series) |
| `Sunburst Disk.app` | ~8.7 MB | same build, unpacked |

Requirements: **macOS 11 or later on Apple Silicon (arm64)**.

## Install

1. Download and open the `.dmg`.
2. Drag **Sunburst Disk** into *Applications*.

> Updating from 0.3.7? Use *Check for Updates…* in the app menu — the image is not
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
- Cloud figures are approximate: a provider lists only what macOS has browsed, and
  a cloud scan is time-bounded, so treat its sizes as a snapshot rather than an
  exact total.

## Documentation

- `docs/electron-to-tauri-migration.md` — architecture and Electron→Tauri parity notes.
- `README.md` — features, build instructions and project layout.

Licensed under the [MIT License](LICENSE).
