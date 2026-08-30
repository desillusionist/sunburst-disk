# Archive preview and virtual navigation design

## Scope

Archive files remain single collapsed entries in the sunburst and content tree by default. The Inspector may expose `Show Archive Contents` for supported archive formats. The feature is a read-only virtual view: it must never extract files, modify the archive, or treat archive members as ordinary filesystem paths.

## Supported first wave

The first implementation should use the operating-system tools already available on macOS where possible: `unzip -Z1` or `unzip -l` for ZIP, `tar -tf`/`tar -tvf` for tar and tar-based formats, and a bounded `ditto --list` fallback for formats supported by Archive Utility. RAR/7z support should be added only when a reliable listing tool is bundled or explicitly detected. Unsupported formats keep the collapsed archive entry and show a clear Inspector message.

## Virtual node model

Archive children should use a non-filesystem identity such as `archive://<absolute-archive-path>?entry=<percent-encoded-entry>`. Each virtual node stores the archive path, entry name, entry type, uncompressed size when the format exposes it, and an `archiveVirtual: true` marker. Virtual paths must never be sent to `shell.showItemInFolder`, Collector deletion, Terminal write commands, FSEvents watcher, or ordinary `scanSubdir`.

Directory entries are synthesized from member prefixes. Listing must be bounded by a maximum member count and maximum output bytes. The root archive node remains authoritative for on-disk size; member sizes are informational and must not be added to the filesystem sunburst size a second time.

## Navigation and UI

`Show Archive Contents` loads only the first virtual level or a bounded index. Clicking a virtual directory filters the already indexed member list; it must not invoke filesystem scanning. The Inspector shows `Archive member`, `Compressed size` when available, `Uncompressed size` when available, and the source archive path. `Hide Archive Contents` discards the in-memory virtual index and restores the collapsed package node.

Quick Look may receive the real archive path, but never a synthesized virtual member path. Reveal in Finder and Open With remain available only for the physical archive file.

## Safety and invalidation

The archive is re-stat'ed before each listing. If it was renamed, deleted, or its modification time/size changed, the virtual index is discarded and the UI asks for a fresh Show action. Archive members are never deletion candidates. A malformed or encrypted archive returns an in-app error without spawning arbitrary shell syntax.

## Performance

Archive listing is on-demand and cached by `(realpath, mtime, size)`. No archive is unpacked and no recursive checksum or periodic polling is introduced. The cache is cleared on navigation away, Hide, Refresh, or a watcher event for the physical archive path.
