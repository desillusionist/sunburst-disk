//! Live folder updates.
//!
//! Replaces Electron's Swift `fsevents-watcher` helper with the `notify` crate
//! (FSEvents on macOS). FSEvents is used as an invalidation signal: events are
//! coalesced into a 450 ms debounce window, then one `folder-watch-change`
//! payload tells the renderer which nearest-known branches to reconcile.
//!
//! Parity note: `notify` maps raw FSEvents flags to an `EventKind` and does not
//! expose `kFSEventStreamEventFlagMustScanSubDirs` / dropped-event flags. So
//! Electron's flag-level recovery triggers become kind-based here: `Any`/`Other`
//! are treated as recovery (full scan), access/metadata events are ignored, and
//! create/remove/modify act as content events. Root rename detection is
//! unaffected because it uses device:inode identity, not flags.

use std::collections::HashSet;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::RecvTimeoutError;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use notify::event::EventKind;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::capacity::resolve_path;
use crate::commands::is_protected_system_path;

const DEBOUNCE: Duration = Duration::from_millis(450);
const MAX_PATHS: usize = 256;
const DATA_VOLUME_PREFIX: &str = "/System/Volumes/Data";
const FIRMLINK_ROOTS: [&str; 6] = [
    "/Applications",
    "/Library",
    "/Users",
    "/private",
    "/opt",
    "/Volumes",
];

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FolderWatchChange {
    pub root_path: String,
    pub changed_paths: Vec<String>,
    pub full_scan: bool,
    pub root_changed: bool,
    pub root_missing: bool,
    pub root_renamed_to: Option<String>,
    pub truncated: bool,
    pub observed_at: u128,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FolderWatchStatus {
    pub active: bool,
    pub root_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub debounce_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WatchResponse {
    pub ok: bool,
    pub active: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub root_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

fn push_unique(list: &mut Vec<String>, value: String) {
    if !list.contains(&value) {
        list.push(value);
    }
}

fn is_within_root(candidate: &str, root: &str) -> bool {
    candidate == root || candidate.starts_with(&format!("{root}/"))
}

/// Both the firmlink and Data-volume forms of a path, mirroring
/// `getFSEventPathCandidates`.
pub(crate) fn fsevent_path_candidates(event_path: &str) -> Vec<String> {
    let resolved = resolve_path(event_path).to_string_lossy().into_owned();
    let mut candidates = vec![resolved.clone()];

    let data_prefix = format!("{DATA_VOLUME_PREFIX}/");
    if resolved == DATA_VOLUME_PREFIX || resolved.starts_with(&data_prefix) {
        let suffix = &resolved[DATA_VOLUME_PREFIX.len()..];
        push_unique(
            &mut candidates,
            if suffix.is_empty() {
                "/".to_string()
            } else {
                suffix.to_string()
            },
        );
    }
    for root in FIRMLINK_ROOTS {
        if resolved == root || resolved.starts_with(&format!("{root}/")) {
            push_unique(&mut candidates, format!("{DATA_VOLUME_PREFIX}{resolved}"));
        }
    }
    candidates
}

fn map_fsevent_path_to_root(event_path: &str, canonical_root: &str) -> Option<String> {
    fsevent_path_candidates(event_path)
        .into_iter()
        .find(|candidate| is_within_root(candidate, canonical_root))
}

/// `(content, recovery, metadata_only)` for a notify event kind.
fn classify(kind: &EventKind) -> (bool, bool, bool) {
    match kind {
        EventKind::Any | EventKind::Other => (false, true, false),
        EventKind::Access(_) => (false, false, true),
        EventKind::Create(_) | EventKind::Remove(_) => (true, false, false),
        EventKind::Modify(notify::event::ModifyKind::Metadata(_)) => (false, false, true),
        EventKind::Modify(_) => (true, false, false),
    }
}

fn file_identity(path: &str) -> Option<(u64, u64)> {
    std::fs::metadata(path)
        .ok()
        .map(|metadata| (metadata.dev(), metadata.ino()))
}

fn find_renamed_watcher_root(
    canonical_root: &str,
    identity: Option<(u64, u64)>,
    raw_paths: &HashSet<String>,
) -> Option<String> {
    let identity = identity?;
    let parent = Path::new(canonical_root).parent()?;
    let parent_text = parent.to_string_lossy().into_owned();

    let mut candidates: Vec<String> = Vec::new();
    let mut consider = |value: String| {
        let resolved = resolve_path(&value).to_string_lossy().into_owned();
        if resolved == canonical_root {
            return;
        }
        let same_parent = Path::new(&resolved)
            .parent()
            .map(|candidate_parent| candidate_parent.to_string_lossy().into_owned())
            .as_deref()
            == Some(parent_text.as_str());
        if same_parent {
            push_unique(&mut candidates, resolved);
        }
    };

    for raw in raw_paths {
        for candidate in fsevent_path_candidates(raw) {
            consider(candidate);
        }
    }
    if let Ok(entries) = std::fs::read_dir(parent) {
        for entry in entries.flatten() {
            if let Ok(file_type) = entry.file_type() {
                if file_type.is_dir() || file_type.is_symlink() {
                    consider(entry.path().to_string_lossy().into_owned());
                }
            }
        }
    }

    let matches: Vec<String> = candidates
        .into_iter()
        .filter(|candidate| file_identity(candidate) == Some(identity))
        .collect();
    if matches.len() == 1 {
        matches.into_iter().next()
    } else {
        None
    }
}

#[derive(Default)]
struct Pending {
    canonical_paths: Vec<String>,
    seen: HashSet<String>,
    raw_paths: HashSet<String>,
    needs_full_scan: bool,
    root_changed: bool,
}

impl Pending {
    fn has_work(&self) -> bool {
        !self.raw_paths.is_empty() || self.needs_full_scan || self.root_changed
    }

    fn reset(&mut self) {
        self.canonical_paths.clear();
        self.seen.clear();
        self.raw_paths.clear();
        self.needs_full_scan = false;
        self.root_changed = false;
    }
}

struct ActiveWatch {
    display_root: String,
    watcher: RecommendedWatcher,
    stop: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}

impl ActiveWatch {
    fn shutdown(self) {
        self.stop.store(true, Ordering::Relaxed);
        drop(self.watcher);
        if let Some(worker) = self.worker {
            let _ = worker.join();
        }
    }
}

/// Managed state holding at most one active watcher.
#[derive(Default)]
pub struct FolderWatch {
    inner: Mutex<Option<ActiveWatch>>,
}

fn emit_status(app: &AppHandle, status: FolderWatchStatus) {
    let _ = app.emit("folder-watch-status", status);
}

/// Stop the current watcher (if any) and emit a `stopped` status.
pub fn stop(app: &AppHandle, state: &FolderWatch) {
    let removed = state.inner.lock().ok().and_then(|mut inner| inner.take());
    if let Some(active) = removed {
        let display_root = active.display_root.clone();
        active.shutdown();
        emit_status(
            app,
            FolderWatchStatus {
                active: false,
                root_path: display_root,
                reason: Some("stopped".to_string()),
                ..Default::default()
            },
        );
    }
}

/// Start watching `folder_path`, replacing any existing watcher.
pub fn start(app: &AppHandle, state: &FolderWatch, folder_path: &str) -> WatchResponse {
    if !folder_path.starts_with('/') || folder_path.starts_with("__") {
        return WatchResponse {
            ok: false,
            active: false,
            error: Some("Invalid folder watcher path".to_string()),
            ..Default::default()
        };
    }

    let display_root = resolve_path(folder_path).to_string_lossy().into_owned();
    let canonical_root = match std::fs::canonicalize(&display_root) {
        Ok(path) => path.to_string_lossy().into_owned(),
        Err(error) => {
            return WatchResponse {
                ok: false,
                active: false,
                error: Some(error.to_string()),
                ..Default::default()
            }
        }
    };
    match std::fs::metadata(&canonical_root) {
        Ok(metadata) if metadata.is_dir() => {}
        Ok(_) => {
            return WatchResponse {
                ok: false,
                active: false,
                error: Some("Watcher target is not a directory".to_string()),
                ..Default::default()
            }
        }
        Err(error) => {
            return WatchResponse {
                ok: false,
                active: false,
                error: Some(error.to_string()),
                ..Default::default()
            }
        }
    }

    // The storage root, the whole System volume and protected branches are not
    // watched (matches Electron's `protected-or-storage-root`).
    if is_protected_system_path(&canonical_root)
        || canonical_root == DATA_VOLUME_PREFIX
        || canonical_root == "/"
    {
        stop(app, state);
        emit_status(
            app,
            FolderWatchStatus {
                active: false,
                root_path: display_root.clone(),
                disabled: Some(true),
                reason: Some("protected-or-storage-root".to_string()),
                ..Default::default()
            },
        );
        return WatchResponse {
            ok: true,
            active: false,
            disabled: Some(true),
            root_path: Some(display_root),
            error: None,
        };
    }

    stop(app, state);

    let (sender, receiver) = std::sync::mpsc::channel::<(PathBuf, EventKind)>();
    let watcher = match notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
        if let Ok(event) = result {
            for path in event.paths {
                let _ = sender.send((path, event.kind));
            }
        }
    }) {
        Ok(watcher) => watcher,
        Err(error) => {
            return WatchResponse {
                ok: false,
                active: false,
                error: Some(error.to_string()),
                ..Default::default()
            }
        }
    };
    let mut watcher = watcher;
    if let Err(error) = watcher.watch(Path::new(&canonical_root), RecursiveMode::Recursive) {
        return WatchResponse {
            ok: false,
            active: false,
            error: Some(error.to_string()),
            ..Default::default()
        };
    }

    let root_identity = file_identity(&canonical_root);
    let stop = Arc::new(AtomicBool::new(false));
    let worker_stop = stop.clone();
    let worker_app = app.clone();
    let worker_canonical = canonical_root.clone();
    let worker_display = display_root.clone();

    let worker = std::thread::spawn(move || {
        let mut pending = Pending::default();
        loop {
            if worker_stop.load(Ordering::Relaxed) {
                break;
            }
            match receiver.recv_timeout(DEBOUNCE) {
                Ok((path, kind)) => {
                    let (content, recovery, metadata_only) = classify(&kind);
                    if metadata_only && !recovery {
                        continue;
                    }
                    if !content && !recovery {
                        continue;
                    }
                    let raw = resolve_path(&path.to_string_lossy())
                        .to_string_lossy()
                        .into_owned();
                    if !pending.raw_paths.insert(raw.clone()) {
                        // Already queued in this window; still a recovery flag
                        // may apply below.
                    }
                    match map_fsevent_path_to_root(&raw, &worker_canonical) {
                        Some(mapped) => {
                            if pending.seen.insert(mapped.clone()) {
                                pending.canonical_paths.push(mapped);
                            }
                        }
                        None => {
                            if raw != worker_canonical {
                                pending.needs_full_scan = true;
                            }
                        }
                    }
                    if recovery {
                        pending.needs_full_scan = true;
                    }
                }
                Err(RecvTimeoutError::Timeout) => {
                    if pending.has_work() {
                        flush_change(
                            &worker_app,
                            &mut pending,
                            &worker_canonical,
                            &worker_display,
                            root_identity,
                            &worker_stop,
                        );
                    }
                }
                Err(RecvTimeoutError::Disconnected) => break,
            }
        }
    });

    if let Ok(mut inner) = state.inner.lock() {
        *inner = Some(ActiveWatch {
            display_root: display_root.clone(),
            watcher,
            stop,
            worker: Some(worker),
        });
    }

    emit_status(
        app,
        FolderWatchStatus {
            active: true,
            root_path: display_root.clone(),
            debounce_ms: Some(DEBOUNCE.as_millis() as u64),
            ..Default::default()
        },
    );

    WatchResponse {
        ok: true,
        active: true,
        root_path: Some(display_root),
        ..Default::default()
    }
}

fn flush_change(
    app: &AppHandle,
    pending: &mut Pending,
    canonical_root: &str,
    display_root: &str,
    root_identity: Option<(u64, u64)>,
    stop: &AtomicBool,
) {
    let root_missing = !Path::new(canonical_root).exists();
    let renamed_to = if root_missing {
        find_renamed_watcher_root(canonical_root, root_identity, &pending.raw_paths)
    } else {
        None
    };

    let changed_paths: Vec<String> = pending
        .canonical_paths
        .iter()
        .take(MAX_PATHS)
        .map(|path| {
            if path == canonical_root {
                display_root.to_string()
            } else if is_within_root(path, canonical_root) {
                format!("{display_root}/{}", &path[canonical_root.len() + 1..])
            } else {
                display_root.to_string()
            }
        })
        .collect();

    let payload = FolderWatchChange {
        root_path: display_root.to_string(),
        changed_paths,
        full_scan: if renamed_to.is_some() {
            false
        } else {
            pending.needs_full_scan || root_missing
        },
        root_changed: pending.root_changed,
        root_missing,
        root_renamed_to: renamed_to.clone(),
        truncated: pending.canonical_paths.len() > MAX_PATHS,
        observed_at: now_ms(),
    };
    let _ = app.emit("folder-watch-change", payload);
    pending.reset();

    // After a rename the watched path no longer exists; the renderer remaps the
    // tree and re-arms the watcher on the new path.
    if renamed_to.is_some() {
        stop.store(true, Ordering::Relaxed);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn firmlink_and_data_volume_candidates() {
        let users = fsevent_path_candidates("/Users/me/Projects");
        assert!(users.contains(&"/Users/me/Projects".to_string()));
        assert!(users.contains(&"/System/Volumes/Data/Users/me/Projects".to_string()));

        let data = fsevent_path_candidates("/System/Volumes/Data/Users/me");
        assert!(data.contains(&"/System/Volumes/Data/Users/me".to_string()));
        assert!(data.contains(&"/Users/me".to_string()));

        // A path in neither space has a single candidate.
        assert_eq!(fsevent_path_candidates("/Volumes/exAPFS/x").len(), 2);
    }

    #[test]
    fn within_root_and_mapping() {
        assert!(is_within_root("/a/b", "/a/b"));
        assert!(is_within_root("/a/b/c", "/a/b"));
        assert!(!is_within_root("/a/bc", "/a/b"));
        assert!(!is_within_root("/a", "/a/b"));

        assert_eq!(
            map_fsevent_path_to_root("/Users/me/x", "/System/Volumes/Data/Users/me"),
            Some("/System/Volumes/Data/Users/me/x".to_string())
        );
        assert_eq!(
            map_fsevent_path_to_root("/elsewhere/x", "/System/Volumes/Data/Users/me"),
            None
        );
    }

    #[test]
    fn event_kinds_split_into_content_recovery_metadata() {
        assert_eq!(
            classify(&EventKind::Create(notify::event::CreateKind::File)),
            (true, false, false)
        );
        assert_eq!(
            classify(&EventKind::Remove(notify::event::RemoveKind::File)),
            (true, false, false)
        );
        assert_eq!(
            classify(&EventKind::Modify(notify::event::ModifyKind::Data(
                notify::event::DataChange::Any
            ))),
            (true, false, false)
        );
        assert_eq!(
            classify(&EventKind::Modify(notify::event::ModifyKind::Metadata(
                notify::event::MetadataKind::Any
            ))),
            (false, false, true)
        );
        assert_eq!(
            classify(&EventKind::Access(notify::event::AccessKind::Any)),
            (false, false, true)
        );
        assert_eq!(classify(&EventKind::Any), (false, true, false));
    }

    #[test]
    #[ignore = "exercises the real FSEvents backend; run with --ignored"]
    fn notify_backend_delivers_events() {
        use std::sync::mpsc::channel;

        let dir = std::env::temp_dir().join(format!("sunburst-watch-probe-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir should be writable");

        let (sender, receiver) = channel();
        let mut watcher =
            notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
                if let Ok(event) = result {
                    let _ = sender.send(event);
                }
            })
            .expect("watcher should start");
        watcher
            .watch(&dir, RecursiveMode::Recursive)
            .expect("watch should attach");

        // Let the stream become ready, then retry a few writes: FSEvents has
        // latency, and in a headless sandbox it may not deliver at all.
        std::thread::sleep(Duration::from_millis(500));
        let mut received = false;
        for attempt in 0..6 {
            std::fs::write(dir.join(format!("probe-{attempt}.txt")), b"hello")
                .expect("probe write");
            if receiver.recv_timeout(Duration::from_millis(800)).is_ok() {
                received = true;
                break;
            }
        }
        let _ = std::fs::remove_dir_all(&dir);

        assert!(received, "expected an FSEvents event within ~5s");
    }
}
