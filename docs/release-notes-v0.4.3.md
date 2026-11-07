# Sunburst Disk 0.4.3

The **Rust + Tauri v2** macOS disk analyzer with an interactive sunburst.

> Predictive typing in the Terminal pane, administrator commands that reach every
> mounted drive, and a reversible “Move & Symlink”.

## Changes since 0.4.2

### Terminal: predictive typing

- **Paths, commands and options are predicted as you type.** The Terminal pane
  now completes paths from the scanned tree, and — for anything outside it, such
  as a destination on another volume — lists that folder on demand. It also
  completes command names and each command’s options.

- **One keyboard-driven list, up to 50 entries.** Directories come first, then
  files by name; ↑/↓ walk the list and keep the highlighted row in view, and the
  inline ghost always previews exactly what will be inserted.
- **→ and ← are cursor navigation again.** Only Tab inserts the highlighted
  prediction, so moving the caret through a line can no longer replace it.
- **The pane scrolls back like a terminal.** Each command’s result is appended
  instead of replacing the last one; the pane stays pinned to the newest line and
  only an explicit `clear` empties it.
- **New “fill the panel” button** beside the close button expands the Terminal
  over the whole content area and restores it again.
- **Names with spaces are inserted quoted.** Completing `My Documents` now yields
  `"My Documents/"`, which the allowlist — like the shell — reads as one argument.
- **Tab inserts the highlighted entry** (not always the first one). Enter still
  runs the command; nothing is ever executed by completing it.
- **Commands are remembered between sessions.** The ↑/↓ command history comes
  back after a restart — command lines only, never output and never a password.
- **Esc now collapses the prediction list** instead of closing the Terminal
  drawer. Press Esc again to close the drawer.
- **⌘Z undoes the last predictive insertion** (or the last typing burst) and
  never touches the filesystem.
- **An empty argument token lists the folder contents and the command’s options**,
  so a destination folder — `mv -- src ` — can be browsed, and `-a`/`-R`/`-h` are
  discoverable without typing a dash.
- **Read-only rule kept.** Completion is a UI aid: the Rust allowlist still
  decides what may run, and the new listing call returns names and entry types
  only — it never reads a file and never materialises a cloud placeholder.

### Terminal: administrator commands

- **Writes are no longer confined to the current folder.** `touch`, `mkdir -p`,
  `rm`, `mv`, `cp -R` and `ln -s` may target any path on a mounted drive;
  protected system paths (`/System`, `/usr`, `/private`, `/Library`, …) and
  arbitrary shell commands stay refused.
- **Refusals say why.** A rejected target is reported as a protected path or as
  outside the mounted drives, not just as a generic allowlist message.
- **A silent success now says so.** `mv`, `cp` and `touch` print nothing when they
  work; the pane reports `✓ done` instead of an empty result that reads like a
  no-op.
- **A write refreshes the open folder.** After a successful command the content
  tree, the sunburst and the prediction list all update immediately, so a moved or
  deleted item disappears (and a new one appears) without pressing Refresh.
- **Fixed: a folder could stay stale while marked “Live”.** When the open folder
  was shown through the data-volume path (`/System/Volumes/Data/Applications`),
  the watcher attached only to that path, but macOS reports those changes through
  the firmlink path (`/Applications/…`), so no events ever arrived: moving or
  deleting a file (for example with the Terminal) left the content tree unchanged
  while the badge still read “Live”. The watcher now follows both presentations of
  the folder.
- **Fixed: a read-only command asked for the administrator password.** With the
  session unlocked, `ls`, `pwd`, `du` and `df` were run through `sudo -n`; once the
  sudo ticket expired they failed with “a password is required”, refused the
  command and dropped Read & Write mode. Read-only helpers now always run as you
  and never touch sudo.
- **Fixed: a write was refused although the pane said Read & Write.** A path with
  an unquoted space (`mv LM Studio.app/ …`) is several arguments to a shell, so it
  did not match any allowed form and only the generic message appeared. The
  refusal now says that such paths must be quoted, and completing a name with a
  space inserts the quotes for you.
- **Fixed: “Administrator authorization expired” loop.** Unlocking validated the
  password with `sudo -S -k -v`, which — since sudo 1.9.10 — checks the password
  but deliberately leaves no cached credential behind, so every command then
  failed with `sudo: a password is required`. Unlocking now establishes a real,
  reusable authorization and verifies it before reporting success.

### Move & Symlink

- **New action in both context menus** — on the sunburst and in the content tree.
  Pick a destination in macOS’s own folder panel: the item is moved there and a
  symlink is left at its old path, so applications, aliases and scripts that still
  use the old location keep working.
- **Nothing happens without confirmation.** The confirmation names the item, the
  destination, and the symlink that will be left behind.
- **Undo is one click.** A short-lived toast after the move offers *Undo*, which
  moves the item back and removes the symlink — and only while that symlink still
  points at the moved item.
- **Safe by construction.** A move never overwrites an existing item in the
  destination, refuses to move a folder inside itself, and stays on mounted drives
  outside the protected system paths. If a location needs administrator rights, an
  unlocked Terminal administrator session is used; otherwise the failure is
  reported with the reason.

## Downloads

**Apple Silicon (arm64) only** — Intel Macs are not supported in this release.

| File | Size | Notes |
|---|---|---|
| `Sunburst.Disk_0.4.3_aarch64.dmg` | ~6 MB | macOS 11+, Apple Silicon (M-series) |
| `Sunburst.Disk_aarch64.app.tar.gz` | ~6 MB | updater artifact for *Check for Updates…* |

## Notes

- **Local scans remain review-only.** Nothing is deleted automatically; cloud
  items still move to the provider’s Trash only on explicit, typed confirmation.
- Application bundles are directories, so moving one with `mv` behaves like any
  other folder. A Finder dialog such as “Unable to Remove Download — Resource
  busy” can appear when a cloud item is still open in another app; close it and
  retry.
- Licensed under the [MIT License](LICENSE).
