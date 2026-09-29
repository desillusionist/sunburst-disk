//! Read-only archive listing for the "Show Package Contents" viewer.
//!
//! Ported from Electron's `listArchiveContents`:
//!   * `.zip` is parsed in-process from the End-Of-Central-Directory and central
//!     directory records (names decoded with the UTF-8 flag and the Info-ZIP
//!     Unicode Path extra field), falling back to `bsdtar` if that fails,
//!   * every other format is listed with `bsdtar -tvf` (argument-safe, no
//!     extraction), falling back to `bsdtar -tf` with a synthetic listing,
//!   * entries are assembled into a virtual tree whose nodes carry
//!     `archive://` paths and `archiveVirtual: true`, so the renderer never
//!     treats them as filesystem paths.

use std::collections::{HashMap, HashSet};
use std::os::unix::fs::MetadataExt;
use std::process::Command;

use crate::commands::is_filesystem_path;
use crate::types::{NodeType, TreeNode};

const ARCHIVE_SUFFIXES: [&str; 13] = [
    ".7z", ".bz2", ".cpio", ".gz", ".iso", ".rar", ".tar", ".tbz", ".tbz2", ".tgz", ".txz", ".xz",
    ".zip",
];

const MAX_ARCHIVE_ENTRIES: usize = 20_000;
const MAX_ARCHIVE_CENTRAL_BYTES: usize = 24 * 1024 * 1024;
const MAX_ARCHIVE_LISTING_BYTES: usize = 24 * 1024 * 1024;
const ZIP_END_SIGNATURE: [u8; 4] = [0x50, 0x4b, 0x05, 0x06];
const ZIP_CENTRAL_SIGNATURE: [u8; 4] = [0x50, 0x4b, 0x01, 0x02];

#[derive(Debug, Clone)]
struct ArchiveEntry {
    name: String,
    size: u64,
    directory: bool,
}

pub(crate) fn is_archive_path(value: &str) -> bool {
    let name = value.trim().to_lowercase();
    ARCHIVE_SUFFIXES.iter().any(|suffix| name.ends_with(suffix))
}

fn basename(path: &str) -> String {
    path.rsplit('/').next().unwrap_or(path).to_string()
}

/// `encodeURIComponent`, so virtual paths match the Electron format exactly.
fn encode_uri_component(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for &byte in value.as_bytes() {
        let character = byte as char;
        if character.is_ascii_alphanumeric()
            || matches!(
                character,
                '-' | '_' | '.' | '!' | '~' | '*' | '\'' | '(' | ')'
            )
        {
            out.push(character);
        } else {
            out.push('%');
            out.push_str(&format!("{byte:02X}"));
        }
    }
    out
}

fn virtual_key(archive_path: &str, relative: &str) -> String {
    format!(
        "archive://{}?entry={}",
        encode_uri_component(archive_path),
        encode_uri_component(relative)
    )
}

struct BuildNode {
    name: String,
    path: String,
    size: u64,
    node_type: NodeType,
    archive_entry: String,
    children: Vec<usize>,
    item_count: u64,
}

/// Assemble entries into the virtual tree, mirroring `buildArchiveTree`.
fn build_archive_tree(entries: &[ArchiveEntry], archive_path: &str) -> TreeNode {
    let mut nodes: Vec<BuildNode> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();

    for entry in entries.iter().take(MAX_ARCHIVE_ENTRIES) {
        let raw = entry.name.replace('\\', "/");
        let raw = raw.trim_start_matches('/');
        let directory = entry.directory || raw.ends_with('/');
        let parts: Vec<&str> = raw.split('/').filter(|part| !part.is_empty()).collect();
        if parts.is_empty()
            || parts.iter().any(|part| {
                *part == "." || *part == ".." || *part == "__MACOSX" || part.starts_with("._")
            })
        {
            continue;
        }

        let mut parent: Option<usize> = None;
        for depth in 0..parts.len() {
            let relative = parts[..=depth].join("/");
            let key = virtual_key(archive_path, &relative);
            let is_last = depth == parts.len() - 1;

            let node_index = match index.get(&key).copied() {
                Some(existing) => {
                    if is_last && !directory {
                        nodes[existing].size = entry.size;
                        nodes[existing].node_type = NodeType::File;
                    }
                    existing
                }
                None => {
                    let created = nodes.len();
                    nodes.push(BuildNode {
                        name: parts[depth].to_string(),
                        path: key.clone(),
                        size: if is_last { entry.size } else { 0 },
                        node_type: if is_last && !directory {
                            NodeType::File
                        } else {
                            NodeType::Directory
                        },
                        archive_entry: relative.clone(),
                        children: Vec::new(),
                        item_count: 0,
                    });
                    index.insert(key, created);
                    created
                }
            };

            if let Some(parent_index) = parent {
                nodes[parent_index].children.push(node_index);
            }
            parent = Some(node_index);
        }
    }

    // Parents were always created before their children, so a reverse pass
    // computes sizes/counts bottom-up.
    for position in (0..nodes.len()).rev() {
        let mut seen: HashSet<String> = HashSet::new();
        let deduped: Vec<usize> = nodes[position]
            .children
            .iter()
            .copied()
            .filter(|child| seen.insert(nodes[*child].path.clone()))
            .collect();
        let mut ordered = deduped;
        ordered.sort_by(|left, right| {
            nodes[*right]
                .size
                .cmp(&nodes[*left].size)
                .then_with(|| nodes[*left].name.cmp(&nodes[*right].name))
        });
        nodes[position].children = ordered;

        if nodes[position].node_type == NodeType::Directory {
            nodes[position].size = nodes[position]
                .children
                .iter()
                .map(|child| nodes[*child].size)
                .sum();
        }
        nodes[position].item_count = nodes[position]
            .children
            .iter()
            .map(|child| 1 + nodes[*child].item_count)
            .sum();
    }

    let mut roots: Vec<usize> = (0..nodes.len())
        .filter(|position| !nodes[*position].archive_entry.contains('/'))
        .collect();
    roots.sort_by(|left, right| {
        nodes[*right]
            .size
            .cmp(&nodes[*left].size)
            .then_with(|| nodes[*left].name.cmp(&nodes[*right].name))
    });

    let children: Vec<TreeNode> = roots
        .iter()
        .map(|position| to_tree(&nodes, *position, archive_path))
        .collect();

    let mut root = TreeNode {
        name: basename(archive_path),
        path: archive_path.to_string(),
        size: children.iter().map(|child| child.size).sum(),
        node_type: NodeType::File,
        archive_container: Some(true),
        item_count: children.iter().map(|child| 1 + child.item_count).sum(),
        ..Default::default()
    };
    root.children = children;
    root
}

fn to_tree(nodes: &[BuildNode], position: usize, archive_path: &str) -> TreeNode {
    let node = &nodes[position];
    TreeNode {
        name: node.name.clone(),
        path: node.path.clone(),
        size: node.size,
        node_type: node.node_type,
        children: node
            .children
            .iter()
            .map(|child| to_tree(nodes, *child, archive_path))
            .collect(),
        item_count: node.item_count,
        archive_virtual: Some(true),
        archive_path: Some(archive_path.to_string()),
        archive_entry: Some(node.archive_entry.clone()),
        ..Default::default()
    }
}

fn mode_ok(mode: &str) -> Option<char> {
    if mode.len() != 10 {
        return None;
    }
    let mut characters = mode.chars();
    let kind = characters.next()?;
    if kind != 'd' && kind != 'l' && kind != '-' {
        return None;
    }
    if !characters.all(|character| "rwxst-".contains(character)) {
        return None;
    }
    Some(kind)
}

/// Parse `bsdtar -tvf` (or a synthetic `-tf`) listing into the virtual tree.
pub(crate) fn parse_archive_listing(stdout: &str, archive_path: &str) -> TreeNode {
    let mut entries = Vec::new();
    for line in stdout.lines() {
        let tokens: Vec<&str> = line.split_whitespace().collect();
        if tokens.len() < 9 {
            continue;
        }
        let Some(kind) = mode_ok(tokens[0]) else {
            continue;
        };
        if tokens[1].parse::<u64>().is_err()
            || tokens[6].parse::<u32>().is_err()
            || !tokens[5]
                .chars()
                .all(|character| character.is_ascii_alphabetic())
        {
            continue;
        }
        let Ok(size) = tokens[4].parse::<u64>() else {
            continue;
        };
        let name = tokens[8..].join(" ");
        let name = name.trim_end_matches('/').trim().to_string();
        if name.is_empty() || name == "." || name.starts_with("../") || name.contains("/../") {
            continue;
        }
        entries.push(ArchiveEntry {
            name,
            size,
            directory: kind == 'd' || line.trim_end().ends_with('/'),
        });
    }
    build_archive_tree(&entries, archive_path)
}

fn read_u16(bytes: &[u8], offset: usize) -> u16 {
    u16::from_le_bytes([bytes[offset], bytes[offset + 1]])
}

fn read_u32(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes([
        bytes[offset],
        bytes[offset + 1],
        bytes[offset + 2],
        bytes[offset + 3],
    ])
}

/// Info-ZIP Unicode Path extra field (0x7075) first, then the raw name.
fn decode_zip_entry_name(name_bytes: &[u8], flags: u16, extra: &[u8]) -> String {
    let mut offset = 0;
    while offset + 4 <= extra.len() {
        let id = read_u16(extra, offset);
        let length = read_u16(extra, offset + 2) as usize;
        let start = offset + 4;
        let end = start + length;
        if end > extra.len() {
            break;
        }
        if id == 0x7075 && length >= 5 && extra[start] == 1 {
            let unicode = String::from_utf8_lossy(&extra[start + 5..end]).into_owned();
            if !unicode.is_empty() {
                return unicode;
            }
        }
        offset = end;
    }
    let utf8 = String::from_utf8_lossy(name_bytes).into_owned();
    if flags & 0x0800 != 0 || !utf8.contains('\u{FFFD}') {
        utf8
    } else {
        name_bytes.iter().map(|&byte| byte as char).collect()
    }
}

/// Parse the central directory of a `.zip` without extracting it.
pub(crate) fn list_zip_contents(archive_path: &str) -> Result<TreeNode, String> {
    let bytes = std::fs::read(archive_path).map_err(|error| error.to_string())?;
    let archive_size = bytes.len();
    if archive_size < 22 {
        return Err("ZIP central directory is missing.".to_string());
    }
    let tail_size = archive_size.min(22 + 65535);
    let tail = &bytes[archive_size - tail_size..];
    let end_offset = tail
        .windows(4)
        .rposition(|window| window == ZIP_END_SIGNATURE)
        .ok_or_else(|| "ZIP central directory is missing.".to_string())?;
    if end_offset + 22 > tail.len() {
        return Err("ZIP central directory is missing.".to_string());
    }

    let total_entries = read_u16(tail, end_offset + 10) as u32;
    let central_size_u32 = read_u32(tail, end_offset + 12);
    let central_offset_u32 = read_u32(tail, end_offset + 16);
    if total_entries == 0xffff
        || central_size_u32 == 0xffff_ffff
        || central_offset_u32 == 0xffff_ffff
    {
        return Err("ZIP64 archives are not supported by the read-only viewer yet.".to_string());
    }
    let central_size = central_size_u32 as usize;
    let central_offset = central_offset_u32 as usize;
    if central_size > MAX_ARCHIVE_CENTRAL_BYTES
        || central_offset
            .checked_add(central_size)
            .map(|end| end > archive_size)
            .unwrap_or(true)
    {
        return Err("ZIP central directory is too large or invalid.".to_string());
    }

    let central = &bytes[central_offset..central_offset + central_size];
    let mut entries: Vec<ArchiveEntry> = Vec::new();
    let mut offset = 0usize;
    while offset + 46 <= central.len() && entries.len() < MAX_ARCHIVE_ENTRIES {
        if central[offset..offset + 4] != ZIP_CENTRAL_SIGNATURE {
            break;
        }
        let flags = read_u16(central, offset + 8);
        let uncompressed_size = read_u32(central, offset + 24) as u64;
        let name_length = read_u16(central, offset + 28) as usize;
        let extra_length = read_u16(central, offset + 30) as usize;
        let comment_length = read_u16(central, offset + 32) as usize;
        let record_end = offset + 46 + name_length + extra_length + comment_length;
        if record_end > central.len() {
            break;
        }
        let name_bytes = &central[offset + 46..offset + 46 + name_length];
        let extra_bytes =
            &central[offset + 46 + name_length..offset + 46 + name_length + extra_length];
        let name = decode_zip_entry_name(name_bytes, flags, extra_bytes);
        if !name.is_empty() {
            entries.push(ArchiveEntry {
                directory: name.ends_with('/'),
                name,
                size: uncompressed_size,
            });
        }
        offset = record_end;
    }
    if entries.is_empty() && total_entries > 0 {
        return Err("ZIP central directory contains no readable entries.".to_string());
    }
    Ok(build_archive_tree(&entries, archive_path))
}

fn run_bsdtar(args: &[&str]) -> Result<String, String> {
    let output = Command::new("/usr/bin/bsdtar")
        .args(args)
        .env("LC_ALL", "en_US.UTF-8")
        .env("LANG", "en_US.UTF-8")
        .env("LC_CTYPE", "en_US.UTF-8")
        .output()
        .map_err(|error| error.to_string())?;
    if output.stdout.len() > MAX_ARCHIVE_LISTING_BYTES {
        return Err("Archive listing is too large to display.".to_string());
    }
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    if !output.status.success() && stdout.trim().is_empty() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "Archive could not be listed".to_string()
        } else {
            stderr
        });
    }
    Ok(stdout)
}

fn list_archive_contents_with_bsdtar(archive_path: &str) -> Result<TreeNode, String> {
    if let Ok(stdout) = run_bsdtar(&["-tvf", archive_path]) {
        let tree = parse_archive_listing(&stdout, archive_path);
        if tree.item_count > 0 {
            return Ok(tree);
        }
    }

    // Fall back to a names-only listing with a synthetic long format.
    let names = run_bsdtar(&["-tf", archive_path])?;
    let synthetic = names
        .lines()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(|name| format!("-rw-r--r-- 1 owner group 0 Jan 01 00:00 {name}"))
        .collect::<Vec<_>>()
        .join("\n");
    let tree = parse_archive_listing(&synthetic, archive_path);
    if tree.item_count == 0 {
        return Err("Archive contains no readable entries.".to_string());
    }
    Ok(tree)
}

/// List any supported archive; `.zip` is tried in-process first.
pub(crate) fn list_archive_contents(archive_path: &str) -> Result<TreeNode, String> {
    if archive_path.to_lowercase().ends_with(".zip") {
        list_zip_contents(archive_path).or_else(|_| list_archive_contents_with_bsdtar(archive_path))
    } else {
        list_archive_contents_with_bsdtar(archive_path)
    }
}

/// Validate, list, then override the root row with the archive file's own
/// size/mtime (matching the Electron `scan-archive` handler).
pub(crate) fn scan(archive_path: &str) -> Result<TreeNode, String> {
    if !is_filesystem_path(archive_path) || !is_archive_path(archive_path) {
        return Err("Unsupported archive path".to_string());
    }
    let metadata = std::fs::symlink_metadata(archive_path).map_err(|error| error.to_string())?;
    if !metadata.is_file() {
        return Err("Archive preview requires a regular file".to_string());
    }
    let mut tree = list_archive_contents(archive_path)?;
    tree.size = metadata.len();
    tree.modified_at =
        Some(metadata.mtime() as f64 * 1000.0 + metadata.mtime_nsec() as f64 / 1_000_000.0);
    Ok(tree)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_archive_suffixes() {
        assert!(is_archive_path("/a/b.zip"));
        assert!(is_archive_path("/a/b.TAR.GZ"));
        assert!(is_archive_path("/a/b.tgz"));
        assert!(!is_archive_path("/a/b.txt"));
        assert!(!is_archive_path("/a/b"));
    }

    #[test]
    fn virtual_paths_match_encode_uri_component() {
        assert_eq!(
            encode_uri_component("/Users/me/a b.zip"),
            "%2FUsers%2Fme%2Fa%20b.zip"
        );
        assert_eq!(encode_uri_component("dir/file.txt"), "dir%2Ffile.txt");
        assert_eq!(
            virtual_key("/a.zip", "dir/x"),
            "archive://%2Fa.zip?entry=dir%2Fx"
        );
    }

    #[test]
    fn parses_bsdtar_long_listing() {
        let listing = "\
drwxr-xr-x  0 user group       0 Jan 01 2020 dir/
-rw-r--r--  0 user group    1234 Jan 01 2020 dir/file.txt
-rw-r--r--  0 user group      10 Jan 01 2020 top.txt
";
        let tree = parse_archive_listing(listing, "/tmp/a.zip");
        assert_eq!(tree.item_count, 3);
        assert_eq!(tree.children.len(), 2);
        // dir/ aggregates its child.
        let dir = tree
            .children
            .iter()
            .find(|child| child.name == "dir")
            .expect("dir entry");
        assert_eq!(dir.size, 1234);
        assert_eq!(dir.item_count, 1);
        assert_eq!(dir.children[0].name, "file.txt");
        assert_eq!(dir.children[0].node_type, NodeType::File);
        assert_eq!(dir.children[0].archive_virtual, Some(true));
        assert!(dir.children[0].path.starts_with("archive://"));
    }

    #[test]
    fn builds_tree_from_entries_with_sizes() {
        let entries = vec![
            ArchiveEntry {
                name: "a/b/c.txt".to_string(),
                size: 5,
                directory: false,
            },
            ArchiveEntry {
                name: "a/d.txt".to_string(),
                size: 7,
                directory: false,
            },
            ArchiveEntry {
                name: "a/".to_string(),
                size: 0,
                directory: true,
            },
        ];
        let tree = build_archive_tree(&entries, "/tmp/x.zip");
        assert_eq!(tree.children.len(), 1);
        let a = &tree.children[0];
        assert_eq!(a.name, "a");
        assert_eq!(a.size, 12);
        assert_eq!(a.item_count, 3);
        // Children sorted largest first: d.txt (7) before b (5).
        assert_eq!(a.children[0].name, "d.txt");
        assert_eq!(a.children[1].name, "b");
    }

    #[test]
    fn skips_macos_and_parent_entries() {
        let listing = "\
-rw-r--r--  0 user group  1 Jan 01 2020 __MACOSX/junk
-rw-r--r--  0 user group  1 Jan 01 2020 ._resource
-rw-r--r--  0 user group  1 Jan 01 2020 ../escape
-rw-r--r--  0 user group  9 Jan 01 2020 keep.txt
";
        let tree = parse_archive_listing(listing, "/tmp/a.zip");
        assert_eq!(tree.item_count, 1);
        assert_eq!(tree.children[0].name, "keep.txt");
    }

    #[test]
    fn decodes_unicode_path_extra_field() {
        // 0x7075, length 11, version 1, CRC(4), then UTF-8 name "é.txt" (6 bytes).
        let name_bytes = b"e.txt";
        let mut extra = vec![0x75, 0x70, 0x0b, 0x00, 0x01, 0, 0, 0, 0];
        extra.extend_from_slice("é.txt".as_bytes());
        let decoded = decode_zip_entry_name(name_bytes, 0, &extra);
        assert_eq!(decoded, "é.txt");
    }

    #[test]
    #[ignore = "creates a real zip on disk; run with --ignored"]
    fn reads_a_real_zip() {
        let dir = std::env::temp_dir().join(format!("sunburst-zip-probe-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("nested")).expect("temp dir should be writable");
        std::fs::write(dir.join("nested/hello.txt"), b"hello world").unwrap();
        std::fs::write(dir.join("top.txt"), b"top").unwrap();

        let status = std::process::Command::new("/usr/bin/zip")
            .current_dir(&dir)
            .args(["-r", "-q", "sample.zip", "nested", "top.txt"])
            .status()
            .expect("zip should run");
        assert!(status.success(), "zip creation failed");

        let zip_path = dir.join("sample.zip");
        let tree = list_zip_contents(zip_path.to_str().unwrap()).expect("zip should parse");
        let _ = std::fs::remove_dir_all(&dir);

        let names: Vec<&str> = tree
            .children
            .iter()
            .map(|child| child.name.as_str())
            .collect();
        assert!(names.contains(&"nested"), "names: {names:?}");
        assert!(names.contains(&"top.txt"), "names: {names:?}");
        let nested = tree.children.iter().find(|c| c.name == "nested").unwrap();
        assert_eq!(nested.children[0].name, "hello.txt");
        assert_eq!(nested.children[0].size, 11);
        assert_eq!(nested.children[0].node_type, NodeType::File);
    }
}
