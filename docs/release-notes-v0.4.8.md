# Sunburst Disk 0.4.8

The **Rust + Tauri v2** macOS disk analyzer with an interactive sunburst.

> Two new skins join Classic and Matrix: an amber phosphor CRT and a green
> handheld LCD, both adapted from the retro-futuristic hardware reference.

## Changes since 0.4.7

- **Amber CRT.** An amber phosphor terminal: a warm near-black screen, amber
  text with a soft glow, amber chart and borders, faint horizontal scanlines and
  a gentle vignette toward the edges. The sunburst, the file-list dots and the
  Dock progress bar all use the same amber accent.

- **LCD Green.** A handheld LCD panel: a yellow-green readout on dark olive with
  a fine pixel grid, tinted borders and the same monochrome behaviour — one
  accent colour for every slice, row marker and the Dock bar.

- **Four skins in the Theme menu.** The menu now lists Classic, Matrix, Amber CRT
  and LCD Green with a colour swatch each, and remembers your choice between
  launches. Classic (full colour on slate) and Matrix (green phosphor) are
  unchanged — the themes share one registry, so a switch repaints the chart,
  the Dock bar and the chrome together.

- The two retro skins are dark on purpose: every existing surface stays legible,
  including the details inspector, Sort & Filter, the terminal and the dialogs.

## Downloads

| File | Size | Notes |
|---|---|---|
| `Sunburst.Disk_0.4.8_universal.dmg` | ~8.5 MB | macOS 11+, Apple Silicon **and** Intel |
| `Sunburst.Disk_universal.app.tar.gz` | ~8.5 MB | the same app bundle, archived |

**One universal build.** Both slices are inside the single DMG; macOS picks the
native one automatically.

## Notes

- **Local scans remain review-only.** Nothing is deleted automatically; cloud
  items still move to the provider's Trash only on explicit, typed confirmation.
- Everything else from 0.4.7 is unchanged — the working Dock bar, honest folder
  progress, Date added sorting, the yellow Sort & Filter signal, the Type list
  without a scrollbar, type-ahead and the themed scrollbars.
- Licensed under the [MIT License](LICENSE).
