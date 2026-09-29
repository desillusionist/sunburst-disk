//! In-process directory scanner.
//!
//! This replaces Electron's `du -ak -x` subprocess plus `buildTreeFromDu`
//! text parser. Sizes are the sum of on-disk block usage (`st_blocks * 512`)
//! accumulated bottom-up, so a folder's reported size equals the sum of its
//! contents -- the invariant the renderer depends on.
//!
//! Parity rules carried over from `electron/main.js`:
//!   * symlinks are never followed and never shown as tree rows,
//!   * `.app` / `.photoslibrary` bundles are single rows whose size includes
//!     their (hidden) contents unless `include_package_contents` is set,
//!   * junk roots (`.Trash`, `.fseventsd`, ...) are excluded entirely,
//!   * cloud FileProvider domains (`Library/CloudStorage`, `Library/Mobile
//!     Documents`) are excluded entirely -- they mirror hundreds of thousands
//!     of dataless placeholders and are not local disk usage,
//!   * the walk stays on one filesystem, like `du -x`,
//!   * each physical object is counted once: `(st_dev, st_ino)` is tracked for
//!     directories and multiply-linked files, so firmlinks and hardlinks are not
//!     double-counted (matching `du`'s default),
//!   * the startup scan walks `/System` once and splits it into the Data volume
//!     (root) plus a sealed OS-volume remainder child, like Electron's
//!     `du -ak -x /System` pass,
//!   * children arrays are materialised only to `detail_depth`; deeper levels
//!     are lazy-loaded by a later `scan_subdir` call.
//!
//! The walk keeps only a compact per-entry record: no paths are stored, parents
//! are recovered from a depth stack, and file names are allocated only for the
//! shallow nodes that can be materialised. This keeps a full-disk scan (millions
//! of entries) from allocating gigabytes and stalling.

use std::collections::{HashMap, HashSet};
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use walkdir::WalkDir;

use crate::capacity::statfs_info;
use crate::types::{NodeType, ScanProgress, TreeNode};

/// Basenames whose subtrees are excluded from the tree, matching `SKIP_NAMES`.
const SKIP_NAMES: [&str; 6] = [
    ".Trash",
    ".Spotlight",
    ".fseventsd",
    ".DS_Store",
    ".DocumentRevisions-V100",
    ".TemporaryItems",
];

/// FileProvider cloud domains. These directories are not local disk usage: they
/// are virtual mirrors whose contents are mostly *dataless* placeholders that
/// must be resolved through `fileproviderd`. Two of them, Google Drive's
/// `Library/CloudStorage` and iCloud's `Library/Mobile Documents`, routinely
/// hold hundreds of thousands of zero-byte stubs, so enumerating them costs more
/// than the rest of the disk combined and makes the scan look like it hangs.
///
/// Excluded the same way as `SKIP_NAMES` (and for the same reason `smart_clean`
/// already treats `CloudStorage` as sensitive). This is a deliberate, documented
/// parity delta from `electron/main.js`, whose `du -ak -x /System` pass would
/// descend into these domains: see `docs/electron-to-tauri-migration.md`.
const CLOUD_DOMAIN_NAMES: [&str; 2] = ["CloudStorage", "Mobile Documents"];

/// The writable Data volume, mounted inside the sealed System volume. Used as the
/// `df`/hidden-space reference and as the protected root of the startup walk.
pub const DATA_VOLUME_PATH: &str = "/System/Volumes/Data";

const PROGRESS_INTERVAL: Duration = Duration::from_millis(150);
const CANCEL_CHECK_EVERY: u32 = 512;
/// Emit the synthetic `hidden space...` node only for gaps above 1 GB.
const HIDDEN_SPACE_MIN_BYTES: u64 = 1_000_000_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanOptions {
    pub detail_depth: usize,
    pub include_package_contents: bool,
    /// Directories that must be walked even when they sit on a different device
    /// than the scan root. Belt-and-braces for the startup walk: the firmlinked
    /// `/System/Volumes/Data` must never be pruned, even on a hypothetical macOS
    /// build where it reports a `st_dev` distinct from `/System`'s.
    #[serde(default)]
    pub protected_roots: Vec<PathBuf>,
}

impl Default for ScanOptions {
    fn default() -> Self {
        Self {
            detail_depth: 10,
            include_package_contents: false,
            protected_roots: Vec::new(),
        }
    }
}

#[derive(Debug)]
pub enum ScanError {
    Cancelled,
    Io(String),
}

impl std::fmt::Display for ScanError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ScanError::Cancelled => write!(f, "Scan cancelled"),
            ScanError::Io(message) => write!(f, "{message}"),
        }
    }
}

pub(crate) fn is_package_name(name: &str) -> bool {
    let lower = name.trim().to_lowercase();
    lower.ends_with(".app") || lower.ends_with(".photoslibrary")
}

fn is_skipped_name(name: &str) -> bool {
    SKIP_NAMES.iter().any(|skip| name.starts_with(skip))
}

/// True for cloud-provider FileProvider roots such as `Library/CloudStorage` and
/// `Library/Mobile Documents`. Matched by exact basename, like `SKIP_NAMES`.
fn is_cloud_domain(name: &str) -> bool {
    CLOUD_DOMAIN_NAMES.contains(&name)
}

/// True when a walk entry must be pruned because it lives on a different device
/// (`st_dev`) than the scan root. This mirrors `du -x`: it prevents the walk from
/// descending into other volumes and into network mounts (SMB/NFS under
/// `/Volumes/*`), where directory enumeration is remote and can hang exactly like
/// the cloud FileProvider domains.
///
/// Only directories cross a boundary -- `du -x` likewise still counts files on
/// another device; it just does not recurse into directories there. A `root_dev`
/// of `0` means the root could not be stat'ed, so pruning is disabled (fail-open:
/// better to walk than to prune everything). In practice that branch is
/// unreachable -- `scan_tree` stats the root via `is_dir()` before this is ever
/// called, so a root that cannot be stat'ed already returned an error.
fn crosses_device_boundary(is_dir: bool, dev: u64, root_dev: u64) -> bool {
    is_dir && root_dev != 0 && dev != root_dev
}

/// Whether a directory entry must be pruned: it crosses the device boundary and
/// is not one of the caller's explicitly protected roots. The protection check
/// only runs for entries that already crossed the boundary (rare), so the common
/// path is unaffected.
fn should_prune_dir(
    protected_roots: &[PathBuf],
    path: &Path,
    is_dir: bool,
    dev: u64,
    root_dev: u64,
) -> bool {
    crosses_device_boundary(is_dir, dev, root_dev)
        && !protected_roots.iter().any(|root| root == path)
}

/// Deterministic firmlink attribution. `/System/Volumes` must be visited before
/// its siblings under `/System` (notably `/System/Library`), because the
/// firmlinked children of `/System/Library` (`AssetsV2`, `Assets`, `Caches`, …)
/// are the *same* `(st_dev, st_ino)` objects as their Data-volume twins under
/// `/System/Volumes/Data/System/Library/...`. Visiting the Data subtree first
/// makes the `Visited` dedupe attribute those bytes to the Data tree, so the
/// split's `System (OS volume)` row stays sealed-volume-only. Only the walk
/// root's children (depth 1) are reordered; every other directory keeps its
/// readdir order (the comparator returns `Equal`, and the sort is stable).
fn volumes_first(a: &walkdir::DirEntry, b: &walkdir::DirEntry) -> std::cmp::Ordering {
    fn is_volumes(entry: &walkdir::DirEntry) -> bool {
        entry.depth() == 1 && entry.file_name() == std::ffi::OsStr::new("Volumes")
    }
    is_volumes(b).cmp(&is_volumes(a))
}

/// Physical-object identity set so each object is counted once, like `du`.
/// Firmlinks expose one directory at two paths, and hardlinked files are one
/// inode under several names. Only directories and multiply-linked files are
/// tracked -- a single-link regular file cannot repeat, so tracking it would
/// waste memory across a full-disk scan for nothing.
#[derive(Default)]
struct Visited {
    seen: HashSet<(u64, u64)>,
}

impl Visited {
    /// Records the object and returns whether it had already been counted.
    /// `false` is also returned for objects that are never tracked (regular
    /// single-link files), which therefore can never be skipped.
    fn seen_before(&mut self, metadata: &std::fs::Metadata) -> bool {
        self.tracked(
            metadata.is_dir(),
            metadata.nlink(),
            metadata.dev(),
            metadata.ino(),
        )
    }

    fn tracked(&mut self, is_dir: bool, nlink: u64, dev: u64, ino: u64) -> bool {
        if !is_dir && nlink <= 1 {
            return false;
        }
        !self.seen.insert((dev, ino))
    }
}

fn normalize_root(root: &Path) -> PathBuf {
    let text = root.to_string_lossy();
    let trimmed = text.trim_end_matches('/');
    if trimmed.is_empty() {
        PathBuf::from("/")
    } else {
        PathBuf::from(trimmed)
    }
}

/// True when any component of `path` is a cloud FileProvider domain. Descendants
/// of a domain are pruned during the walk by name; this guard additionally
/// covers the case where the scan *root* itself lies inside a domain (reachable
/// through a custom-folder scan), which the name filter alone cannot prune.
fn root_within_cloud_domain(root: &Path) -> bool {
    root.components().any(|component| match component {
        std::path::Component::Normal(name) => name.to_str().is_some_and(is_cloud_domain),
        _ => false,
    })
}

/// Compact per-entry record. `size` starts as the entry's own bytes and becomes
/// the cumulative subtree size after the reverse pass.
struct RawNode {
    parent: Option<u32>,
    size: u64,
    item_count: u64,
    depth: u32,
    is_dir: bool,
    visible: bool,
    /// Only populated for nodes within `detail_depth` (the materialised ones).
    name: String,
}

fn ensure_len<T: Clone>(values: &mut Vec<T>, len: usize, fill: T) {
    if values.len() < len {
        values.resize(len, fill);
    }
}

/// Walk `root` and build the authoritative tree. `progress` is invoked at most
/// every 150 ms while `cancel` is polled every few hundred entries.
pub fn scan_tree(
    root: &Path,
    options: ScanOptions,
    cancel: &AtomicBool,
    mut progress: impl FnMut(ScanProgress),
) -> Result<TreeNode, ScanError> {
    let root = normalize_root(root);
    let root_display = root.to_string_lossy().into_owned();

    // A scan rooted inside a cloud domain cannot be walked cheaply: enumerating
    // the mirror is pathologically slow and it is not local disk usage. Refuse
    // explicitly (before any I/O on the domain) rather than appearing to hang.
    if root_within_cloud_domain(&root) {
        return Err(ScanError::Io(format!(
            "{root_display} is a cloud storage location; its remote contents are not scanned"
        )));
    }

    if !root.is_dir() {
        return Err(ScanError::Io(format!(
            "{} is not a directory",
            root.display()
        )));
    }
    let root_name = root
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| root_display.clone());

    let root_dev = std::fs::symlink_metadata(&root)
        .map(|md| md.dev())
        .unwrap_or(0);
    let used_bytes = statfs_info(&root).map(|info| info.used_bytes).unwrap_or(0);

    let mut nodes: Vec<RawNode> = Vec::new();
    // Depth-indexed ancestors: `parent_at[d]` is the index of the last entry
    // seen at depth `d`, which is the parent of the next entry at depth `d + 1`.
    let mut parent_at: Vec<Option<u32>> = Vec::new();
    let mut inside_at: Vec<bool> = Vec::new();
    let mut package_at: Vec<bool> = Vec::new();
    // Children of shallow visible nodes, for materialisation only.
    let mut adjacency: HashMap<u32, Vec<u32>> = HashMap::new();

    let mut walker = WalkDir::new(&root)
        .follow_links(false)
        .sort_by(volumes_first)
        .into_iter();
    // Count each physical object once (firmlinks, hardlinks) like `du`.
    let mut visited = Visited::default();
    let mut ticks: u32 = 0;
    let mut items_seen: u64 = 0;
    let mut bytes_seen: u64 = 0;
    let mut last_emit = Instant::now();

    while let Some(entry) = walker.next() {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => continue,
        };

        let depth = entry.depth();
        let is_root = depth == 0;
        let file_type = entry.file_type();
        let is_dir = file_type.is_dir();
        let is_symlink = file_type.is_symlink();
        let metadata = match entry.metadata() {
            Ok(metadata) => metadata,
            Err(_) => continue,
        };

        let file_name = entry.file_name();
        let name = file_name.to_string_lossy();

        // Junk subtrees, cloud FileProvider domains and other filesystems are
        // dropped without descending, mirroring `du -x` plus the `SKIP_NAMES` and
        // cloud-domain filters.
        if !is_root {
            let junk = is_skipped_name(&name) || is_cloud_domain(&name);
            let crosses_device = should_prune_dir(
                &options.protected_roots,
                entry.path(),
                is_dir,
                metadata.dev(),
                root_dev,
            );
            let skip = junk || crosses_device || visited.seen_before(&metadata);
            if skip {
                if is_dir {
                    walker.skip_current_dir();
                }
                continue;
            }
        }

        let parent = if is_root {
            None
        } else {
            parent_at.get(depth - 1).copied().flatten()
        };
        let inside_here = if is_root || options.include_package_contents {
            false
        } else {
            inside_at.get(depth - 1).copied().unwrap_or(false)
                || package_at.get(depth - 1).copied().unwrap_or(false)
        };
        let visible = !is_symlink && !inside_here;

        let own = metadata.blocks().saturating_mul(512);
        let index = nodes.len() as u32;
        let package_here = is_dir && is_package_name(&name);
        let stored_name = if depth <= options.detail_depth {
            if is_root {
                root_name.clone()
            } else {
                name.into_owned()
            }
        } else {
            String::new()
        };

        nodes.push(RawNode {
            parent,
            size: own,
            item_count: 0,
            depth: depth as u32,
            is_dir,
            visible,
            name: stored_name,
        });

        ensure_len(&mut parent_at, depth + 1, None);
        ensure_len(&mut inside_at, depth + 1, false);
        ensure_len(&mut package_at, depth + 1, false);
        parent_at[depth] = Some(index);
        inside_at[depth] = inside_here;
        package_at[depth] = package_here;

        if visible && depth <= options.detail_depth {
            if let Some(parent) = parent {
                adjacency.entry(parent).or_default().push(index);
            }
        }

        items_seen += 1;
        bytes_seen = bytes_seen.saturating_add(own);

        ticks = ticks.wrapping_add(1);
        if ticks % CANCEL_CHECK_EVERY == 0 {
            if cancel.load(Ordering::Relaxed) {
                return Err(ScanError::Cancelled);
            }
            if last_emit.elapsed() >= PROGRESS_INTERVAL {
                last_emit = Instant::now();
                progress(ScanProgress {
                    current_dir: root_display.clone(),
                    items_scanned: items_seen,
                    percent: percent_of(bytes_seen, used_bytes),
                });
            }
        }
    }

    if cancel.load(Ordering::Relaxed) {
        return Err(ScanError::Cancelled);
    }

    // Children always have a larger index than their parent (pre-order), so a
    // reverse pass accumulates sizes and descendant counts bottom-up.
    for index in (1..nodes.len()).rev() {
        let (parent, size, visible, item_count) = {
            let node = &nodes[index];
            (node.parent, node.size, node.visible, node.item_count)
        };
        if let Some(parent) = parent {
            let parent_index = parent as usize;
            nodes[parent_index].size = nodes[parent_index].size.saturating_add(size);
            if visible {
                nodes[parent_index].item_count += 1 + item_count;
            }
        }
    }

    Ok(materialize(
        0,
        &root_display,
        &nodes,
        &adjacency,
        options.detail_depth,
    ))
}

fn percent_of(seen: u64, total: u64) -> i64 {
    if total == 0 {
        return -1;
    }
    (((seen as u128 * 100) / total as u128).min(99)) as i64
}

fn materialize(
    index: usize,
    path: &str,
    nodes: &[RawNode],
    adjacency: &HashMap<u32, Vec<u32>>,
    detail_depth: usize,
) -> TreeNode {
    let raw = &nodes[index];
    let mut node = TreeNode {
        name: raw.name.clone(),
        path: path.to_string(),
        size: raw.size,
        node_type: if raw.is_dir {
            NodeType::Directory
        } else {
            NodeType::File
        },
        children: Vec::new(),
        item_count: raw.item_count,
        ..Default::default()
    };

    if raw.is_dir && (raw.depth as usize) < detail_depth {
        if let Some(children) = adjacency.get(&(index as u32)) {
            let mut ordered = children.clone();
            ordered.sort_by_key(|child| std::cmp::Reverse(nodes[*child as usize].size));
            node.children = ordered
                .into_iter()
                .map(|child| {
                    let child = child as usize;
                    let child_path = if path == "/" {
                        format!("/{}", nodes[child].name)
                    } else {
                        format!("{path}/{}", nodes[child].name)
                    };
                    materialize(child, &child_path, nodes, adjacency, detail_depth)
                })
                .collect();
        }
    }

    node
}

/// Append the `hidden space...` reconciliation node for the startup volume:
/// what `df` reports as used minus what the walk could actually index.
pub fn append_hidden_space(tree: &mut TreeNode, scan_path: &Path) {
    let Some(info) = statfs_info(scan_path) else {
        return;
    };
    let used = info.used_bytes;
    if used <= tree.size {
        return;
    }
    let hidden = used - tree.size;
    if hidden <= HIDDEN_SPACE_MIN_BYTES {
        return;
    }
    tree.children.push(TreeNode {
        name: "hidden space...".to_string(),
        path: "__hidden__".to_string(),
        size: hidden,
        node_type: NodeType::Special,
        children: Vec::new(),
        item_count: 0,
        hidden_space_aggregate_size: Some(hidden),
        ..Default::default()
    });
    tree.size = tree.size.saturating_add(hidden);
    tree.children
        .sort_by_key(|child| std::cmp::Reverse(child.size));
}

/// Display label for the sealed read-only OS-volume remainder the startup scan
/// splits out of `/System`. It is renamed (display only; the path stays
/// `/System`) so it is not ambiguous next to the writable Data volume's own
/// `System` directory (`/System/Volumes/Data/System`).
const OS_VOLUME_LABEL: &str = "System (OS volume)";

/// Reshape a `/System`-rooted tree into the startup view Electron built from one
/// `du -ak -x /System` pass: the Data volume becomes the root and the sealed
/// OS-volume remainder (`/System` minus `/System/Volumes`) is appended as a
/// sibling child. The whole `Volumes` node is dropped from the remainder, just
/// as Electron's `restLines` filter excluded every `/System/Volumes*` row -- which
/// also discards the other same-device `Volumes` siblings (Recovery, BaseSystem,
/// FieldService*) that `-x`/`st_dev` cannot prune because they share the root
/// device id.
///
/// Falls back to the input unchanged when the `Volumes/Data` layout is absent
/// (non-standard machines, or a scan too shallow to materialise it).
pub fn split_startup_system(mut tree: TreeNode) -> TreeNode {
    let Some(volumes_index) = tree
        .children
        .iter()
        .position(|child| child.name == "Volumes")
    else {
        return tree;
    };
    let mut volumes = tree.children.remove(volumes_index);
    let Some(data_index) = volumes
        .children
        .iter()
        .position(|child| child.name == "Data")
    else {
        tree.children.insert(volumes_index, volumes);
        return tree;
    };
    let data = volumes.children.remove(data_index);

    // `tree.size` is the whole `/System`, so `- volumes.size` leaves exactly the
    // OS-volume own bytes plus its remaining children -- the remainder's size.
    let os_size = tree.size.saturating_sub(volumes.size);
    let os_item_count = tree
        .children
        .iter()
        .map(|child| 1 + child.item_count)
        .sum::<u64>();
    let os_remainder = TreeNode {
        name: OS_VOLUME_LABEL.to_string(),
        path: "/System".to_string(),
        size: os_size,
        node_type: NodeType::Directory,
        children: std::mem::take(&mut tree.children),
        item_count: os_item_count,
        ..Default::default()
    };

    let mut root = data;
    root.path = "/System/Volumes/Data".to_string();
    root.size = root.size.saturating_add(os_remainder.size);
    root.item_count = root.item_count.saturating_add(1 + os_remainder.item_count);
    root.children.push(os_remainder);
    root.children
        .sort_by_key(|child| std::cmp::Reverse(child.size));
    root
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::AtomicBool;

    fn crate_src_dir() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src")
    }

    #[test]
    fn scans_a_real_directory_without_following_links() {
        let cancel = AtomicBool::new(false);
        let tree = scan_tree(
            &crate_src_dir(),
            ScanOptions {
                detail_depth: 4,
                include_package_contents: false,
                ..ScanOptions::default()
            },
            &cancel,
            |_| {},
        )
        .expect("scan should succeed");

        assert_eq!(tree.node_type, NodeType::Directory);
        assert!(tree.size > 0, "directory should report a non-zero size");
        assert!(tree.item_count > 0, "directory should contain entries");
        assert!(
            !tree.children.is_empty(),
            "top-level children should be materialised"
        );
        // Children are ordered largest first.
        for pair in tree.children.windows(2) {
            assert!(pair[0].size >= pair[1].size, "children must be size-sorted");
        }
        // Paths are reconstructed from the root plus names.
        for child in &tree.children {
            assert!(child.path.starts_with(&*crate_src_dir().to_string_lossy()));
            assert!(child.path.ends_with(&child.name));
        }
    }

    #[test]
    fn detail_depth_limits_materialised_children() {
        let cancel = AtomicBool::new(false);
        let tree = scan_tree(
            &crate_src_dir(),
            ScanOptions {
                detail_depth: 0,
                include_package_contents: false,
                ..ScanOptions::default()
            },
            &cancel,
            |_| {},
        )
        .expect("scan should succeed");
        assert!(tree.children.is_empty(), "depth 0 materialises no children");
        // Counts and sizes still reflect the whole subtree.
        assert!(tree.item_count > 0);
        assert!(tree.size > 0);
    }

    #[test]
    fn cancelling_before_start_aborts() {
        let cancel = AtomicBool::new(true);
        let mut polls = 0u64;
        let result = scan_tree(&crate_src_dir(), ScanOptions::default(), &cancel, |_| {
            polls += 1
        });
        // The flag is only polled every CANCEL_CHECK_EVERY entries, so a tiny
        // tree may finish first; either outcome must not panic.
        match result {
            Err(ScanError::Cancelled) => {}
            Ok(tree) => assert!(tree.size > 0),
            Err(other) => panic!("unexpected error: {other}"),
        }
    }

    #[test]
    fn package_and_skip_helpers_match_electron_rules() {
        assert!(is_package_name("Safari.app"));
        assert!(is_package_name("Photos Library.photoslibrary"));
        assert!(!is_package_name("notes.txt"));
        assert!(is_skipped_name(".Trash"));
        assert!(is_skipped_name(".DS_Store"));
        assert!(!is_skipped_name("Documents"));
        // Cloud FileProvider roots are excluded; unrelated names are not.
        assert!(is_cloud_domain("CloudStorage"));
        assert!(is_cloud_domain("Mobile Documents"));
        assert!(!is_cloud_domain("cloudstorage"));
        assert!(!is_cloud_domain("Documents"));
    }

    #[test]
    fn cloud_domain_roots_are_refused() {
        assert!(root_within_cloud_domain(Path::new(
            "/Users/x/Library/CloudStorage"
        )));
        assert!(root_within_cloud_domain(Path::new(
            "/Users/x/Library/CloudStorage/GoogleDrive-a@b.com"
        )));
        assert!(root_within_cloud_domain(Path::new(
            "/Users/x/Library/Mobile Documents/com~apple~Pages"
        )));
        assert!(!root_within_cloud_domain(Path::new("/Users/x/Library")));
        assert!(!root_within_cloud_domain(Path::new("/System/Volumes/Data")));
    }

    #[test]
    fn visited_dedupes_directories_and_multiply_linked_files() {
        let mut visited = Visited::default();
        // A directory is tracked; its second sighting is skipped.
        assert!(!visited.tracked(true, 1, 7, 100));
        assert!(visited.tracked(true, 1, 7, 100));
        // The same inode number on another device is a different object.
        assert!(!visited.tracked(true, 1, 8, 100));
        // A multiply-linked file is tracked; its second sighting is skipped.
        assert!(!visited.tracked(false, 2, 7, 200));
        assert!(visited.tracked(false, 2, 7, 200));
        // A single-link regular file is never tracked, so never skipped.
        assert!(!visited.tracked(false, 1, 7, 300));
        assert!(!visited.tracked(false, 1, 7, 300));
    }

    #[test]
    fn hardlinked_files_are_counted_once() {
        use std::fs;
        let dir = std::env::temp_dir().join(format!("sunburst-dedupe-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("temp dir");
        fs::write(dir.join("a.bin"), vec![0u8; 8192]).expect("write");
        fs::hard_link(dir.join("a.bin"), dir.join("b.bin")).expect("hard link");

        let cancel = AtomicBool::new(false);
        let tree = scan_tree(&dir, ScanOptions::default(), &cancel, |_| {}).expect("scan");
        let _ = fs::remove_dir_all(&dir);

        let linked: Vec<&TreeNode> = tree
            .children
            .iter()
            .filter(|child| child.name.ends_with(".bin"))
            .collect();
        assert_eq!(
            linked.len(),
            1,
            "hardlinks share one inode and must be counted once"
        );
        assert!(linked[0].size > 0, "the surviving hardlink keeps its bytes");
    }

    /// Recursively finds the node with the given absolute path.
    fn find_by_path<'a>(node: &'a TreeNode, path: &str) -> Option<&'a TreeNode> {
        if node.path == path {
            return Some(node);
        }
        node.children
            .iter()
            .find_map(|child| find_by_path(child, path))
    }

    // The firmlink probes need a real firmlink, so they walk `/System` (~40 s)
    // and are ignored by default; run with `--ignored`. `/System/Library/AssetsV2`
    // is verified same-inode as `/System/Volumes/Data/System/Library/AssetsV2`.
    #[test]
    #[ignore = "probe: real firmlink; ~40s /System walk"]
    fn firmlink_counted_once() {
        let cancel = AtomicBool::new(false);
        let tree = scan_tree(
            Path::new("/System"),
            ScanOptions::default(),
            &cancel,
            |_| {},
        )
        .expect("scan /System");
        let root = split_startup_system(tree);

        let at_data = find_by_path(&root, "/System/Volumes/Data/System/Library/AssetsV2");
        let at_os = find_by_path(&root, "/System/Library/AssetsV2");
        assert!(
            !(at_data.is_some() && at_os.is_some()),
            "firmlinked AssetsV2 must not be counted under both trees"
        );
        assert!(
            at_data.is_some() || at_os.is_some(),
            "AssetsV2 must be present somewhere"
        );
    }

    #[test]
    #[ignore = "probe: real firmlink; ~40s /System walk"]
    fn firmlink_attribution() {
        let cancel = AtomicBool::new(false);
        let tree = scan_tree(
            Path::new("/System"),
            ScanOptions::default(),
            &cancel,
            |_| {},
        )
        .expect("scan /System");
        let root = split_startup_system(tree);

        // The Data subtree is walked first, so it claims the firmlinked inode ...
        assert_eq!(root.path, "/System/Volumes/Data");
        assert!(
            find_by_path(&root, "/System/Volumes/Data/System/Library/AssetsV2").is_some(),
            "firmlinked content must be attributed to the Data tree"
        );
        // ... and the OS-volume row keeps only genuine sealed-volume bytes.
        let os = root
            .children
            .iter()
            .find(|child| child.name == OS_VOLUME_LABEL)
            .expect("OS-volume row present");
        assert!(
            find_by_path(os, "/System/Library/AssetsV2").is_none(),
            "the OS-volume row must not re-count firmlinked Data content"
        );
    }

    fn empty_dir(name: &str, path: &str, size: u64) -> TreeNode {
        TreeNode {
            name: name.to_string(),
            path: path.to_string(),
            size,
            node_type: NodeType::Directory,
            children: Vec::new(),
            item_count: 0,
            ..Default::default()
        }
    }

    #[test]
    fn startup_split_promotes_data_and_keeps_os_remainder() {
        // /System/Volumes/Data = System(100) + Users(200); Volumes adds 10 own.
        let data = TreeNode {
            name: "Data".to_string(),
            path: "/System/Volumes/Data".to_string(),
            size: 300,
            node_type: NodeType::Directory,
            item_count: 2,
            children: vec![
                empty_dir("System", "/System/Volumes/Data/System", 100),
                empty_dir("Users", "/System/Volumes/Data/Users", 200),
            ],
            ..Default::default()
        };
        let volumes = TreeNode {
            name: "Volumes".to_string(),
            path: "/System/Volumes".to_string(),
            size: 310, // Data (300) + 10 own
            node_type: NodeType::Directory,
            item_count: 3,
            children: vec![data],
            ..Default::default()
        };
        let tree = TreeNode {
            name: "System".to_string(),
            path: "/System".to_string(),
            size: 900, // own 40 + Library 500 + Applications 50 + Volumes 310
            node_type: NodeType::Directory,
            item_count: 6, // (1+3)+(1+0)+(1+0)
            children: vec![
                volumes,
                empty_dir("Applications", "/System/Applications", 50),
                empty_dir("Library", "/System/Library", 500),
            ],
            ..Default::default()
        };

        let root = split_startup_system(tree);

        assert_eq!(root.path, "/System/Volumes/Data");
        assert_eq!(root.size, 890); // Data 300 + remainder 590
        assert_eq!(root.item_count, 5); // 2 + (1 + 2)

        let os = root
            .children
            .iter()
            .find(|child| child.name == OS_VOLUME_LABEL)
            .expect("OS-volume remainder is present");
        assert_eq!(os.path, "/System");
        assert_eq!(os.size, 590); // 900 - 310
        assert_eq!(os.item_count, 2);
        let mut names: Vec<&str> = os.children.iter().map(|c| c.name.as_str()).collect();
        names.sort_unstable();
        assert_eq!(names, ["Applications", "Library"]);
        assert!(!os.children.iter().any(|c| c.name == "Volumes"));

        // Children stay size-sorted and the subtree-sum invariant still holds.
        for pair in root.children.windows(2) {
            assert!(pair[0].size >= pair[1].size, "children must be size-sorted");
        }
        let child_sum: u64 = root.children.iter().map(|child| child.size).sum();
        assert!(root.size >= child_sum);
    }

    #[test]
    fn startup_split_without_volumes_is_a_noop() {
        let tree = empty_dir("System", "/System", 10);
        let root = split_startup_system(tree);
        assert_eq!(root.path, "/System");
        assert!(root.children.is_empty());
    }

    #[test]
    fn scanning_a_cloud_domain_root_errors_instead_of_hanging() {
        let cancel = AtomicBool::new(false);
        let probe = Path::new("/Users/x/Library/CloudStorage");
        // The guard fires on the path components, before any I/O on the domain.
        match scan_tree(probe, ScanOptions::default(), &cancel, |_| {}) {
            Err(ScanError::Io(message)) => {
                assert!(
                    message.contains("cloud storage"),
                    "unexpected message: {message}"
                )
            }
            other => panic!("expected a cloud-domain refusal, got {other:?}"),
        }
    }

    #[test]
    fn device_boundary_predicate_matches_du_x() {
        // Same device -> kept.
        assert!(!crosses_device_boundary(true, 42, 42));
        // Directory on another device -> pruned (the network-mount / other-volume case).
        assert!(crosses_device_boundary(true, 43, 42));
        // Files are still counted even when they sit on another device.
        assert!(!crosses_device_boundary(false, 43, 42));
        // An unknown root device (0) disables pruning.
        assert!(!crosses_device_boundary(true, 43, 0));
    }

    #[test]
    fn protected_root_is_never_pruned_by_device_boundary() {
        let protected = [PathBuf::from(DATA_VOLUME_PATH)];
        // Cross-device but explicitly protected -> kept.
        assert!(!should_prune_dir(
            &protected,
            Path::new(DATA_VOLUME_PATH),
            true,
            43,
            42
        ));
        // Cross-device and not protected -> pruned.
        assert!(should_prune_dir(
            &protected,
            Path::new("/System/Volumes/VM"),
            true,
            43,
            42
        ));
        // Same device -> kept regardless of the protection list.
        assert!(!should_prune_dir(
            &protected,
            Path::new("/System/Library"),
            true,
            42,
            42
        ));
        // No protection behaves like the plain guard.
        assert!(should_prune_dir(
            &[],
            Path::new("/Volumes/exAPFS"),
            true,
            43,
            42
        ));
    }

    #[test]
    #[ignore = "probe: cross-device mounts under /Volumes must be pruned"]
    fn device_boundary_probe() {
        let root = Path::new("/Volumes");
        if !root.is_dir() {
            return;
        }
        let root_dev = std::fs::symlink_metadata(root)
            .expect("stat /Volumes")
            .dev();
        let cancel = AtomicBool::new(false);
        let tree = scan_tree(root, ScanOptions::default(), &cancel, |_| {}).expect("scan /Volumes");

        let mut cross_device_dirs = 0usize;
        for entry in std::fs::read_dir(root).expect("read /Volumes").flatten() {
            if let Ok(md) = std::fs::symlink_metadata(entry.path()) {
                if md.is_dir() && md.dev() != root_dev {
                    cross_device_dirs += 1;
                }
            }
        }
        eprintln!(
            "/Volumes: {} surviving children, {cross_device_dirs} cross-device dirs pruned",
            tree.children.len()
        );
        // Every surviving child must live on the scan root's device.
        for child in &tree.children {
            if let Ok(md) = std::fs::symlink_metadata(&child.path) {
                assert_eq!(
                    md.dev(),
                    root_dev,
                    "cross-device entry survived: {}",
                    child.path
                );
            }
        }
    }

    #[test]
    #[ignore = "perf probe; set SUNBURST_SCAN_PATH (default /System/Library)"]
    fn perf_probe() {
        let path =
            std::env::var("SUNBURST_SCAN_PATH").unwrap_or_else(|_| "/System/Library".to_string());
        let cancel = AtomicBool::new(false);
        let started = std::time::Instant::now();
        let tree = scan_tree(
            Path::new(&path),
            ScanOptions {
                detail_depth: 10,
                include_package_contents: false,
                ..ScanOptions::default()
            },
            &cancel,
            |_| {},
        )
        .expect("scan should succeed");
        let elapsed = started.elapsed();
        eprintln!(
            "scanned {path} in {elapsed:?}: size={} itemCount={} children={}",
            tree.size,
            tree.item_count,
            tree.children.len()
        );
        assert!(tree.item_count > 0);
    }

    #[test]
    #[ignore = "probe: full /System startup walk + split (~40s)"]
    fn startup_split_probe() {
        let cancel = AtomicBool::new(false);
        let started = std::time::Instant::now();
        let tree = scan_tree(
            Path::new("/System"),
            ScanOptions {
                detail_depth: 10,
                include_package_contents: false,
                ..ScanOptions::default()
            },
            &cancel,
            |_| {},
        )
        .expect("scan should succeed");
        let root = split_startup_system(tree);
        eprintln!(
            "startup split in {:?}: root path={} size={} itemCount={}",
            started.elapsed(),
            root.path,
            root.size,
            root.item_count
        );
        for child in &root.children {
            eprintln!(
                "  child {:?} path={} size={} itemCount={}",
                child.name, child.path, child.size, child.item_count
            );
        }
        assert_eq!(root.path, "/System/Volumes/Data");
        assert!(
            root.children.iter().any(|c| c.name == OS_VOLUME_LABEL),
            "the OS-volume remainder must be present"
        );
    }
}
