# Sunburst Disk 0.4.7

The **Rust + Tauri v2** macOS disk analyzer with an interactive sunburst.

> The Dock progress bar now works in the installed app, and scanning a folder
> reports progress against that folder instead of against the whole disk.

## Changes since 0.4.6

- **The Dock progress bar appears in the packaged app.** It was added in 0.4.6
  and worked when the app ran from source, but an installed copy never showed it.
  macOS does not give a normally-launched app a content view in its Dock tile —
  it draws the icon itself — so there was nothing to attach the bar to and every
  update quietly did nothing. The app now installs a container view (holding the
  real app icon) the first time it needs one, and then attaches the bar to that.

  If the icon image is not available yet, the app leaves the tile alone and skips
  the bar rather than blanking the icon.

- **Folder scans report honest progress.** Progress inside a folder was divided
  by the *whole volume's* used space, so a two-minute scan of a 2 GB folder on a
  500 GB disk showed about 1% from start to finish — the window bar and the Dock
  bar both looked stuck.

  A folder now uses the size it already measured (a re-scan, a refresh or a
  drill-down) as the total, so the bar tracks the work actually left to do. When
  no size is known yet — the first scan of a folder — the percentage is
  indeterminate: the in-app bar runs an indeterminate sweep and shows a live item
  count instead of a misleading figure, and the Dock shows a small activity sliver.

- Whole-volume scans are unchanged: they still divide by the volume's used bytes,
  which is a real total.

- **Sort & Filter: “Date added”, and an obvious active state.** The sort menu now
  offers *Date added* (an item's creation time) instead of *Date modified*, and
  sorts by it. The funnel icon turns **yellow** as soon as any sort or filter
  differs from the default, so a view that is not showing everything at its
  natural order is visible without opening the panel.

- **The Type list no longer scrolls.** In cloud views the extra availability rows
  pushed half the types out of sight behind a scrollbar; the list now expands to
  show every option at once. Only a genuinely short window makes the panel
  itself scroll.

- **Type-ahead in the content list.** Type the first letters of a name and the
  list jumps to that row, scrolling it into view. A second letter narrows the
  search, and repeating a letter cycles through the names that start with it.
  Escape clears what you typed; text fields keep their normal typing.

- **Consistent scrollbars.** Every scrolling pane now uses the same thin, themed
  scrollbar — grey in Classic, green in Matrix. Previously each pane styled its
  own (or none did), so some fell back to the system's light scrollbar inside a
  dark window, and widths disagreed.

## Downloads

| File | Size | Notes |
|---|---|---|
| `Sunburst Disk_0.4.7_universal.dmg` | ~8.5 MB | macOS 11+, Apple Silicon **and** Intel |
| `Sunburst Disk_universal.app.tar.gz` | ~8.5 MB | the same app bundle, archived |

**One universal build.** Both slices are inside the single DMG; macOS picks the
native one automatically.

## Notes

- **Local scans remain review-only.** Nothing is deleted automatically; cloud
  items still move to the provider's Trash only on explicit, typed confirmation.
- Everything else from 0.4.6 is unchanged — resizable panes, the wider name
  column, the signed bundle and the Full Disk Access hint.
- Licensed under the [MIT License](LICENSE).
