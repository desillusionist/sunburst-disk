# Sunburst Disk 0.4.0

The **Rust + Tauri v2** macOS disk analyzer with an interactive sunburst.

> 0.3.10 was an internal build; these notes cover everything since the last public release, 0.3.9.

## Changes since 0.3.9

### See how much of a cloud item is actually on this Mac

A cloud view already showed the size each item takes *in the cloud* (what the provider reports, including items you have not downloaded). It now also shows the bytes actually stored **on this Mac**, so the two are never conflated:

- an **“on this Mac” total** in the pinned summary line at the bottom of the content tree, beside the cloud-size total, and
- a small **on-this-Mac size badge** on every content-tree / legend row that has local bytes.

Availability filters live in Sort & Filter’s **Type** section: **Available Offline** and **Available Online** limit the list to what is stored on this Mac, or to cloud-only items.

> The local figure comes from the same **read-only** filesystem check the scan already makes (on-disk blocks). Nothing is read, downloaded, pinned, or made available offline when you scan a cloud provider.

### Move cloud items to Google Drive Trash — deliberately

A cloud view now has a separate **cloud basket**. Stage items with a row’s **+**, the context menu, or by dragging them onto the basket; review the batch (count and total, and which items are actually downloaded); then choose **Move to Google Drive Trash**.

- **Explicit, typed confirmation.** Nothing is trashed until you type the exact item count:

  > Move N items (X total) to Google Drive Trash? This removes them from Google Drive and every synced device. Recoverable from Google Drive Trash for ~30 days. This does NOT free local disk space. Shared files: items you own are removed for collaborators; items you don’t own may only lose your access.

- **Live progress, cancel and per-item results.** Big batches run sequentially (never thousands of calls at once) with a progress bar and a working **Cancel**. The summary reports each success and any failures with a reason, keeps failed items in the basket for review, and offers a button to open Google Drive Trash.

> **What this does — and does not do.** This is the one place the app changes data in your cloud account: it removes the selected items from the Drive and every synced device (recoverable from Google Drive Trash for ~30 days). It never downloads, pins, or makes anything available offline; it does **not** free local disk space; and it is never automatic. Sunburst Disk cannot “Remove Download” (evict) a cloud item, so that remains a Finder action.

## Highlights

- **Native Rust core.** In-process scanner with `du -x` parity — one filesystem, system junk and cloud FileProvider domains pruned, every physical object counted once (`(st_dev, st_ino)` de-duplication).
- **Interactive sunburst + matching content tree**, with a details inspector, Quick Look, Reveal in Finder, Open With and a read-only archive viewer.
- **Review-first by design.** Local content is never deleted automatically; removal goes to the macOS Trash and protected system paths are refused.
- **Cloud Storage**: the informational per-provider panel, the read-only Scan → sunburst + tree with “on this Mac” figures and availability filters, and the new cloud basket → Google Drive Trash.
- **Smart Clean preview** across Safe / Moderate / High tiers, each candidate with a reason, a verification note and an age.
- **In-app updates**: *Check for Updates…* downloads the new release, opens it in Finder and skips Gatekeeper.
- **Hidden Space diagnostics**: purgeable space, local APFS snapshots and the remaining protected-space difference.

## Downloads

**Apple Silicon (arm64) only** — Intel Macs are not supported in this release.

| File | Size | Notes |
|---|---|---|
| `Sunburst.Disk_0.4.0_aarch64.dmg` | ~6 MB | macOS 11+, Apple Silicon (M-series) |
| `Sunburst.Disk_aarch64.app.tar.gz` | ~6 MB | updater artifact for *Check for Updates…* |

## Install

1. Download and open the `.dmg`.
2. Drag **Sunburst Disk** into *Applications*.

> Updating from 0.3.9? Use *Check for Updates…* in the app menu — the image is not quarantined and opens directly. If you download through a browser, right-click the app → **Open**, or run `xattr -dr com.apple.quarantine "/Applications/Sunburst Disk.app"`.

For **Hidden Space** and the integrated **Terminal**, grant Full Disk Access in *System Settings → Privacy & Security → Full Disk Access*.

## Notes

- **Apple Silicon (arm64) only.** Intel is not supported yet.
- Local writes are limited to the macOS Trash and the opt-in, password-scoped admin Terminal mode. Cloud writes are limited to moving a reviewed batch to the provider's Trash, on typed confirmation.
- Cloud figures are approximate by nature: a provider lists only what macOS has browsed, and the top-level provider scan is time-bounded. A folder you open is measured under a generous cap, with an exact walk offered if the cap binds.

Licensed under the [MIT License](LICENSE).
