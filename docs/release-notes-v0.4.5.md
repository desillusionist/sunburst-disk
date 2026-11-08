# Sunburst Disk 0.4.5

The **Rust + Tauri v2** macOS disk analyzer with an interactive sunburst.

> A layout release: every pane can be resized, names use the full width, and the
> permissions prompt is dealt with once instead of every scan.

## Changes since 0.4.4

### Layout

- **Draggable panes.** The borders between the sunburst, the file list and the
  inspector are now draggable — drag them, or focus one and use ←/→. The chart
  keeps 25–78% of the space and the inspector 220–620 px, so neither can be
  squeezed out of existence. Clicking *Details* off and on restores the default
  split.
- **Names use the full width.** A file name was capped at a fixed width, which
  left a wide empty gap before the size column on a large window. Names now take
  whatever the size column does not need and only truncate when the list is
  genuinely narrow, with a little extra space before the size.

### Permissions

- **The bundle is now code-signed.** It used to be linker-signed only, which gave
  the app an identifier that changed with every build — so macOS had no stable
  record for “allow access to Downloads” and asked again. With the signed bundle
  the identifier is stable (`com.sunburstdisk.app`) and the answer sticks.
- **A Full Disk Access hint.** When the app can tell that access is missing, the
  scan screen shows one dismissible line explaining that macOS asks per protected
  folder (Downloads, Desktop, Documents), with a button that opens the Full Disk
  Access pane directly. Granting it once is what lets a full-disk scan finish
  without interruptions.

> Notarization is not possible without an Apple Developer ID, so this is ad-hoc
> signing: it stabilises the app's identity, but the first launch of a new build
> may still draw a single permission prompt. Run the app from *Applications*, not
> from the mounted DMG, so macOS always sees the same app.

## Downloads

| File | Size | Notes |
|---|---|---|
| `Sunburst.Disk_0.4.5_universal.dmg` | ~8.5 MB | macOS 11+, Apple Silicon **and** Intel |
| `Sunburst.Disk_universal.app.tar.gz` | ~8.5 MB | the same app bundle, archived |

**One universal build.** Both slices are inside the single DMG; macOS picks the
native one automatically.

## Notes

- **Local scans remain review-only.** Nothing is deleted automatically; cloud
  items still move to the provider's Trash only on explicit, typed confirmation.
- Everything else from 0.4.4 is unchanged, including the Terminal, Move & Symlink
  and the cloud container.
- Licensed under the [MIT License](LICENSE).
