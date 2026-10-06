# Electron → Tauri (Rust) migration

Option A from the feasibility review: keep the React renderer, replace the
Electron main process with a Rust core hosted by Tauri v2. The renderer keeps
calling `window.electronAPI.*`; `src/tauri-bridge.js` installs that object on
top of Tauri's `invoke`/`listen`, so `App.jsx` and the components are unchanged.

```
React renderer ──► window.electronAPI (src/tauri-bridge.js)
                        │
                        ▼
        Tauri commands (src-tauri/src/commands.rs)
                        │
                        ▼
     Rust core (scan.rs, capacity.rs, drives.rs) ──► macOS CLI + Swift helpers
```

## Layout

| Path | Purpose |
|---|---|
| `src-tauri/Cargo.toml` | Crate manifest, Tauri v2 + `walkdir`/`libc` |
| `src-tauri/tauri.conf.json` | Window, dev server (`:3000`), bundling |
| `src-tauri/capabilities/default.json` | Core window/event permissions |
| `src-tauri/src/commands.rs` | All `#[tauri::command]` handlers |
| `src-tauri/src/scan.rs` | In-process directory walker + tree builder |
| `src-tauri/src/capacity.rs` | `statfs` + `df`/`diskutil` capacity reads |
| `src-tauri/src/drives.rs` | Mounted-volume discovery |
| `src-tauri/src/types.rs` | Wire types (JSON shapes match the renderer) |
| `src/tauri-bridge.js` | `window.electronAPI` → Tauri `invoke`/`listen` |

The Electron app is untouched and still the default (`npm run electron:dev`).

## Running

```bash
npm install                    # picks up @tauri-apps/cli
npm run tauri:dev              # Vite on :3000 + Rust core
npm run tauri:build            # DMG + .app
```

Rust-only checks (no webview needed):

```bash
npm run rust:test        # fast: cargo test --lib
npm run rust:lint        # fast: clippy --lib --bins, warnings are errors
npm run rust:test:all    # full: also bins + doctests (doctest harness disabled)
npm run rust:lint:all    # full: --all-targets
```

Note: `cargo clippy` builds dependencies in check (metadata-only) mode while
`cargo test` needs codegen, so alternating them rebuilds the dependency graph.
`npm run rust:test` is the recommended single quick pass; run `rust:lint` when
you want lint review. To make switching cheap, install `sccache`
(`cargo install sccache`) and `export RUSTC_WRAPPER=sccache`.

## Command status

| # | IPC channel | Tauri command | Status |
|---|---|---|---|
| 1 | `get-drives` | `get_drives` | ✅ migrated |
| 2 | `get-capacity-snapshot` | `get_capacity_snapshot` | ✅ migrated |
| 3 | `set-window-layout` | `set_window_layout` | ✅ migrated |
| 4 | `scan-directory` | `scan_directory` | ✅ migrated |
| 5 | `cancel-scan` | `cancel_scan` | ✅ migrated |
| 6 | `scan-subdir` | `scan_subdir` | ✅ migrated |
| 7 | `choose-folder` | `choose_folder` | ✅ migrated (`tauri-plugin-dialog`) |
| 8 | `smart-clean-preview` | `smart_clean_preview` | ✅ migrated |
| 9 | `notify-scan-complete` | `notify_scan_complete` | ✅ migrated (`tauri-plugin-notification`) |
| 10 | `scan-archive` | `scan_archive` | ✅ migrated (in-process zip + `bsdtar`) |
| 11 | `watch-current-folder` | `watch_current_folder` | ✅ migrated (`notify`/FSEvents) |
| 12 | `delete-items` | `delete_items` | ✅ migrated (`trash` crate) |
| 13 | `reveal-in-finder` | `reveal_in_finder` | ✅ migrated (`open -R`) |
| 14 | `finder-get-info` | `finder_get_info` | ✅ migrated |
| 15 | `get-open-with-apps` | `get_open_with_apps` | ✅ migrated (objc2 `NSWorkspace`) |
| 16 | `open-with-application` | `open_with_application` | ✅ migrated |
| 17 | `choose-other-application` | `choose_other_application` | ✅ migrated (`tauri-plugin-dialog`) |
| 18 | `eject-drive` | `eject_drive` | ✅ migrated |
| 19 | `show-context-menu` | — | ␀ removed from bridge (renderer never calls it) |
| 20 | `setup-ask-siri` | `setup_ask_siri` | ✅ migrated (`/usr/bin/shortcuts`) |
| 21 | `ask-siri` | `ask_siri` | ✅ migrated |
| 22 | `ask-siri-transform` | `ask_siri_transform` | ✅ migrated |
| 23 | `inspect-item` | `inspect_item` | ✅ migrated |
| 24 | `inspect-items` | `inspect_items` | ✅ migrated |
| 25 | `inspect-app-related` | `inspect_app_related` | ✅ migrated |
| 26 | `terminal-authorize-admin` | `terminal_authorize_admin` | ✅ migrated (`sudo -S -k -v`) |
| 27 | `terminal-revoke-admin` | `terminal_revoke_admin` | ✅ migrated |
| 28 | `hidden-space-authorize` | `hidden_space_authorize` | ✅ migrated |
| 29 | `hidden-space-revoke` | `hidden_space_revoke` | ✅ migrated |
| 30 | `terminal-run-safe` | `terminal_run_safe` | ✅ migrated (allowlist + `sudo -n`) |
| 31 | `quick-look` | `quick_look` | ✅ migrated (bundled Swift helper) |
| 32 | `quick-look-close` | `quick_look_close` | ✅ migrated |
| 33 | `scan-hidden-space` | `scan_hidden_space` | ✅ migrated |
| 34 | `open-full-disk-access-settings` | `open_full_disk_access_settings` | ✅ migrated |
| 35 | `open-system-settings` | `open_system_settings` | ✅ migrated |
| 36 | `save-text-file` | `save_text_file` | ✅ migrated (`tauri-plugin-dialog`) |
| 37 | `get-permission-status` | `get_permission_status` | ✅ migrated |

Events (backend → renderer): `scan-progress` ✅, `scan-complete` ✅,
`folder-watch-change` ✅, `folder-watch-status` ✅ and `quick-look-key` ✅
(emitted by `quick_look` from the helper's stdout and on panel close) are wired in
the bridge. `ask-siri-start`, `ask-siri-result`, `add-to-collector-request` and
`toggle-package-contents-request` remain *subscribed but never emitted*: Electron
only fired them from its **native** context-menu / Ask Siri menu handlers, and the
Tauri renderer performs those same actions from its own in-app menu, so nothing
consumes them.

## Known parity deltas (scanner)

The Rust walker aims to reproduce `du -ak -x` + `buildTreeFromDu`, but a few
behaviours are intentionally different or still to verify:

1. **Junk subtrees are pruned, not just hidden.** Electron dropped `.Trash`,
   `.fseventsd`, etc. *rows* but their bytes were still inside the parent's
   `du` cumulative. Rust excludes them entirely, so a parent's size can be
   slightly smaller. This matches the README's stated intent ("excludes system
   junk") but is not byte-identical to the old numbers.
2. **Block-unit rounding.** Sizes come from `st_blocks * 512`. `du -ak` reports
   rounded 1024-byte units, so individual nodes can differ by <1 KB even when
   totals agree.
3. **Startup-volume `System` split is ported.** The startup scan walks
   `/System` once (the firmlink presents the whole Data volume there) and
   `split_startup_system` promotes `/System/Volumes/Data` to the root and
   appends the sealed OS-volume remainder (`/System` minus `/System/Volumes`)
   as a sibling child. The remainder is **displayed as `System (OS volume)`**
   (path unchanged: `/System`) so it is not ambiguous next to the writable Data
   volume's own `System` directory (`/System/Volumes/Data/System`). Electron
   showed both rows under the name `System`; this label is the only display
   deviation, chosen to resolve the two-`System`-rows confusion. Measured:
   ~42 s, 1.21M items for the full `/System` walk.
4. **Progress percent** is estimated from bytes indexed vs `statfs` used space,
   rather than `du`'s streamed directory rows.
5. **`.DS_Store`** is pruned as a junk *prefix*, same as Electron, which also
   meant it pruned any sibling whose name starts with `.DS_Store`.
6. **Cloud FileProvider domains are pruned.** `~/Library/CloudStorage` (Google
   Drive, etc.) and `~/Library/Mobile Documents` (iCloud Drive) are excluded
   like `SKIP_NAMES`. Electron's `du -ak -x /System` pass walked into them, which
   was fine while they were small but makes a full-disk scan appear to hang once
   a provider holds a large mirror: a single Google Drive domain here enumerates
   hundreds of thousands of *dataless* (0-byte) placeholder stubs through
   `fileproviderd`. These entries are not local disk usage, so leaving the walk
   both is faster and more truthful. A scan whose *root* lies inside such a
   domain is refused with an explicit message rather than walked. Measured
   effect: the startup-volume walk now finishes in ~32 s (was a >150 s timeout).

   **Accuracy caveat (documented decision, not a bug):** pruning these domains
   also excludes any *materialized* cloud files -- the ones the user explicitly
   downloaded / "Keep on this device" -- which do occupy real local bytes. A
   per-entry dataless check (`NSURLIsUbiquitousItemKey`/`isUbiquitousItem`) is not
   viable here because directory enumeration itself is the expensive operation,
   not the per-entry metadata read. The under-reporting is an intentional
   tradeoff; the excluded bytes still appear in the startup `hidden space...`
   reconciliation.
7. **The walk does not cross filesystem boundaries (`du -x` parity).** The device
   id (`st_dev`) of the scan root is recorded and any *directory* on a different
   device is pruned (files on another device are still counted). This is what
   keeps the walker out of other volumes and off network mounts (SMB/NFS under
   `/Volumes/*`), where enumeration is remote and can hang like the cloud
   domains. Pruned domains and pruned mount points are handled the same way and
   are not reported individually; their bytes surface through the startup
   `hidden space...` node.

   **macOS `st_dev` caveat (verified on this machine).** The sealed System volume
   (`/`) and the firmlinked Data volume (`/System/Volumes/Data`) report the *same*
   `st_dev` (16777231) -- they are the synthesized root pair of one APFS
   container -- even though `df` shows them as distinct volumes (`disk3s1s1` vs
   `disk3s5`). So `-x`/this guard does **not** separate System from Data: `du -x
   /` crosses into Data (measured: still running past 70 s, then stuck on the
   cloud mirror), and the startup walk rooted at `/System` likewise includes the
   whole Data tree (measured: 1.21M items, split root `/System/Volumes/Data`).
   The guard separates only *other* devices (e.g. external/`/Volumes` mounts,
   whose devs do differ). No code path roots a scan at `/` regardless: the startup
   drive always maps to `/System`, and custom-folder/subdir scans use an explicit
   path. The ignored `startup_split_probe` doubles as a regression canary -- if
   the guard ever pruned Data, the split would fall back to `/System` and the
   probe's `assert_eq!(root.path, "/System/Volumes/Data")` would fail.
8. **Firmlinks and hardlinks are counted once (`du` parity).** The walk tracks
   `(st_dev, st_ino)` for directories and multiply-linked files (`st_nlink > 1`),
   so a firmlinked directory -- reachable at the same inode under `/System/...`
   and `/System/Volumes/Data/System/...` (e.g. `AssetsV2`, `Assets`, `Caches`,
   `Speech`) -- and hardlinked files are not double-counted. Attribution is made
   deterministic rather than readdir-order dependent: the walk visits
   `/System/Volumes` before its siblings, so the firmlinked inodes are claimed by
   the Data tree and the `System (OS volume)` row stays sealed-volume-only. Only
   directories and multiply-linked files are tracked, so memory stays bounded.
   Verified: `/System/Library` now matches `du -sk` byte-for-byte, and `AssetsV2`
   no longer appears under both trees.

## FSEvents watcher parity

`notify` maps raw FSEvents flags to an `EventKind` and does **not** expose
`kFSEventStreamEventFlagMustScanSubDirs` or the dropped/user-dropped flags that
Electron's Swift helper read. Consequently:

- Recovery (full-scan) is triggered by `EventKind::Any`/`Other` instead of the
  dropped/`mustScanSubDirs` flags. If macOS coalesces silently, notify's
  `Any`/`Other` is the signal we get.
- `rootChanged` is never set from a flag; instead the flush checks whether the
  watched path still exists (`rootMissing`) and detects renames by
  device:inode identity, which is flag-independent and matches Electron.
- Access/metadata events are ignored, preserving the "no blinking on metadata
  churn" behaviour.

The debounce window (450 ms), changed-path mapping between firmlink and Data
volume forms, the 256-path cap and the payload shape are unchanged.

## Archive viewer parity

- Virtual paths use the same `archive://<encodeURIComponent>?entry=...` scheme,
  and entries carry `archiveVirtual`, `archivePath`, `archiveEntry`.
- `.zip` is tried in-process first, then `bsdtar`; other formats go straight to
  `bsdtar -tvf` with a `bsdtar -tf` names-only fallback.
- **Intentional improvement:** Electron computed `itemCount` in map-iteration
  order (parents before children), which under-counts nested directories. The
  Rust builder accumulates counts bottom-up, so a directory's "Objects inside"
  reflects its full descendant count. Sizes and ordering match.
- Unlike Electron, `bsdtar` output is size-capped but not wall-clock timed out
  (std has no portable child timeout); a hung `bsdtar` would block that one
  request thread.

## Smart Clean parity

- Root definitions, entry-matching rules (cache/log/screenshot/installer/
  incomplete/large-download/trash/folder modes), safety limits (120 entries/root,
  300 candidates, 400 duplicate files) and the note strings are unchanged.
- Duplicate detection uses a SHA-256 sample (first + last 64 KB) like Electron,
  but hashes **sequentially** rather than with 3-way concurrency; entry
  measurement is likewise sequential. Results are identical, just less parallel.
- Duplicate candidates carry `categoryId: "duplicates"` (Electron left it
  `undefined`), so the renderer's category filter can actually select them.
- `modifiedAt` is an ISO-8601 UTC string produced by a built-in civil-date
  conversion (no date crate).

## Quick Look

The native `electron/quicklook-preview` Swift helper is bundled via
`bundle.resources` and located at runtime through a candidate search
(`_up_/electron/…`, `electron/…`, the resource root, and the in-tree dev path).
The helper is spawned per preview; JSON key lines from its stdout are forwarded
as `quick-look-key` events, and the child is SIGTERM'd on close/replace.
Run `npm run build:quicklook` before `tauri build`/`tauri dev` so the binary
exists, otherwise `quick_look` returns “Native Quick Look helper is not built.”

## Ask Siri

`setup-ask-siri` / `ask-siri` / `ask-siri-transform` use `/usr/bin/shortcuts`
(list + background `run` with a real `--output-path`), and emit
`ask-siri-start` / `ask-siri-result`.

**Delta:** Electron's `setupAskSiriShortcut` checked the *return value* of
`shell.openExternal`, which resolves `void`, so its success branch was
unreachable. The Rust version returns `{ ok:true, opened:true, setupRequired:true }`
when `/usr/bin/open` exits 0, which is the intended behaviour the renderer
expects.

- **r13** — Fixes and hardening:
  - **Scanner rewritten path-free.** The walker no longer stores a `PathBuf`
    plus a `HashMap<PathBuf, usize>` per entry; parents come from a depth
    stack and paths are built only for materialised nodes. Memory per full-disk
    scan drops from potentially gigabytes to a compact record. Measured on
    `/System/Library` (425k entries): **9.2 s vs `du`'s 12.1 s**.
  - **Eject detection fixed.** `is_ejectable_mount_info` matched single spaces,
    but `diskutil info` aligns with multiple spaces; it now uses the Electron
    `\s+` regexes. External drives show `Eject “…”` again.
  - **`/Volumes/Recovery` hidden** from the Home list (system-managed recoveryOS
    volume; a deliberate deviation from Electron, which listed it).
  - **`show-context-menu`** stub removed from the bridge: nothing calls it.
  - **Scan progress note:** the percent bar caps near the visible/used ratio
    (often ~35%) because most of the system disk is hidden space that the walk
    cannot index; it jumps to “Finalizing”/100% when the walk completes. This
    matches Electron.

## Next steps

The IPC command surface is complete (see the Command status table above).
Everything that remains is optional:

1. **Quick Look helper.** Still the bundled Swift `quicklook-preview` resource.
   An `objc2` `QLPreviewPanel` port is possible but not required. (The
   `fsevents-watcher` and `openwith-applications` helpers are already superseded
   by `notify` and `objc2` and are no longer bundled.)
2. **Native `show-context-menu`** -- Electron-parity only. The renderer draws its
   own menu and never calls it, so this is not needed for the app to work.
3. **Bundle identifier.** `com.sunburstdisk.app` ends with `.app`; Tauri warns
   that this can conflict with the macOS application-bundle extension. Changing
   it resets the app's TCC grants (Full Disk Access, notifications), so it is
   deferred.

## Revision history

- **r2** — Added `choose_folder` (dialog plugin) and `delete_items` (`trash`
  crate with the Electron path/protected-system guards). Commands: 8 migrated.
- **r3** — Added `inspect_item` / `inspect_items` (file classification, `mdls`
  media probe, permissions/access/birthtime), parallelised across threads.
  Commands: 10 migrated. `inspect_app_related` still pending.
- **r4** — Added `reveal_in_finder` (`open -R`, no new dependency) and
  `inspect_app_related` (`~/Library` resource discovery for `.app` bundles).
  Commands: 12 migrated.
- **r5** — Added `get_open_with_apps` (objc2 `NSWorkspace`, replacing the Swift
  helper), `open_with_application`, `choose_other_application`,
  `finder_get_info`. Commands: 16 migrated. `show-context-menu` left pending
  because the renderer draws its own menu and never calls it.
- **r6** — Added `watch_current_folder` using the `notify` crate (FSEvents on
  macOS), replacing the Swift `fsevents-watcher` helper. Commands: 17 migrated.
  See the watcher parity note below.
- **r7** — Added `scan_archive`: in-process ZIP central-directory parser
  (UTF-8 flag + Info-ZIP Unicode Path extra field) with a `bsdtar -tvf` →
  `bsdtar -tf` fallback for other formats. Commands: 18 migrated.
- **r8** — Added `notify_scan_complete` (`tauri-plugin-notification`): system
  notification + `scan-complete` renderer event. Commands: 19 migrated.
  Dock-bounce/beep are not ported (the notification sound covers the alert).
- **r9** — Utility batch: `get_permission_status`, `open_system_settings`,
  `save_text_file` (dialog plugin), `eject_drive` (`diskutil eject` with the
  external/ejectable guard). Commands: 23 migrated.
- **r11** — Added `scan_hidden_space` (diagnostic candidates + purgeable +
  remainder rows) and `smart_clean_preview` (roots, entry rules, duplicate
  detection via sampled SHA-256). Commands: 31 migrated. See the Smart Clean
  parity note below.
- **r12** — Added the Ask Siri bridge (`setup_ask_siri`, `ask_siri`,
  `ask_siri_transform`) and Quick Look (`quick_look`, `quick_look_close`) with
  the Swift helper bundled as a resource. Commands: 37 migrated; only the
  unused `show-context-menu` remains pending.
- **r14** — Fixed the system-disk scan hang. Root cause: cloud FileProvider
  domains (`~/Library/CloudStorage`, `~/Library/Mobile Documents`) mirror huge
  numbers of dataless placeholder files, so walking them dominated the scan and
  left it sitting at ~35% (the cosmetic `statfs` cap) indefinitely. The walker
  now prunes those domains like `SKIP_NAMES`, and refuses an explicit scan
  rooted inside one instead of appearing to hang. Startup-volume scan:
  **~32 s, 767k items** (was >150 s / not finishing). Two `scan` unit tests
  added; see parity delta 6.
- **r15** — Ported the startup-volume `/System` split (parity delta 3). The
  startup scan now walks `/System` once and `split_startup_system` promotes the
  Data volume to the root while appending the sealed OS-volume remainder as a
  distinct child, so the chart shows both System folders again instead of
  folding the OS volume into `hidden space...`. The remainder is labelled
  `System (OS volume)` (path stays `/System`) to disambiguate it from the Data
  volume's `System`. Full `/System` walk: **~42 s, 1.21M items**; Data `System`
  <redacted-size> and OS volume <redacted-size>, within rounding of the Electron numbers.
  Unit tests: `startup_split_promotes_data_and_keeps_os_remainder`,
  `startup_split_without_volumes_is_a_noop`, plus `startup_split_probe` (ignored).
- **r16** — UI + scan hardening:
  - **Window drag fixed.** The `data-tauri-drag-region` attribute alone was not
    enough: the Tauri window plugin's `start_dragging` invoke was denied because
    `capabilities/default.json` lacked `core:window:allow-start-dragging` (and
    `…allow-internal-toggle-maximize` for double-click). Added both, and widened
    the drag surface by marking only the interactive breadcrumb pills
    `data-tauri-drag-region="false"` (the rest of the top header band drags).
  - **Drive dropdown** now shows `View saved scan` / `Scan again` only after a
    prior scan; the menu itself is omitted when it would be empty.
  - **Device-boundary guard** extracted to `crosses_device_boundary` (`du -x`
    parity) and unit-tested; see parity delta 7.
- **r17** — Verification + docs (no behaviour change). Confirmed on this machine
  that `/`, `/System` and `/System/Volumes/Data` share one `st_dev` (APFS
  synthesized root pair), so the device guard neither prunes Data from the
  `/System` startup walk nor would from a `/`-rooted one (`du -x /` crosses into
  Data too). Audited that no code path roots a scan at `/`. Corrected the stale
  docs: `quick-look-key` *is* emitted (the other four legacy event names are
  replaced by the renderer's own menu), rewrote the "Next steps" list, and
  documented the `st_dev` finding in code and parity delta 7.
- **r18** — Cleanup + release:
  - **Belt-and-braces guard.** `ScanOptions.protected_roots` marks directories
    that must never be pruned by the `st_dev` guard; the startup walk protects
    `/System/Volumes/Data`, so the Data volume is walked even on a hypothetical
    macOS build that reports it on a distinct device. New
    `should_prune_dir` predicate + unit tests.
  - **Removed dead Electron-era files:** `electron/main.js`, `electron/preload.cjs`,
    the `fsevents-watcher` and `openwith-applications` helpers (binary + Swift
    source), and `installer/`. Kept `electron/quicklook-preview{,.swift}` because
    the binary is still a bundled Tauri resource.
  - **`package.json` pruned:** dropped the `main` field, the Electron
    scripts/`pkg` block, and the `electron`, `electron-builder`, `concurrently`,
    `wait-on`, `next` dependencies (328 packages removed from the install).
  - **README** rewritten for the Tauri/Rust architecture (`tauri:dev`,
    `tauri:build`, `rust:*`), new structure tree.
  - **Release built:** `Sunburst Disk.app` (7.48 MiB) and
    `Sunburst Disk_0.3.0_aarch64.dmg` (7.42 MiB).
- **r19** — Icon + drag-drop:
  - **macOS 26 icon.** Vendored the Icon Composer bundle
    (`src-tauri/icons/Sunburst Disk.icon`) and added `scripts/build-icon.sh` /
    `npm run build:icon` to compile it with `actool` into `Assets.car` (carrying
    the `NSAppearanceNameAqua` / `NSAppearanceNameDarkAqua` / `ISAppearanceTintable`
    appearances) plus a fallback `icon.icns`. `tauri.conf.json` copies
    `Assets.car` into `Contents/Resources` via `bundle.macOS.files`, and
    `src-tauri/Info.plist` supplies `CFBundleIconName`, so macOS 26+ uses the
    asset-catalog icon (light/dark/tinted) while older macOS falls back to
    `icon.icns`. Verified with `xcrun assetutil --info`. App size 7.48 → 8.59 MiB.
  - **Collector drag-and-drop fixed.** Tauri replaces the webview drag-drop
    handler (`dragDropEnabled` defaults to `true`), which swallowed the HTML5
    drag events, so chart/tree drags never reached the Collector. Set
    `app.windows[0].dragDropEnabled = false`. The `[+]` buttons were unaffected
    because they don't use DnD.
- **r20** — Firmlink / hardlink double-count fix (Option B: keep the two-System
  model). Added a `(st_dev, st_ino)` `Visited` set (directories + `nlink > 1`
  files only) to the walk, plus a `sort_by` that visits `/System/Volumes` before
  its siblings so firmlinked inodes are claimed by the Data tree deliberately
  rather than by readdir order. `split_startup_system` and the
  `System (OS volume)` label are unchanged. New tests:
  `visited_dedupes_directories_and_multiply_linked_files`,
  `hardlinked_files_are_counted_once` (fast) and `firmlink_counted_once`,
  `firmlink_attribution` (ignored probes over a real `/System` walk). See parity
  delta 8.
- **r21** — Purgeable-space fix. `diskutil info` no longer prints a `Purgeable
  Space` line on current macOS (observed on macOS 27.2 / APFS), so the Hidden
  Space row unconditionally read `0 B`. Purgeable is now derived from Foundation
  volume resource values --
  `volumeAvailableCapacityForImportantUsage - volumeAvailableCapacity`, the
  Finder/DaisyDisk definition -- via `objc2-foundation` (features `NSValue` +
  `NSError`), with the `diskutil` regex kept as a fallback. Measured <redacted-size> /.
  Also fixed the Hidden Space remainder to subtract the purgeable row, so the
  children no longer sum to more than the parent `hidden space...` node.
- **r22** — Hidden-space snapshots + Smart Clean coverage:
  - **Snapshots row.** Hidden Space now lists local APFS snapshots
    (`tmutil listlocalsnapshots /`). Public tooling cannot size them, so the row
    shows the count and is flagged unmeasured; their space is otherwise accounted
    inside Purgeable. The remainder row is renamed `Other protected space` →
    `Still hidden` for DaisyDisk parity.
  - **Smart Clean expansion.** New roots for local language-model weights
    (`~/.cache/huggingface`, `~/.ollama/models`, `~/.lmstudio/models`,
    `~/.cache/whisper`, GPT4All), Apple device backups
    (`~/Library/Application Support/MobileSync/Backup`), Xcode simulator systems
    (`CoreSimulator/Devices`, `CoreSimulator/Images`, `iOS DeviceSupport`,
    `Archives`) and other caches/logs/language resources (`~/.npm/_cacache`,
    `Application Support/CrashReporter`, `Library/Speech`). Sensitivity is now
    evaluated *relative to the root*, so an explicitly defined root that itself
    lives under `Application Support` (device backups) yields candidates while
    sensitive areas nested inside it stay excluded. New tests:
    `sensitive_is_checked_relative_to_the_root`,
    `new_smart_clean_roots_are_registered`, plus `hidden_space_probe` /
    `preview_probe` (ignored).
- **r23** — Renderer polish (content-tree header + locked hidden-space slice):
  - The locked `hidden space...` slice is a neutral 1px outline with no fill --
    the pale-red fill is reserved for the unlocked session. On hover the base
    outline is suppressed (via the new `lockedHiddenHoverPath` prop) and the pulse
    overlay strokes it with alpha `0.9 · (1 − pulse)`, so it fades from its normal
    look down to fully transparent. Previously the locked slice was pale-red and
    the hover pulse went 25%→100% opacity *on top of* the static outline, so it
    never reached transparent.
  - The `preview` and `top 100` badges are removed from the content-tree title
    area to free up space.
  - The content-tree title (`legend-title`) now crawls automatically whenever a
    slice is hovered, so a long hovered name is readable without hovering the
    title text itself.
  - The `Sort & Filter` text button is replaced by the compact `ListFilter`
    Lucide icon (equivalent to the SF Symbol `line.3.horizontal.decrease`),
    keeping its `title`, `aria-label`, active- and filters-active states.
- **r24** — Smart Clean rows show candidate age. Each row renders the age from
  the candidate's ISO `modifiedAt` (e.g. `35d ago`, or `today`), and safe,
  regenerable candidates older than 60 days get an
  "Unused for N days — consider cleaning" hint. Visible candidates are now
  ordered largest-first. No backend change was needed: the Rust
  `SmartCleanCandidate` already serialized `modifiedAt`, `category` and
  `categoryId`.
- **r25** — Removed developer-machine data from the shipped app:
  - The startup drive name was hardcoded to the developer's disk (`iDāsOS`), so
    every install showed that name. `drives.rs` now reads the user's real disk
    name from `diskutil info /` (`Volume Name`), falling back to
    `Macintosh HD`; the Data volume (often just `Data`) is not used as a source.
  - `fallback_drives()` no longer invents the developer's volumes (`exAPFS`,
    `I-MOVIES`); it returns one startup drive with no metrics.
  - The renderer's `DEFAULT_DRIVES` (the same developer disks) is gone — drives
    start empty and come only from the backend.
  - `APP_VERSION` was a stale `0.2.6` literal; it is now injected by Vite from
    `package.json` (`__APP_VERSION__`), so the onboarding copy tracks the real
    release.
- **r26** — “Check for Updates…” + onboarding changelog:
  - A light update check in the drives footer compares the running `APP_VERSION`
    with the newest GitHub release (`releases/latest`) and offers a Download link,
    opened through the new `open_external_url` command (http/https only). It never
    downloads or installs anything.
  - The onboarding “Recent improvements” list is now driven by
    `RELEASE_HIGHLIGHTS` (one entry per version) instead of a hardcoded bullet, so
    each release updates its own copy; the first-run modal still shows
    `CORE_FEATURES`.
  - The repository is now **public**, so `releases/latest` is reachable anonymously
    and the check reports the newest version directly; if GitHub is unreachable it
    falls back to “Couldn’t check · Open releases”.
- **r27** — “Check for Updates…” moved into the app menu:
  - It now sits in the macOS app menu directly below “About Sunburst Disk”.
    `lib.rs` builds Tauri’s default menu (which preserves About/Edit/Window/Help
    and their shortcuts) and inserts the item at position 1.
  - The check itself moved to Rust (`commands::check_for_update`): it fetches
    `releases/latest` with the system `curl` (so the core gains no HTTP client
    dependency), compares versions numerically, and reports the outcome in a
    native dialog with a Download / Open Releases Page action. The webview no
    longer performs the request, so the drives-footer button, its state, its CSS
    and the `openExternalUrl` bridge method were removed.
  - New test: `update_versions_compare_numerically`.
- **r28** — In-app update download (no browser, and no notarization needed):
  - “Check for Updates…” no longer opens the releases page. It downloads the
    release DMG itself (system `curl`, into `~/Downloads`), streaming progress via
    the `update-download` event that the renderer shows as a bottom-right toast
    (`.update-toast`).
  - When the download finishes the DMG is mounted (`hdiutil attach -nobrowse`) and
    its Finder window is opened, so the user drags the app onto the Applications
    alias that the DMG already provides. A native dialog explains the last step.
  - Because the download is performed by the app, and its Info.plist has no
    `LSFileQuarantineEnabled`, neither the DMG nor the app inside carries a
    `com.apple.quarantine` attribute — verified — so the copied app launches
    without a Gatekeeper prompt. That is why no notarization and no
    `.command`/README quarantine helper are needed; Tauri’s DMG config can only
    set window layout, not add files to the volume.
  - Trade-off versus `tauri-plugin-updater`: the DMG is not signature-verified
    (trust rests on TLS to github.com plus repository access), and nothing is
    installed automatically — the user always performs the drag.
- **r29** — Drive fullness percentage fix. The drives screen computed the startup
  disk's percentage as `used / total`, but on APFS a volume's `total` is the
  *volume's* size while `available` is the whole container's shared free space, so
  a 245 GB disk with 148 MB free read as **75%** instead of ~100% (measured here:
  75.11% instead of `df`'s 88.53%). Both `drives.rs` (new `capacity_percent`) and
  the renderer's `syncDriveCapacityFromSnapshot` now use `used / (used + available)`
  and round up, matching `df`'s Capacity column. New test:
  `capacity_percent_uses_shared_free_space`.
- **r30** — Fixed the in-app update's mount step. It invoked `/usr/sbin/hdiutil`,
  which does not exist — `hdiutil` lives in `/usr/bin` (`diskutil` is the one in
  `/usr/sbin`) — so every download failed at mount time with “No such file or
  directory (os error 2)” even though the DMG had arrived. The path is corrected
  and the new test `update_binaries_exist` asserts the absolute paths the update
  flow shells out to.
- **r31** — Smart Clean hang fixed. Two unbounded operations could stall the
  preview indefinitely:
  - **Hashing dataless files.** The duplicate pass sampled the SHA-256 of up to 400
    files. With iCloud “Desktop & Documents” enabled, `~/Documents/*` are dataless
    placeholders, so reading them made macOS *download* them: the preview hung for
    more than 13 minutes and pulled the user's data over the network. Files with
    no allocated blocks (`st_blocks == 0`) are now skipped (`has_local_contents`),
    which takes the full preview from minutes to **~0.8 s** here.
  - **`du -sk -x` per directory candidate.** It has no timeout and no pruning, so a
    cloud FileProvider domain under any candidate could be crawled and dataless
    files materialised. It is replaced by `measure_dir_bytes`: a bounded in-process
    walk (20k entries, depth 8) that prunes cloud domains exactly like the main
    scanner, never follows symlinks and stays on one filesystem, like `-x`.
  New tests: `dataless_files_have_no_local_contents`,
  `measure_dir_bytes_skips_cloud_domains`; new probe `root_timing_probe` times each
  stage. Note `related.rs` still measures app-related directories with `du -sk -x`
  (stat only, no content reads) — the same pattern, left as-is for now.
- **r32** — Cloud Storage panel (read-only). The home page's *System Smart Clean*
  button was redundant — the drive page's Smart Clean menu offers the identical
  "Current Storage" scope — so it is replaced by **Cloud Storage**, backed by
  `cloud.rs`:
  - **Cloud providers**: every FileProvider domain under `~/Library/CloudStorage`
    plus iCloud Drive, each showing the size the content *would* take in the cloud
    (logical bytes, dataless placeholders included), what it actually costs locally
    (`st_blocks`), how many files are not downloaded, and the largest locally stored
    items. Two commands (`cloud_storage_survey`, `cloud_storage_client_state`) so
    the fast half renders while the slow provider walk is still running.
  - **Cloud client state**: the local indexes/caches the clients keep (measured
    here: Google Drive <redacted-size>, Dropbox <redacted-size>). Reported, never offered for
    deletion — it is client state, not a regenerable cache.
  - Walks are `lstat`-only (no file is ever read, so placeholders are never
    materialised), bounded by 30k entries / depth 24 / a 5 s deadline per root, and
    flagged `truncated` when the deadline binds — streaming providers enumerate
    lazily, so a partial figure is shown as "≥". Symlinks are skipped and each walk
    stays on one filesystem.
  - iCloud "Desktop & Documents" sync is detected by comparing the *followed* inode
    of `~/Documents` with `com~apple~CloudDocs/Documents` (a symlink) and warned
    about, since those bytes appear in both the cloud total and the home scan.
    No cloud APIs, no quota lookups, no deletion.
  New tests: `known_providers_get_friendly_names`,
  `walk_separates_cloud_and_local_bytes`; new probe `cloud_survey_probe`.

## Terminal security model

The allowlists are compiled with the `regex` crate from the *same* pattern
sources Electron used (`SAFE_TERMINAL_COMMANDS`, `SAFE_ADMIN_COMMANDS`), so the
permitted command set is unchanged:

- Read-only: `pwd`, `df -h`, `ls`, `ls -la`, `ls -lah`, `du -sh` (optionally
  with a single unquoted argument containing no shell metacharacters).
- Admin writes require a validated password then run under `sudo -n /bin/zsh -lc`:
  `touch`, `mkdir -p`, `rm [-i] --`, `mv --`, `cp -R --`, `ln -s --`, each with
  every target resolving inside the current folder and outside protected roots.
- The working directory itself cannot be `/`, `/System/Volumes/Data`, or a
  protected root; targets are lexically resolved (so `..` escapes are rejected)
  and `~` is expanded before the containment check.
- `sudo`, arbitrary shell and unlisted flags remain blocked. Covered by unit
  tests in `src/terminal.rs`.
