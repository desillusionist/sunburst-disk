//! Smart Clean preview.
//!
//! Ported from `smart-clean-preview`: a conservative, read-only survey of
//! regenerable caches/logs, restorable state, stale downloads, old installers,
//! screenshots, Trash, and duplicate files (by size + sampled SHA-256). Nothing
//! is modified; results are candidates the user must explicitly export.

use std::collections::{HashMap, VecDeque};
use std::os::unix::fs::MetadataExt;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::capacity::run_capture;
use crate::commands::{is_filesystem_path, is_protected_system_path};

const MAX_ENTRIES_PER_ROOT: usize = 120;
const MAX_CANDIDATES: usize = 300;
const MAX_DUPLICATE_FILES: usize = 400;
const OLD_ARTIFACT_MS: i64 = 30 * 24 * 60 * 60 * 1000;
const STALE_DOWNLOAD_MS: i64 = 7 * 24 * 60 * 60 * 1000;
const LARGE_DOWNLOAD_BYTES: u64 = 50 * 1000 * 1000;
const SAMPLE_BYTES: u64 = 64 * 1024;

const SENSITIVE_SEGMENTS: [&str; 7] = [
    "Mail",
    "Messages",
    "Photos Library.photoslibrary",
    "Containers",
    "Group Containers",
    "Application Support",
    "CloudStorage",
];

/// `(id, label, relative, reason, risk, mode)`
struct RootDef {
    id: &'static str,
    label: &'static str,
    relative: &'static [&'static str],
    reason: &'static str,
    risk: &'static str,
    mode: &'static str,
}

const ROOT_DEFS: &[RootDef] = &[
    RootDef { id: "user-caches", label: "User caches", relative: &["Library", "Caches"], reason: "Temporary application cache data that can usually be regenerated.", risk: "safe", mode: "all" },
    RootDef { id: "user-logs", label: "User logs", relative: &["Library", "Logs"], reason: "Diagnostic logs that may be removed after review.", risk: "safe", mode: "all" },
    RootDef { id: "saved-state", label: "Saved application state", relative: &["Library", "Saved Application State"], reason: "Restorable application session state; review the owning app first.", risk: "review", mode: "all" },
    RootDef { id: "developer-derived-data", label: "Xcode DerivedData", relative: &["Library", "Developer", "Xcode", "DerivedData"], reason: "Regenerable Xcode build products and indexes.", risk: "safe", mode: "all" },
    RootDef { id: "developer-simulator-caches", label: "Simulator caches", relative: &["Library", "Developer", "CoreSimulator", "Caches"], reason: "Regenerable simulator cache data.", risk: "safe", mode: "all" },
    RootDef { id: "incomplete-downloads", label: "Incomplete downloads", relative: &["Downloads"], reason: "Stale partial downloads that appear interrupted; verify before removing.", risk: "review", mode: "incomplete" },
    RootDef { id: "installer-artifacts", label: "Old installer artifacts", relative: &["Downloads"], reason: "Older DMG, PKG or archive installers that may be re-downloadable.", risk: "review", mode: "installers" },
    RootDef { id: "large-downloads", label: "Large Downloads", relative: &["Downloads"], reason: "Large personal download; review whether it is still needed before freeing space.", risk: "review", mode: "large-downloads" },
    RootDef { id: "screenshots", label: "Old screenshots", relative: &["Desktop"], reason: "Screenshot-like files older than 30 days; these are personal files and require review.", risk: "review", mode: "screenshots" },
    RootDef { id: "picture-screenshots", label: "Old screenshots", relative: &["Pictures", "Screenshots"], reason: "Screenshot files older than 30 days; these are personal files and require review.", risk: "review", mode: "screenshots" },
    RootDef { id: "trash", label: "Trash", relative: &[".Trash"], reason: "Items already placed in the user Trash; review before emptying because they may still be recoverable.", risk: "review", mode: "trash" },
    // Local language-model weights. Large, but re-downloadable by their tool.
    RootDef { id: "model-huggingface", label: "Hugging Face models", relative: &[".cache", "huggingface"], reason: "Local language-model weights downloaded from Hugging Face; large but re-downloadable.", risk: "review", mode: "all" },
    RootDef { id: "model-ollama", label: "Ollama models", relative: &[".ollama", "models"], reason: "Local language-model weights pulled by Ollama; re-downloadable with `ollama pull`.", risk: "review", mode: "all" },
    RootDef { id: "model-lmstudio", label: "LM Studio models", relative: &[".lmstudio", "models"], reason: "Local language-model weights managed by LM Studio; re-downloadable.", risk: "review", mode: "all" },
    RootDef { id: "model-whisper", label: "Whisper models", relative: &[".cache", "whisper"], reason: "Downloaded speech-recognition models; re-downloadable.", risk: "review", mode: "all" },
    RootDef { id: "model-gpt4all", label: "GPT4All models", relative: &["Library", "Application Support", "nomic.ai", "GPT4All"], reason: "Local language-model weights bundled with GPT4All; re-downloadable.", risk: "review", mode: "all" },
    // Old backups, including Apple device backups.
    RootDef { id: "ios-backups", label: "iOS device backups", relative: &["Library", "Application Support", "MobileSync", "Backup"], reason: "Finder/iTunes backups of iPhone and iPad devices; deleting removes restore points.", risk: "review", mode: "all" },
    // Xcode simulator systems and device support (regenerated/re-downloaded by Xcode).
    RootDef { id: "simulator-devices", label: "Simulator devices", relative: &["Library", "Developer", "CoreSimulator", "Devices"], reason: "Deployed simulator systems and device state used by Xcode for testing.", risk: "review", mode: "all" },
    RootDef { id: "simulator-runtimes", label: "Simulator runtimes", relative: &["Library", "Developer", "CoreSimulator", "Images"], reason: "Downloaded simulator runtime images; Xcode can re-download them.", risk: "review", mode: "all" },
    RootDef { id: "xcode-device-support", label: "Xcode device support", relative: &["Library", "Developer", "Xcode", "iOS DeviceSupport"], reason: "Debug symbols cached for attached iOS devices; recreated when a device is connected.", risk: "review", mode: "all" },
    RootDef { id: "xcode-archives", label: "Xcode archives", relative: &["Library", "Developer", "Xcode", "Archives"], reason: "Archived application builds; release archives should be kept and the rest reviewed.", risk: "review", mode: "all" },
    // Other caches, logs and language/voice resources.
    RootDef { id: "npm-cache", label: "npm cache", relative: &[".npm", "_cacache"], reason: "npm package cache; entries are re-downloaded on demand.", risk: "safe", mode: "all" },
    RootDef { id: "crash-reports", label: "Crash reports", relative: &["Library", "Application Support", "CrashReporter"], reason: "Application crash reports; diagnostic only.", risk: "safe", mode: "all" },
    RootDef { id: "speech-resources", label: "Speech resources", relative: &["Library", "Speech"], reason: "Downloaded speech, voice and language resources; macOS can re-download them.", risk: "safe", mode: "all" },
];

const NOTES: [&str; 4] = [
    "Preview only; no files are changed.",
    "Safe tier covers regenerable caches/logs; Review covers user files, restorable state, backups and re-downloadable model/simulator data; High covers duplicate candidates.",
    "Trash, duplicates, old installers, screenshots, caches, logs, language-model weights, device backups and simulator data are inspected conservatively; personal or dependency-sensitive areas remain excluded.",
    "Candidates must be explicitly selected before export to Collector.",
];

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SmartCleanCandidate {
    pub path: String,
    pub name: String,
    #[serde(rename = "type")]
    pub node_type: String,
    pub size: u64,
    pub category: String,
    pub category_id: String,
    pub reason: String,
    pub risk: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modified_at: Option<String>,
    pub verification: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SmartCleanRootInfo {
    pub id: String,
    pub label: String,
    pub path: String,
    pub candidates: u64,
    pub truncated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unavailable: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SmartCleanResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub generated_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub truncated: Option<bool>,
    pub candidates: Vec<SmartCleanCandidate>,
    pub roots: Vec<SmartCleanRootInfo>,
    pub excluded_count: u64,
    pub notes: Vec<String>,
}

impl SmartCleanResponse {
    fn error(message: &str) -> Self {
        Self {
            ok: false,
            error: Some(message.to_string()),
            ..Default::default()
        }
    }
}

#[derive(Clone)]
struct Root {
    id: String,
    label: String,
    path: String,
    reason: String,
    risk: String,
    mode: String,
}

fn regex_for(cell: &'static OnceLock<Regex>, pattern: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pattern).expect("valid smart-clean regex"))
}

fn incomplete_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    regex_for(&RE, r"(?i)(?:\.crdownload|\.part|\.download|\.tmp)$")
}
fn installers_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    regex_for(&RE, r"(?i)(?:\.dmg|\.pkg|\.zip|\.tar|\.gz|\.tgz)$")
}
fn screenshots_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    regex_for(&RE, r"(?i)(?:screenshot|screen[ _-]?shot|capture)")
}
fn cache_like_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    regex_for(&RE, r"(?i)(?:cache|caches|logs|deriveddata|simulator)")
}
fn app_bundle_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    regex_for(&RE, r"(?i)(?:^|/)[^/]+\.app(?:/|$)")
}

fn basename(path: &str) -> String {
    path.rsplit('/').next().unwrap_or(path).to_string()
}

fn is_within_root(candidate: &str, root: &str) -> bool {
    candidate == root || candidate.starts_with(&format!("{root}/"))
}

fn is_app_bundle_path(value: &str) -> bool {
    app_bundle_regex().is_match(value)
}

fn is_sensitive_smart_path(value: &str) -> bool {
    value
        .split('/')
        .any(|segment| SENSITIVE_SEGMENTS.contains(&segment))
}

/// Sensitivity evaluated on the path *relative to its root*: an explicitly
/// defined root that itself lives under a sensitive segment (for example iOS
/// device backups under `Application Support`) can still yield candidates, while
/// sensitive sub-areas nested inside it stay excluded.
fn is_sensitive_below(item_path: &str, root_path: &str) -> bool {
    let relative = item_path.strip_prefix(root_path).unwrap_or(item_path);
    is_sensitive_smart_path(relative)
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn mtime_ms(metadata: &std::fs::Metadata) -> i64 {
    metadata.mtime() * 1000 + metadata.mtime_nsec() / 1_000_000
}

/// Convert epoch milliseconds to an ISO-8601 UTC string (`Date#toISOString`).
pub(crate) fn epoch_ms_to_iso(millis: i64) -> String {
    let seconds = millis.div_euclid(1000);
    let millis_part = millis.rem_euclid(1000);
    let days = seconds.div_euclid(86_400);
    let seconds_of_day = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let hour = seconds_of_day / 3600;
    let minute = (seconds_of_day % 3600) / 60;
    let second = seconds_of_day % 60;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis_part:03}Z")
}

/// Howard Hinnant's days-to-civil algorithm.
fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    (if month <= 2 { year + 1 } else { year }, month, day)
}

fn build_roots(scope: &str, scope_path: Option<&str>, home: &str) -> Vec<Root> {
    let home_resolved = crate::capacity::resolve_path(home)
        .to_string_lossy()
        .into_owned();
    if scope == "folder" {
        if let Some(path) = scope_path {
            let resolved = crate::capacity::resolve_path(path)
                .to_string_lossy()
                .into_owned();
            return vec![Root {
                id: "current-folder".to_string(),
                label: "Current folder".to_string(),
                path: resolved,
                reason: "Candidate matches a conservative cache, log, screenshot or installer rule in the current folder.".to_string(),
                risk: "review".to_string(),
                mode: "folder".to_string(),
            }];
        }
    }

    let base = match scope_path {
        Some(path)
            if scope == "storage"
                && !path.is_empty()
                && path != "/"
                && !path.starts_with("/System/Volumes/Data") =>
        {
            crate::capacity::resolve_path(path)
                .to_string_lossy()
                .into_owned()
        }
        _ => home_resolved.clone(),
    };

    ROOT_DEFS
        .iter()
        .filter(|definition| definition.id != "trash" || base == home_resolved)
        .map(|definition| {
            let mut joined = PathBuf::from(&base);
            for component in definition.relative {
                joined.push(component);
            }
            Root {
                id: definition.id.to_string(),
                label: definition.label.to_string(),
                path: joined.to_string_lossy().into_owned(),
                reason: definition.reason.to_string(),
                risk: definition.risk.to_string(),
                mode: definition.mode.to_string(),
            }
        })
        .collect()
}

fn matches_entry(
    mode: &str,
    root_path: &str,
    name: &str,
    is_dir: bool,
    size: u64,
    mtime: i64,
) -> bool {
    let lower = name.to_lowercase();
    let age = now_ms() - mtime.max(0);
    match mode {
        "all" => true,
        "incomplete" => age >= STALE_DOWNLOAD_MS && incomplete_regex().is_match(&lower),
        "installers" => age >= OLD_ARTIFACT_MS && installers_regex().is_match(&lower),
        "large-downloads" => !is_dir && size >= LARGE_DOWNLOAD_BYTES,
        "screenshots" => age >= OLD_ARTIFACT_MS && screenshots_regex().is_match(&lower),
        "trash" => true,
        "folder" => {
            let folder_name = basename(root_path).to_lowercase();
            let cache_like = cache_like_regex().is_match(&folder_name);
            if is_dir {
                return cache_like;
            }
            matches_entry("incomplete", root_path, name, is_dir, size, mtime)
                || matches_entry("installers", root_path, name, is_dir, size, mtime)
                || matches_entry("screenshots", root_path, name, is_dir, size, mtime)
                || (age >= OLD_ARTIFACT_MS && lower.ends_with(".log"))
        }
        _ => false,
    }
}

#[allow(clippy::too_many_arguments)]
fn make_candidate(
    category: &str,
    category_id: &str,
    reason: &str,
    risk: &str,
    item_path: &str,
    is_dir: bool,
    size: u64,
    verification: &str,
    mtime: i64,
) -> SmartCleanCandidate {
    SmartCleanCandidate {
        path: item_path.to_string(),
        name: basename(item_path),
        node_type: if is_dir { "directory" } else { "file" }.to_string(),
        size,
        category: category.to_string(),
        category_id: category_id.to_string(),
        reason: reason.to_string(),
        risk: risk.to_string(),
        modified_at: if mtime > 0 {
            Some(epoch_ms_to_iso(mtime))
        } else {
            None
        },
        verification: verification.to_string(),
    }
}

fn measure_du_summary(target_path: &str) -> u64 {
    match run_capture("/usr/bin/du", &["-sk", "-x", target_path]) {
        Some(stdout) => stdout
            .split_whitespace()
            .next()
            .and_then(|kb| kb.parse::<u64>().ok())
            .map(|kb| kb.saturating_mul(1024))
            .unwrap_or(0),
        None => 0,
    }
}

enum RootOutcome {
    Excluded,
    Skipped,
    Unavailable,
    Done {
        info: SmartCleanRootInfo,
        candidates: Vec<SmartCleanCandidate>,
        excluded: u64,
    },
}

fn process_root(root: &Root, allowed_base: &str) -> RootOutcome {
    let canonical_root = match std::fs::canonicalize(&root.path) {
        Ok(path) => path.to_string_lossy().into_owned(),
        Err(_) => return RootOutcome::Unavailable,
    };

    if !is_within_root(&canonical_root, allowed_base)
        || is_protected_system_path(&canonical_root)
        || is_app_bundle_path(&canonical_root)
    {
        return RootOutcome::Excluded;
    }

    let root_stat = match std::fs::metadata(&canonical_root) {
        Ok(metadata) => metadata,
        Err(_) => return RootOutcome::Unavailable,
    };
    if !root_stat.is_dir() {
        return RootOutcome::Skipped;
    }

    let Ok(read_dir) = std::fs::read_dir(&canonical_root) else {
        return RootOutcome::Unavailable;
    };
    let all_entries: Vec<std::fs::DirEntry> = read_dir.flatten().collect();
    let total_entries = all_entries.len();
    let entries: Vec<std::fs::DirEntry> = all_entries
        .into_iter()
        .filter(|entry| {
            !entry
                .file_type()
                .map(|kind| kind.is_symlink())
                .unwrap_or(false)
        })
        .take(MAX_ENTRIES_PER_ROOT)
        .collect();
    let mut excluded = (total_entries - entries.len()) as u64;

    let mut candidates = Vec::new();
    for entry in &entries {
        let name = entry.file_name().to_string_lossy().into_owned();
        let item_path = format!("{canonical_root}/{name}");
        if !is_within_root(&item_path, &canonical_root)
            || is_app_bundle_path(&item_path)
            || is_sensitive_below(&item_path, &canonical_root)
        {
            excluded += 1;
            continue;
        }

        let Ok(canonical_item) = std::fs::canonicalize(&item_path) else {
            excluded += 1;
            continue;
        };
        let canonical_item = canonical_item.to_string_lossy().into_owned();
        if !is_within_root(&canonical_item, &canonical_root)
            || !is_within_root(&canonical_item, allowed_base)
            || is_protected_system_path(&canonical_item)
            || is_sensitive_below(&canonical_item, &canonical_root)
            || is_app_bundle_path(&canonical_item)
        {
            excluded += 1;
            continue;
        }

        let Ok(stat) = std::fs::symlink_metadata(&canonical_item) else {
            excluded += 1;
            continue;
        };
        let mtime = mtime_ms(&stat);
        let is_dir = stat.is_dir();
        let size_field = stat.len();
        if !matches_entry(&root.mode, &root.path, &name, is_dir, size_field, mtime) {
            continue;
        }
        let size = if is_dir {
            measure_du_summary(&canonical_item)
        } else {
            size_field
        };
        if size == 0 {
            continue;
        }
        let verification = if is_dir {
            "du -sk -x summary"
        } else {
            "filesystem stat"
        };
        candidates.push(make_candidate(
            &root.label,
            &root.id,
            &root.reason,
            &root.risk,
            &canonical_item,
            is_dir,
            size,
            verification,
            mtime,
        ));
    }

    RootOutcome::Done {
        info: SmartCleanRootInfo {
            id: root.id.clone(),
            label: root.label.clone(),
            path: canonical_root,
            candidates: candidates.len() as u64,
            truncated: total_entries > entries.len(),
            unavailable: None,
        },
        candidates,
        excluded,
    }
}

struct DuplicateFile {
    path: String,
    size: u64,
    mtime: i64,
}

fn collect_duplicate_files(root_path: &str) -> Vec<DuplicateFile> {
    let mut files: Vec<DuplicateFile> = Vec::new();
    let mut queue: VecDeque<(String, usize)> = VecDeque::new();
    queue.push_back((root_path.to_string(), 0));

    while let Some((current_path, depth)) = queue.pop_front() {
        if files.len() >= MAX_DUPLICATE_FILES {
            break;
        }
        if depth > 2 || is_sensitive_smart_path(&current_path) || is_app_bundle_path(&current_path)
        {
            continue;
        }
        let Ok(read_dir) = std::fs::read_dir(&current_path) else {
            continue;
        };
        let mut entries: Vec<std::fs::DirEntry> =
            read_dir.flatten().take(MAX_ENTRIES_PER_ROOT).collect();
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            let item_path = format!("{current_path}/{}", entry.file_name().to_string_lossy());
            let file_type = entry.file_type().ok();
            if file_type.map(|kind| kind.is_symlink()).unwrap_or(false)
                || is_app_bundle_path(&item_path)
            {
                continue;
            }
            if file_type.map(|kind| kind.is_dir()).unwrap_or(false) {
                if depth < 2 {
                    queue.push_back((item_path, depth + 1));
                }
                continue;
            }
            if let Ok(stat) = std::fs::metadata(&item_path) {
                if stat.is_file() && stat.len() > 0 {
                    files.push(DuplicateFile {
                        path: item_path,
                        size: stat.len(),
                        mtime: mtime_ms(&stat),
                    });
                }
            }
            if files.len() >= MAX_DUPLICATE_FILES {
                break;
            }
        }
    }
    files
}

fn hash_file_sample(file_path: &str, size: u64) -> std::io::Result<String> {
    use std::io::{Read, Seek, SeekFrom};

    let sample = size.min(SAMPLE_BYTES) as usize;
    let mut file = std::fs::File::open(file_path)?;
    let mut hasher = Sha256::new();

    let mut buffer = vec![0u8; sample];
    file.read_exact(&mut buffer)?;
    hasher.update(&buffer);

    if size > (sample as u64) * 2 {
        file.seek(SeekFrom::Start(size - sample as u64))?;
        let mut last = vec![0u8; sample];
        file.read_exact(&mut last)?;
        hasher.update(&last);
    }

    Ok(format!("{:x}", hasher.finalize()))
}

fn find_duplicate_candidates(root_path: &str) -> Vec<SmartCleanCandidate> {
    let files = collect_duplicate_files(root_path);
    let mut groups: HashMap<String, Vec<DuplicateFile>> = HashMap::new();
    for file in files {
        if let Ok(hash) = hash_file_sample(&file.path, file.size) {
            groups
                .entry(format!("{}:{}", file.size, hash))
                .or_default()
                .push(file);
        }
    }

    let mut results = Vec::new();
    for (_fingerprint, mut group) in groups {
        if group.len() < 2 {
            continue;
        }
        group.sort_by(|left, right| left.path.cmp(&right.path));
        let first_name = basename(&group[0].path);
        for duplicate in group.iter().skip(1) {
            results.push(make_candidate(
                "Duplicates",
                "duplicates",
                &format!("Duplicate fingerprint matches {first_name}."),
                "high",
                &duplicate.path,
                false,
                duplicate.size,
                "sample hash; manual verification required",
                duplicate.mtime,
            ));
        }
    }
    results
}

/// Build the Smart Clean preview. `Ok` responses carry candidate details.
pub(crate) fn preview(
    scope: &str,
    folder_path: Option<&str>,
    storage_path: Option<&str>,
) -> SmartCleanResponse {
    let home = crate::capacity::resolve_path(&std::env::var("HOME").unwrap_or_default())
        .to_string_lossy()
        .into_owned();
    let selected_scope_path = if scope == "folder" {
        folder_path
    } else {
        storage_path
    };

    let mut canonical_scope: Option<String> = None;
    if scope == "folder" {
        let Some(folder) = folder_path.filter(|path| is_filesystem_path(path)) else {
            return SmartCleanResponse::error("Invalid current folder path");
        };
        let Ok(canonical) = std::fs::canonicalize(folder) else {
            return SmartCleanResponse::error(
                "This folder is protected or outside the Smart Clean safety policy",
            );
        };
        let canonical = canonical.to_string_lossy().into_owned();
        if is_protected_system_path(&canonical)
            || is_sensitive_smart_path(&canonical)
            || is_app_bundle_path(&canonical)
        {
            return SmartCleanResponse::error(
                "This folder is protected or outside the Smart Clean safety policy",
            );
        }
        match std::fs::metadata(&canonical) {
            Ok(metadata) if metadata.is_dir() => canonical_scope = Some(canonical),
            _ => return SmartCleanResponse::error("Current folder is not available"),
        }
    }

    let roots_to_inspect = build_roots(
        scope,
        canonical_scope.as_deref().or(selected_scope_path),
        &home,
    );

    let mut candidates: Vec<SmartCleanCandidate> = Vec::new();
    let mut roots: Vec<SmartCleanRootInfo> = Vec::new();
    let mut excluded_count: u64 = 0;

    for root in &roots_to_inspect {
        let allowed_base = if scope == "folder" {
            canonical_scope.clone().unwrap_or_default()
        } else if root.path.starts_with(&home) {
            home.clone()
        } else {
            crate::capacity::resolve_path(selected_scope_path.unwrap_or(&root.path))
                .to_string_lossy()
                .into_owned()
        };

        match process_root(root, &allowed_base) {
            RootOutcome::Excluded => excluded_count += 1,
            RootOutcome::Skipped => {}
            RootOutcome::Unavailable => roots.push(SmartCleanRootInfo {
                id: root.id.clone(),
                label: root.label.clone(),
                path: root.path.clone(),
                candidates: 0,
                truncated: false,
                unavailable: Some(true),
            }),
            RootOutcome::Done {
                info,
                candidates: found,
                excluded,
            } => {
                excluded_count += excluded;
                candidates.extend(found);
                roots.push(info);
            }
        }
    }

    let duplicate_root_path = if scope == "folder" {
        canonical_scope.clone()
    } else {
        Some(home.clone())
    };
    if let Some(path) = duplicate_root_path {
        if !is_sensitive_smart_path(&path) {
            let duplicates = find_duplicate_candidates(&path);
            if !duplicates.is_empty() {
                roots.push(SmartCleanRootInfo {
                    id: "duplicates".to_string(),
                    label: "Duplicates".to_string(),
                    path,
                    candidates: duplicates.len() as u64,
                    truncated: false,
                    unavailable: None,
                });
                candidates.extend(duplicates);
            }
        }
    }

    candidates.sort_by_key(|candidate| std::cmp::Reverse(candidate.size));
    let truncated = candidates.len() > MAX_CANDIDATES;
    if truncated {
        excluded_count += (candidates.len() - MAX_CANDIDATES) as u64;
    }
    candidates.truncate(MAX_CANDIDATES);

    SmartCleanResponse {
        ok: true,
        generated_at: Some(epoch_ms_to_iso(now_ms())),
        scope: Some(scope.to_string()),
        scope_path: Some(
            canonical_scope
                .or_else(|| selected_scope_path.map(str::to_string))
                .unwrap_or(home),
        ),
        truncated: Some(truncated),
        candidates,
        roots,
        excluded_count,
        notes: NOTES.iter().map(|note| note.to_string()).collect(),
        ..Default::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_format_matches_javascript() {
        assert_eq!(epoch_ms_to_iso(0), "1970-01-01T00:00:00.000Z");
        // 2020-01-01T00:00:00.000Z
        assert_eq!(
            epoch_ms_to_iso(1_577_836_800_000),
            "2020-01-01T00:00:00.000Z"
        );
        assert_eq!(
            epoch_ms_to_iso(1_577_836_800_123),
            "2020-01-01T00:00:00.123Z"
        );
    }

    #[test]
    fn entry_matching_per_mode() {
        let now = now_ms();
        let fresh = now;
        let old = now - OLD_ARTIFACT_MS - 1000;
        let stale = now - STALE_DOWNLOAD_MS - 1000;

        assert!(matches_entry("all", "/x", "anything", false, 0, fresh));
        assert!(matches_entry(
            "incomplete",
            "/x",
            "a.crdownload",
            false,
            0,
            stale
        ));
        assert!(!matches_entry(
            "incomplete",
            "/x",
            "a.crdownload",
            false,
            0,
            fresh
        ));
        assert!(matches_entry("installers", "/x", "a.DMG", false, 0, old));
        assert!(!matches_entry("installers", "/x", "a.dmg", false, 0, fresh));
        assert!(matches_entry(
            "large-downloads",
            "/x",
            "big",
            false,
            LARGE_DOWNLOAD_BYTES,
            fresh
        ));
        assert!(!matches_entry(
            "large-downloads",
            "/x",
            "big",
            true,
            LARGE_DOWNLOAD_BYTES,
            fresh
        ));
        assert!(matches_entry(
            "screenshots",
            "/x",
            "Screen Shot 1.png",
            false,
            0,
            old
        ));
        assert!(!matches_entry(
            "screenshots",
            "/x",
            "Screen Shot 1.png",
            false,
            0,
            fresh
        ));
        assert!(matches_entry("folder", "/x/Caches", "sub", true, 0, fresh));
        assert!(!matches_entry(
            "folder",
            "/x/Documents",
            "sub",
            true,
            0,
            fresh
        ));
        assert!(matches_entry(
            "folder",
            "/x/Documents",
            "old.log",
            false,
            0,
            old
        ));
    }

    #[test]
    fn sensitive_and_bundle_detection() {
        assert!(is_sensitive_smart_path("/Users/me/Library/Containers/x"));
        assert!(is_sensitive_smart_path("/Users/me/Mail/x"));
        assert!(!is_sensitive_smart_path("/Users/me/Library/Caches/x"));
        assert!(is_app_bundle_path("/Applications/Safari.app"));
        assert!(is_app_bundle_path("/Applications/Safari.app/Contents"));
        assert!(!is_app_bundle_path("/Applications/Safari"));
    }

    #[test]
    fn sensitive_is_checked_relative_to_the_root() {
        let root = "/Users/me/Library/Application Support/MobileSync/Backup";
        // The root itself lives under a sensitive segment ...
        assert!(is_sensitive_smart_path(root));
        // ... but entries inside it do not, so backup folders are candidates.
        assert!(!is_sensitive_below(&format!("{root}/0000123-abcdef"), root));
        // Nested sensitive areas remain excluded.
        assert!(is_sensitive_below(&format!("{root}/Containers/x"), root));
    }

    #[test]
    fn new_smart_clean_roots_are_registered() {
        let roots = build_roots("storage", Some("/Users/me"), "/Users/me");
        for id in [
            "model-huggingface",
            "model-ollama",
            "model-lmstudio",
            "ios-backups",
            "simulator-devices",
            "simulator-runtimes",
            "xcode-device-support",
            "npm-cache",
            "speech-resources",
        ] {
            assert!(roots.iter().any(|root| root.id == id), "missing root {id}");
        }
        let ios = roots.iter().find(|root| root.id == "ios-backups").unwrap();
        assert_eq!(
            ios.path,
            "/Users/me/Library/Application Support/MobileSync/Backup"
        );
        assert_eq!(ios.risk, "review");
        let npm = roots.iter().find(|root| root.id == "npm-cache").unwrap();
        assert_eq!(npm.risk, "safe");
    }

    #[test]
    #[ignore = "probe: real Smart Clean preview over $HOME (~seconds)"]
    fn preview_probe() {
        let response = preview("storage", None, None);
        assert!(response.ok, "preview failed: {:?}", response.error);
        for root in &response.roots {
            eprintln!(
                "  {:<24} {:<28} candidates={}{}",
                root.id,
                root.label,
                root.candidates,
                if root.unavailable == Some(true) {
                    " [unavailable]"
                } else {
                    ""
                }
            );
        }
        eprintln!(
            "total candidates: {}, excluded: {}",
            response.candidates.len(),
            response.excluded_count
        );
    }

    #[test]
    fn trash_root_only_under_home() {
        let home = "/Users/me";
        let under_home = build_roots("storage", Some("/Users/me"), home);
        assert!(under_home.iter().any(|root| root.id == "trash"));

        let external = build_roots("storage", Some("/Volumes/ext"), home);
        assert!(!external.iter().any(|root| root.id == "trash"));
    }

    #[test]
    fn folder_scope_root_is_the_folder() {
        let roots = build_roots("folder", Some("/Users/me/proj"), "/Users/me");
        assert_eq!(roots.len(), 1);
        assert_eq!(roots[0].id, "current-folder");
        assert_eq!(roots[0].path, "/Users/me/proj");
    }
}
