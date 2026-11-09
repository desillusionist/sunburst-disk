# Sunburst Disk 0.4.6

The **Rust + Tauri v2** macOS disk analyzer with an interactive sunburst.

> The Dock now shows the scan: a slim progress bar along the bottom of the app
> icon, moving with the scan and gone when it finishes.

## Changes since 0.4.5

- **Scan progress on the Dock icon.** While a scan runs, a small bar fills along
  the bottom of Sunburst Disk's Dock icon, following the same percentage the
  in-app panel shows. It is visible even when the window is behind another app,
  and it clears the moment the scan finishes, is cancelled or fails.

  It is throttled (one update per 200 ms, and only when the value moves by 2% or
  more) so it costs nothing measurable during a large scan.

- **The bar follows the theme.** In the default *Classic* theme it uses the
  system accent colour, so it looks native and matches whatever accent colour you
  have set in System Settings. In the *Matrix* theme it is drawn in the theme's
  green, and switching themes mid-scan recolours it immediately.

## Downloads

| File | Size | Notes |
|---|---|---|
| `Sunburst.Disk_0.4.6_universal.dmg` | ~8.5 MB | macOS 11+, Apple Silicon **and** Intel |
| `Sunburst.Disk_universal.app.tar.gz` | ~8.5 MB | the same app bundle, archived |

**One universal build.** Both slices are inside the single DMG; macOS picks the
native one automatically.

## Notes

- **Local scans remain review-only.** Nothing is deleted automatically; cloud
  items still move to the provider's Trash only on explicit, typed confirmation.
- Everything else from 0.4.5 is unchanged — resizable panes, the wider name
  column, the signed bundle and the Full Disk Access hint.
- Licensed under the [MIT License](LICENSE).
