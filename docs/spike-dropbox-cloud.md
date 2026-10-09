# Spike — Dropbox as a cloud provider (findings only; nothing built)

**Question.** Can Sunburst manage a *relocated* Dropbox (synced onto an external
volume) the way it manages Google Drive and iCloud Drive — a bounded read-only
walk that sizes the content, a cloud sunburst, and a cloud-only basket that moves
items to the provider's Trash?

**Answer: no.** A relocated Dropbox keeps its online-only content as Dropbox's
own placeholders on an ordinary filesystem, and those placeholders expose no
logical size to the OS. Two independent findings settle it.

## Finding 1 — dataless placeholders report `st_size = 0`

Evicted ("online-only") Dropbox items are dataless placeholders, but unlike a
Google Drive or iCloud placeholder they do **not** report their logical size at
the filesystem level:

- Walking a relocated Dropbox root on the order of 10⁵ entries found that
  essentially every file reports `st_size = 0` **and** `st_blocks = 0`; only a
  hundred-odd files held data. A representative evicted media file reported
  `size = 0, blocks = 0`.
- The placeholder marker is a `com.dropbox.placeholder` extended attribute and it
  carries **no size** — it is a two-byte marker. Reading the attribute does not
  materialise the file (it stays dataless), but it yields nothing to size a
  sunburst with.
- Dropbox's own local database
  (`~/.dropbox/instance1/sync_and_storage.db`, table `storage_files`) also stores
  `size = 0` for those rows; only a handful of directory rows are non-zero, and
  every row reports `is_available_offline = 0`.

A cloud sunburst built on `st_size` (which is what the existing walk uses) would
therefore be **all zeros** for Dropbox. This matches what Finder itself shows for
an evicted Dropbox item ("Zero bytes").

## Finding 2 — it is not an OS File Provider domain

Google Drive and iCloud Drive expose true logical sizes because they are **OS
File Provider** domains under `~/Library/CloudStorage` (and
`~/Library/Mobile Documents` for iCloud): macOS materialises a dataless
placeholder's real size without downloading it.

A relocated Dropbox is different. Although the Dropbox File Provider system
extension is installed on the Mac, the relocated folder lives at an arbitrary
path on an external volume and is served by **Dropbox's own placeholder scheme**
(the `com.dropbox.placeholder` / `com.dropbox.attrs` attributes and a
`.dropbox.cache` directory), not by a macOS File Provider domain. Two
consequences:

- **Sizing.** No File Provider API is available to ask a plain app for an item's
  size (the domain APIs are refused, e.g. `getDomains` → `-2001`), and the
  filesystem reports `st_size = 0` (Finding 1). There is no local source of the
  logical size.
- **Trash.** Trashing a disposable dataless placeholder with
  `FileManager.trashItem` succeeded quickly (~80 ms) and downloaded nothing, but
  it landed in the **volume's own Trash** (`/Volumes/<volume>/.Trashes/<uid>/`),
  not in a provider-side cloud trash — consistent with the folder not being a
  File Provider domain. That is not the cloud-trash semantics the app offers for
  Google Drive / iCloud Drive, and there is no cloud recovery path to point at
  the way there is for those providers.

## Conclusion

**Dropbox online-only is out of scope.** Sunburst's cloud support requires a
provider that exposes the true logical size of a dataless item through the OS
File Provider API — i.e. **Google Drive and iCloud Drive**. A relocated Dropbox
does not, and there is no download-free way to recover that size locally.

Nothing was built for Dropbox: no discovery from `~/.dropbox/info.json`, no
"Add a cloud folder…" registration for it, no Dropbox basket or Trash, and no
change to the existing provider list.

### What still works

The relocated Dropbox sits on an ordinary (non-File-Provider) volume, so its
materialised files are plain local files: a regular folder scan of the external
volume still sizes and reviews them normally. Only the *cloud* framing (logical
cloud sizes and the cloud basket → provider Trash) is unavailable for it.
