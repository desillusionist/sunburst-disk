//! File metadata inspection for the Details sidebar.
//!
//! Ported from `inspectPath` / `classifyFileExtension` / `readMediaMetadata`,
//! including the `mdls` media probe. `inspect_many` fans the per-item work out
//! across a few threads (the Electron version used `Promise.all`).

use std::collections::{HashMap, HashSet};
use std::ffi::CString;
use std::os::macos::fs::MetadataExt as MacMetadataExt;
use std::os::unix::fs::MetadataExt;
use std::process::Command;

use serde::{Deserialize, Serialize};

use crate::commands::is_filesystem_path;

/// Extension-to-category table, in evaluation order (first match wins).
const CLASS_TABLE: [(&str, &[&str]); 8] = [
    (
        "audio",
        &[
            ".aac", ".aiff", ".alac", ".caf", ".flac", ".m4a", ".m4b", ".mp3", ".oga", ".ogg",
            ".opus", ".wav", ".wma",
        ],
    ),
    (
        "video",
        &[
            ".3gp", ".avi", ".flv", ".m2ts", ".m4v", ".mkv", ".mov", ".mp4", ".mpeg", ".mpg",
            ".ts", ".webm", ".wmv",
        ],
    ),
    (
        "image",
        &[
            ".avif", ".bmp", ".gif", ".heic", ".heif", ".ico", ".jpeg", ".jpg", ".png", ".raw",
            ".svg", ".tif", ".tiff", ".webp",
        ],
    ),
    (
        "archive",
        &[
            ".7z", ".bz2", ".gz", ".iso", ".rar", ".tar", ".tbz", ".tgz", ".xz", ".zip",
        ],
    ),
    (
        "text",
        &[
            ".c", ".cc", ".conf", ".cpp", ".css", ".csv", ".h", ".hpp", ".html", ".ini", ".java",
            ".js", ".json", ".jsx", ".log", ".md", ".plist", ".py", ".rb", ".rs", ".sh", ".sql",
            ".swift", ".toml", ".ts", ".tsx", ".txt", ".xml", ".yaml", ".yml",
        ],
    ),
    (
        "document",
        &[
            ".doc", ".docx", ".epub", ".key", ".numbers", ".pages", ".pdf", ".ppt", ".pptx",
            ".rtf", ".xls", ".xlsx",
        ],
    ),
    ("font", &[".otf", ".ttf", ".woff", ".woff2"]),
    ("database", &[".db", ".db3", ".sqlite", ".sqlite3"]),
];

const MEDIA_MDLS_NAMES: [&str; 10] = [
    "kMDItemContentType",
    "kMDItemPixelWidth",
    "kMDItemPixelHeight",
    "kMDItemDurationSeconds",
    "kMDItemVideoCodec",
    "kMDItemAudioCodec",
    "kMDItemAudioSampleRate",
    "kMDItemAudioBitRate",
    "kMDItemAudioChannelCount",
    "kMDItemAudioBitsPerSample",
];

const MAX_INSPECT_ITEMS: usize = 300;
const MAX_INSPECT_THREADS: usize = 8;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MediaMetadata {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pixel_width: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pixel_height: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_seconds: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub video_codec: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio_codec: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sample_rate: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio_bit_rate: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio_channels: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio_bits_per_sample: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ItemAccess {
    pub readable: bool,
    pub writable: bool,
    pub executable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ItemMetadata {
    #[serde(rename = "type")]
    pub item_type: String,
    pub classification: String,
    pub extension: String,
    pub media: MediaMetadata,
    pub logical_size: Option<u64>,
    pub created_at: Option<f64>,
    pub modified_at: Option<f64>,
    pub access: ItemAccess,
    pub permissions: String,
    pub accounting_model: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct InspectItemResponse {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<ItemMetadata>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Node's `path.extname`: the last dot-suffix, lowercased, including the dot.
/// A leading dot (hidden files) is not treated as an extension.
pub(crate) fn extension_of(path: &str) -> String {
    let name = path.rsplit('/').next().unwrap_or(path);
    match name.rfind('.') {
        Some(index) if index > 0 => name[index..].to_lowercase(),
        _ => String::new(),
    }
}

/// Returns `(category, extension)` mirroring `classifyFileExtension`.
pub(crate) fn classify(path: &str) -> (String, String) {
    let extension = extension_of(path);
    for (category, extensions) in CLASS_TABLE {
        if extensions.contains(&extension.as_str()) {
            return (category.to_string(), extension);
        }
    }
    let category = if extension == ".app" {
        "application package"
    } else {
        "other"
    };
    (category.to_string(), extension)
}

/// Parse `mdls` `key = value` output, dropping nulls and unquoting strings.
pub(crate) fn parse_mdls(stdout: &str) -> HashMap<String, String> {
    let mut values = HashMap::new();
    for line in stdout.lines() {
        let Some(equals) = line.find('=') else {
            continue;
        };
        let key = line[..equals].trim();
        if key.is_empty()
            || !key
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || character == '_')
        {
            continue;
        }
        let mut value = line[equals + 1..].trim().to_string();
        if value == "(null)" {
            continue;
        }
        if value.len() >= 2 && value.starts_with('"') && value.ends_with('"') {
            value = value[1..value.len() - 1].to_string();
        }
        values.insert(key.to_string(), value);
    }
    values
}

fn access_ok(path: &str, mode: libc::c_int) -> bool {
    let Ok(c_path) = CString::new(path) else {
        return false;
    };
    unsafe { libc::access(c_path.as_ptr(), mode) == 0 }
}

fn read_media_metadata(path: &str, category: &str) -> MediaMetadata {
    if !matches!(category, "audio" | "video" | "image") {
        return MediaMetadata::default();
    }

    let mut args: Vec<String> = Vec::with_capacity(MEDIA_MDLS_NAMES.len() * 2 + 1);
    for name in MEDIA_MDLS_NAMES {
        args.push("-name".to_string());
        args.push(name.to_string());
    }
    args.push(path.to_string());

    let output = match Command::new("/usr/bin/mdls").args(&args).output() {
        Ok(output) if output.status.success() => output,
        _ => return MediaMetadata::default(),
    };

    let raw = parse_mdls(&String::from_utf8_lossy(&output.stdout));
    let number = |key: &str| {
        raw.get(key)
            .and_then(|value| value.parse::<f64>().ok())
            .filter(|value| value.is_finite())
    };

    MediaMetadata {
        content_type: raw.get("kMDItemContentType").cloned(),
        pixel_width: number("kMDItemPixelWidth"),
        pixel_height: number("kMDItemPixelHeight"),
        duration_seconds: number("kMDItemDurationSeconds"),
        video_codec: raw.get("kMDItemVideoCodec").cloned(),
        audio_codec: raw.get("kMDItemAudioCodec").cloned(),
        sample_rate: number("kMDItemAudioSampleRate"),
        audio_bit_rate: number("kMDItemAudioBitRate"),
        audio_channels: number("kMDItemAudioChannelCount"),
        audio_bits_per_sample: number("kMDItemAudioBitsPerSample"),
    }
}

fn millis(seconds: i64, nanos: i64) -> f64 {
    seconds as f64 * 1000.0 + nanos as f64 / 1_000_000.0
}

/// Inspect one path; `None` mirrors Electron's `null` (unreadable or invalid).
pub(crate) fn inspect_path(item_path: &str) -> Option<ItemMetadata> {
    if !is_filesystem_path(item_path) {
        return None;
    }
    let metadata = std::fs::symlink_metadata(item_path).ok()?;
    let file_type = metadata.file_type();
    let is_dir = file_type.is_dir();
    let is_symlink = file_type.is_symlink();

    let (classification, extension) = if is_dir {
        ("folder".to_string(), String::new())
    } else {
        classify(item_path)
    };
    let media = if is_dir {
        MediaMetadata::default()
    } else {
        read_media_metadata(item_path, &classification)
    };

    let created = {
        let birth = millis(metadata.st_birthtime(), metadata.st_birthtime_nsec());
        if birth > 0.0 {
            birth
        } else {
            millis(metadata.ctime(), metadata.ctime_nsec())
        }
    };

    Some(ItemMetadata {
        item_type: if is_dir {
            "directory"
        } else if is_symlink {
            "symlink"
        } else {
            "file"
        }
        .to_string(),
        classification,
        extension: if extension.is_empty() {
            String::new()
        } else {
            extension.to_uppercase()
        },
        media,
        logical_size: if is_dir { None } else { Some(metadata.len()) },
        created_at: Some(created),
        modified_at: Some(millis(metadata.mtime(), metadata.mtime_nsec())),
        access: ItemAccess {
            readable: access_ok(item_path, libc::R_OK),
            writable: access_ok(item_path, libc::W_OK),
            executable: access_ok(item_path, libc::X_OK),
        },
        permissions: format!("{:03o}", metadata.mode() & 0o777),
        accounting_model: if is_dir {
            "Filesystem allocation (du)"
        } else {
            "Allocated blocks (du)"
        }
        .to_string(),
    })
}

/// Inspect a batch (deduplicated, capped at 300) across a few threads.
pub(crate) fn inspect_many(paths: Vec<String>) -> HashMap<String, ItemMetadata> {
    let mut unique: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for path in paths {
        if unique.len() >= MAX_INSPECT_ITEMS {
            break;
        }
        if is_filesystem_path(&path) && seen.insert(path.clone()) {
            unique.push(path);
        }
    }
    if unique.is_empty() {
        return HashMap::new();
    }

    let thread_count = unique.len().min(MAX_INSPECT_THREADS);
    let mut buckets: Vec<Vec<String>> = (0..thread_count).map(|_| Vec::new()).collect();
    for (index, path) in unique.into_iter().enumerate() {
        buckets[index % thread_count].push(path);
    }

    std::thread::scope(|scope| {
        let handles: Vec<_> = buckets
            .into_iter()
            .map(|bucket| {
                scope.spawn(move || {
                    bucket
                        .into_iter()
                        .filter_map(|path| inspect_path(&path).map(|metadata| (path, metadata)))
                        .collect::<Vec<_>>()
                })
            })
            .collect();

        handles
            .into_iter()
            .flat_map(|handle| handle.join().unwrap_or_default())
            .collect()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extension_matches_node_extname() {
        assert_eq!(extension_of("/a/b/Picture.JPG"), ".jpg");
        assert_eq!(extension_of("/a/b/archive.tar.gz"), ".gz");
        assert_eq!(extension_of("/a/b/.gitignore"), "");
        assert_eq!(extension_of("/a/b/README"), "");
    }

    #[test]
    fn classification_uses_ordered_table() {
        assert_eq!(classify("song.mp3").0, "audio");
        assert_eq!(classify("clip.MP4").0, "video");
        assert_eq!(classify("photo.heic").0, "image");
        assert_eq!(classify("notes.txt").0, "text");
        assert_eq!(classify("report.pdf").0, "document");
        assert_eq!(classify("Safari.app").0, "application package");
        assert_eq!(classify("mystery.bin").0, "other");
        // Extension is surfaced uppercased with its dot for the sidebar.
        assert_eq!(classify("song.mp3").1, ".mp3");
    }

    #[test]
    fn mdls_output_is_parsed_and_nulls_dropped() {
        let stdout = "kMDItemPixelWidth               = 1920\nkMDItemDurationSeconds          = 12.5\nkMDItemVideoCodec               = (null)\nkMDItemContentType              = \"public.mpeg-4\"\n";
        let values = parse_mdls(stdout);
        assert_eq!(
            values.get("kMDItemPixelWidth").map(String::as_str),
            Some("1920")
        );
        assert_eq!(
            values.get("kMDItemDurationSeconds").map(String::as_str),
            Some("12.5")
        );
        assert_eq!(
            values.get("kMDItemContentType").map(String::as_str),
            Some("public.mpeg-4")
        );
        assert!(!values.contains_key("kMDItemVideoCodec"));
    }

    #[test]
    fn inspects_a_real_file_and_directory() {
        let dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src");
        let dir_meta = inspect_path(&dir.to_string_lossy()).expect("directory should inspect");
        assert_eq!(dir_meta.item_type, "directory");
        assert_eq!(dir_meta.classification, "folder");
        assert!(dir_meta.logical_size.is_none());
        assert_eq!(dir_meta.permissions.len(), 3);

        let file = dir.join("main.rs");
        let file_meta = inspect_path(&file.to_string_lossy()).expect("file should inspect");
        assert_eq!(file_meta.item_type, "file");
        assert_eq!(file_meta.classification, "text");
        assert_eq!(file_meta.extension, ".RS");
        assert!(file_meta.logical_size.unwrap_or(0) > 0);
        assert!(file_meta.access.readable);
    }

    #[test]
    fn inspect_many_skips_invalid_paths() {
        let results = inspect_many(vec![
            "/definitely/not/here/xyz".to_string(),
            "relative/path".to_string(),
        ]);
        assert!(results.is_empty());
    }
}
