//! Cloud storage survey (read-only).
//!
//! Lists the cloud providers reachable from this Mac — FileProvider domains under
//! `~/Library/CloudStorage` plus iCloud Drive — and measures, for each, the size
//! the content *would* take in the cloud (logical bytes, including dataless
//! placeholders) against what it actually costs locally (`st_blocks`). It also
//! measures the local state each cloud client keeps, which is real disk space.
//!
//! Nothing is ever read: files are only `lstat`ed, so dataless placeholders are
//! never materialised (reading them is what used to hang Smart Clean). Every walk
//! is bounded by an entry budget and a wall-clock deadline, and cloud domains are
//! enumerated deliberately here — the main scanner prunes them for exactly the
//! reason that makes this command careful.

use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::smart_clean::epoch_ms_to_iso;

/// Hard limits for one walk: entries visited, recursion depth, and wall clock.
const MAX_ENTRIES: usize = 30_000;
const MAX_DEPTH: usize = 24;
const DEADLINE: Duration = Duration::from_secs(5);
/// Files at least this large are considered for the "largest locally" list.
const LARGEST_MIN_BYTES: u64 = 1_000_000;
const LARGEST_ITEMS_PER_PROVIDER: usize = 5;
const MAX_TRACKED_ITEMS: usize = 400;

struct Totals {
    cloud_bytes: u64,
    local_bytes: u64,
    files: u64,
    dataless: u64,
    truncated: bool,
    readable: bool,
}

/// Walk `root` once, separating logical ("cloud") bytes from on-disk bytes.
/// Returns the totals and the largest locally-stored files, newest-first by size.
fn walk(root: &Path, deadline: Instant) -> (Totals, Vec<(u64, String)>) {
    let mut totals = Totals {
        cloud_bytes: 0,
        local_bytes: 0,
        files: 0,
        dataless: 0,
        truncated: false,
        readable: false,
    };
    let mut largest: Vec<(u64, String)> = Vec::new();

    let Ok(start) = std::fs::symlink_metadata(root) else {
        return (totals, largest);
    };
    let root_device = start.dev();
    let mut stack: Vec<(PathBuf, usize)> = vec![(root.to_path_buf(), 0)];
    let mut visited: usize = 0;

    while let Some((directory, depth)) = stack.pop() {
        if visited >= MAX_ENTRIES || Instant::now() > deadline {
            totals.truncated = true;
            break;
        }
        let Ok(read_dir) = std::fs::read_dir(&directory) else {
            continue;
        };
        totals.readable = true;
        for entry in read_dir.flatten() {
            if visited >= MAX_ENTRIES || Instant::now() > deadline {
                totals.truncated = true;
                break;
            }
            visited += 1;
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_symlink() {
                continue;
            }
            let Ok(metadata) = entry.metadata() else {
                continue;
            };
            // Stay on one filesystem so a mount point inside a provider domain
            // cannot pull in unrelated volumes.
            if metadata.dev() != root_device {
                continue;
            }
            let local = metadata.blocks().saturating_mul(512);
            if file_type.is_dir() {
                totals.local_bytes = totals.local_bytes.saturating_add(local);
                if depth < MAX_DEPTH {
                    stack.push((entry.path(), depth + 1));
                }
                continue;
            }
            if !file_type.is_file() {
                continue;
            }
            let logical = metadata.len();
            totals.files += 1;
            totals.cloud_bytes = totals.cloud_bytes.saturating_add(logical);
            totals.local_bytes = totals.local_bytes.saturating_add(local);
            if logical > 0 && local == 0 {
                totals.dataless += 1;
            }
            if local >= LARGEST_MIN_BYTES && largest.len() < MAX_TRACKED_ITEMS {
                largest.push((local, entry.path().to_string_lossy().into_owned()));
            }
        }
    }

    largest.sort_by_key(|item| std::cmp::Reverse(item.0));
    largest.truncate(LARGEST_ITEMS_PER_PROVIDER);
    (totals, largest)
}

/// Turn a `~/Library/CloudStorage` directory name into a display name.
fn friendly_provider(directory_name: &str) -> (String, String) {
    const KNOWN: [(&str, &str); 6] = [
        ("GoogleDrive", "Google Drive"),
        ("OneDrive", "OneDrive"),
        ("Dropbox", "Dropbox"),
        ("Box", "Box"),
        ("pCloud", "pCloud"),
        ("SharePoint", "SharePoint"),
    ];
    for (prefix, label) in KNOWN {
        if let Some(rest) = directory_name.strip_prefix(prefix) {
            let rest = rest.trim_start_matches(['-', '_', ' ']);
            return (label.to_string(), rest.to_string());
        }
    }
    (directory_name.to_string(), String::new())
}

struct Provider {
    id: String,
    name: String,
    kind: &'static str,
    path: PathBuf,
}

fn provider_domains(home: &Path) -> Vec<Provider> {
    let mut providers = Vec::new();

    let cloud_root = home.join("Library").join("CloudStorage");
    if let Ok(read_dir) = std::fs::read_dir(&cloud_root) {
        let mut entries: Vec<std::fs::DirEntry> = read_dir.flatten().collect();
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            if !entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
                continue;
            }
            let directory_name = entry.file_name().to_string_lossy().into_owned();
            if directory_name.starts_with('.') {
                continue;
            }
            let (label, account) = friendly_provider(&directory_name);
            let name = if account.is_empty() {
                label
            } else {
                format!("{label} — {account}")
            };
            providers.push(Provider {
                id: directory_name,
                name,
                kind: "provider",
                path: entry.path(),
            });
        }
    }

    // iCloud Drive proper. The sibling `iCloud~*` entries are per-app containers,
    // not user-visible Drive content, so they are intentionally excluded.
    let icloud = home
        .join("Library")
        .join("Mobile Documents")
        .join("com~apple~CloudDocs");
    if icloud.is_dir() {
        providers.push(Provider {
            id: "icloud-drive".to_string(),
            name: "iCloud Drive".to_string(),
            kind: "icloud",
            path: icloud,
        });
    }

    providers
}

/// Local state each cloud client keeps. Real disk space, but indexes and caches
/// rather than pure cache, so it is reported and never offered for deletion.
const CLIENT_STATE: [(&str, &str, &str); 5] = [
    (
        "google-drive-client",
        "Google Drive client (indexes and cache)",
        "Library/Application Support/Google",
    ),
    (
        "dropbox-client",
        "Dropbox client (indexes and cache)",
        "Library/Application Support/Dropbox",
    ),
    (
        "onedrive-client",
        "OneDrive client (indexes and cache)",
        "Library/Application Support/OneDrive",
    ),
    (
        "box-client",
        "Box client (indexes and cache)",
        "Library/Application Support/Box",
    ),
    (
        "icloud-clouddocs",
        "iCloud CloudDocs daemon cache",
        "Library/Caches/com.apple.bird",
    ),
];

/// True when iCloud is also syncing the home Desktop/Documents folders, which
/// means those bytes show up in both the home scan and the iCloud Drive total.
fn shares_home_folders(home: &Path) -> bool {
    let cloud_documents = home
        .join("Library")
        .join("Mobile Documents")
        .join("com~apple~CloudDocs")
        .join("Documents");
    let local_documents = home.join("Documents");
    match (
        std::fs::metadata(&cloud_documents),
        std::fs::metadata(&local_documents),
    ) {
        // `metadata` follows symlinks on purpose: iCloud implements this by making
        // `com~apple~CloudDocs/Documents` a symlink to `~/Documents`.
        (Ok(cloud), Ok(local)) => cloud.dev() == local.dev() && cloud.ino() == local.ino(),
        _ => false,
    }
}

fn bytes_json(value: u64) -> Value {
    json!(value)
}

fn largest_json(largest: &[(u64, String)]) -> Value {
    Value::Array(
        largest
            .iter()
            .map(|(size, path)| {
                json!({
                    "path": path,
                    "name": path.rsplit('/').next().unwrap_or(path),
                    "localBytes": bytes_json(*size),
                })
            })
            .collect(),
    )
}

/// Read-only survey of the cloud providers reachable from this Mac.
///
/// This is the slow half (streaming providers enumerate lazily), so the renderer
/// asks for it separately from [`client_state`] and can show that first.
pub(crate) fn survey_providers() -> Value {
    let home = crate::capacity::resolve_path(&std::env::var("HOME").unwrap_or_default());
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0);

    let mut providers = Vec::new();
    for provider in provider_domains(&home) {
        let deadline = Instant::now() + DEADLINE;
        let (totals, largest) = walk(&provider.path, deadline);
        providers.push(json!({
            "id": provider.id,
            "name": provider.name,
            "kind": provider.kind,
            "path": provider.path.to_string_lossy(),
            "cloudBytes": bytes_json(totals.cloud_bytes),
            "localBytes": bytes_json(totals.local_bytes),
            "files": totals.files,
            "dataless": totals.dataless,
            "truncated": totals.truncated,
            "readable": totals.readable,
            "largest": largest_json(&largest),
        }));
    }

    json!({
        "ok": true,
        "scannedAt": epoch_ms_to_iso(now_ms),
        "sharesHomeFolders": shares_home_folders(&home),
        "providers": providers,
        "notes": [
            "Cloud sizes are approximate: a provider lists only what has been browsed locally, and macOS reports a placeholder's full size without downloading it. Figures marked partial stopped at a time limit.",
            "Local footprint is what those files actually cost on this Mac (on-disk blocks).",
            "This panel is read-only. To free local space, use Finder or the provider's own app.",
        ],
    })
}

/// Local state the cloud clients keep. This is real disk space, so it is the
/// fastest and most actionable half of the survey.
pub(crate) fn client_state() -> Value {
    let home = crate::capacity::resolve_path(&std::env::var("HOME").unwrap_or_default());
    let mut entries = Vec::new();
    for (id, name, relative) in CLIENT_STATE {
        let path = home.join(relative);
        if !path.exists() {
            continue;
        }
        let deadline = Instant::now() + DEADLINE;
        let (totals, _) = walk(&path, deadline);
        entries.push(json!({
            "id": id,
            "name": name,
            "path": path.to_string_lossy(),
            "localBytes": bytes_json(totals.local_bytes),
            "files": totals.files,
            "truncated": totals.truncated,
            "readable": totals.readable,
        }));
    }
    json!({ "ok": true, "clientState": entries })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "probe: real cloud survey over the user's providers"]
    fn cloud_survey_probe() {
        eprintln!(
            "providers: {}",
            serde_json::to_string_pretty(&survey_providers()).expect("providers serialise")
        );
        eprintln!(
            "client state: {}",
            serde_json::to_string_pretty(&client_state()).expect("client state serialises")
        );
    }

    #[test]
    fn known_providers_get_friendly_names() {
        assert_eq!(
            friendly_provider("GoogleDrive-alex@example.com"),
            ("Google Drive".to_string(), "alex@example.com".to_string())
        );
        assert_eq!(
            friendly_provider("OneDrive-Personal"),
            ("OneDrive".to_string(), "Personal".to_string())
        );
        assert_eq!(
            friendly_provider("Dropbox"),
            ("Dropbox".to_string(), String::new())
        );
        assert_eq!(
            friendly_provider("SomeApp-123"),
            ("SomeApp-123".to_string(), String::new())
        );
    }

    #[test]
    fn walk_separates_cloud_and_local_bytes() {
        let base = std::env::temp_dir().join(format!("sunburst-cloud-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("nested")).expect("fixture directory");
        std::fs::write(base.join("real.bin"), vec![1u8; 8192]).expect("fixture file");
        let placeholder = base.join("nested").join("placeholder.bin");
        let file = std::fs::File::create(&placeholder).expect("fixture placeholder");
        file.set_len(4 * 1024 * 1024).expect("sparse length");
        drop(file);

        let (totals, largest) = walk(&base, Instant::now() + Duration::from_secs(5));

        assert_eq!(totals.files, 2);
        assert_eq!(totals.dataless, 1, "the sparse placeholder is dataless");
        assert!(
            totals.cloud_bytes >= 4 * 1024 * 1024 + 8192,
            "logical sizes of both files must be counted, got {}",
            totals.cloud_bytes
        );
        assert!(
            totals.local_bytes < 1_000_000,
            "a placeholder with no blocks must not count locally, got {}",
            totals.local_bytes
        );
        assert!(totals.readable);
        assert!(!totals.truncated);
        assert!(
            largest.is_empty(),
            "8 KiB is below the largest-items threshold"
        );

        let _ = std::fs::remove_dir_all(&base);
    }
}
