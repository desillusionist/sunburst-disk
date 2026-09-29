//! Tauri command surface. Command names are snake_case in Rust and camelCase
//! on the JS side (`rename_all = "camelCase"`), matching the arguments the
//! existing preload bridge used to send.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::json;
use tauri::{AppHandle, Emitter, LogicalSize, Manager, State, Window};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_notification::NotificationExt;

use crate::archive;
use crate::ask_siri;
use crate::capacity;
use crate::drives;
use crate::hidden_space;
use crate::inspect;
use crate::openwith;
use crate::quick_look;
use crate::related;
use crate::scan::{self, ScanError, ScanOptions};
use crate::smart_clean;
use crate::terminal;
use crate::types::{
    CancelResponse, ChooseFolderResponse, DeleteResponse, DeleteResultItem, DrivesResponse,
    FolderDrive, LayoutResponse, ScanResponse,
};
use crate::watcher;

static REQUEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// Tracks one in-flight scan per window so it can be cancelled and so a new
/// scan supersedes the previous one, mirroring `beginScanJob`/`abortScanJob`.
#[derive(Default)]
pub struct ScanJobs {
    state: Mutex<JobsState>,
}

#[derive(Default)]
struct JobsState {
    flags: std::collections::HashMap<String, Arc<AtomicBool>>,
    by_window: std::collections::HashMap<String, String>,
}

impl ScanJobs {
    fn begin(&self, window: &str, request_id: String) -> (String, Arc<AtomicBool>) {
        let mut state = self.state.lock().expect("scan job registry poisoned");
        if let Some(previous) = state.by_window.get(window).cloned() {
            if let Some(flag) = state.flags.get(&previous) {
                flag.store(true, Ordering::Relaxed);
            }
        }
        let flag = Arc::new(AtomicBool::new(false));
        state.flags.insert(request_id.clone(), flag.clone());
        state
            .by_window
            .insert(window.to_string(), request_id.clone());
        (request_id, flag)
    }

    fn finish(&self, window: &str, request_id: &str) {
        let mut state = self.state.lock().expect("scan job registry poisoned");
        if state.by_window.get(window).map(String::as_str) == Some(request_id) {
            state.by_window.remove(window);
        }
        state.flags.remove(request_id);
    }

    fn cancel(&self, window: &str, request_id: Option<&str>) -> Option<String> {
        let state = self.state.lock().expect("scan job registry poisoned");
        let target = match request_id {
            Some(id) => state.flags.get(id).map(|_| id.to_string()),
            None => state.by_window.get(window).cloned(),
        };
        if let Some(id) = &target {
            if let Some(flag) = state.flags.get(id) {
                flag.store(true, Ordering::Relaxed);
            }
        }
        target
    }
}

fn next_request_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    let sequence = REQUEST_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    format!("scan-{nanos}-{sequence}")
}

fn is_startup_path(path: &str) -> bool {
    path == "/" || path == "/System/Volumes/Data"
}

/// Absolute paths are accepted; renderer-only identifiers (`__hidden__`) are not.
pub(crate) fn is_filesystem_path(value: &str) -> bool {
    value.starts_with('/') && !value.starts_with("__")
}

/// Mirrors `isProtectedSystemPath`: the sealed System volume, and the System,
/// private and usr branches of the Data volume, are off-limits to deletion.
pub(crate) fn is_protected_system_path(value: &str) -> bool {
    let normalized = value.trim_end_matches('/');
    if normalized == "/System" {
        return true;
    }
    if normalized.starts_with("/System/") && !normalized.starts_with("/System/Volumes/Data/") {
        return true;
    }
    ["System", "private", "usr"].iter().any(|segment| {
        let prefix = format!("/System/Volumes/Data/{segment}");
        normalized == prefix || normalized.starts_with(&format!("{prefix}/"))
    })
}

#[tauri::command(rename_all = "camelCase")]
pub async fn get_drives() -> DrivesResponse {
    tauri::async_runtime::spawn_blocking(drives::get_drives)
        .await
        .unwrap_or_else(|_| DrivesResponse {
            drives: Vec::new(),
            user_home: String::new(),
        })
}

#[tauri::command(rename_all = "camelCase")]
pub async fn get_capacity_snapshot(target_path: Option<String>) -> serde_json::Value {
    let path = target_path.unwrap_or_else(|| "/".to_string());
    tauri::async_runtime::spawn_blocking(move || capacity::get_capacity_snapshot(&path))
        .await
        .unwrap_or_else(|_| json!({ "error": "Capacity snapshot failed" }))
}

#[tauri::command(rename_all = "camelCase")]
pub async fn scan_directory(
    app: AppHandle,
    window: Window,
    state: State<'_, ScanJobs>,
    target_path: String,
    detail_depth: Option<usize>,
    request_id: Option<String>,
) -> Result<ScanResponse, String> {
    if !target_path.starts_with('/') || target_path.starts_with("__") {
        return Ok(ScanResponse::error("Invalid filesystem path"));
    }

    let id = request_id
        .filter(|value| !value.is_empty())
        .unwrap_or_else(next_request_id);
    let startup = is_startup_path(&target_path);
    let (id, flag) = state.begin(window.label(), id);
    let options = ScanOptions {
        detail_depth: detail_depth.unwrap_or(10),
        include_package_contents: false,
        // Belt-and-braces: the firmlinked Data volume must never be pruned by the
        // `st_dev` guard, even on a macOS build where it reports a distinct device.
        protected_roots: if startup {
            vec![PathBuf::from(scan::DATA_VOLUME_PATH)]
        } else {
            Vec::new()
        },
    };

    let target = PathBuf::from(&target_path);
    // The startup volume is walked as `/System`: the APFS firmlink presents the
    // whole Data volume there in one pass, and `split_startup_system` then splits
    // out the Data tree plus the sealed OS-volume remainder (Electron parity).
    //
    // Note on the `st_dev` boundary guard: on macOS the sealed System volume and
    // the firmlinked Data volume share the same `st_dev` (they are the synthesized
    // root pair of one APFS container), so the guard neither prunes Data from this
    // `/System` walk nor from a hypothetical `/`-rooted walk -- `du -x /` crosses
    // into Data for the same reason. The guard only prunes *other* devices
    // (external/`/Volumes` mounts, network mounts). We never root a scan at `/`
    // anyway: startup maps to `/System`, and every other scan uses an explicit
    // user path whose `st_dev` pins the boundary to that folder's volume.
    let walk_root = if startup {
        PathBuf::from("/System")
    } else {
        target
    };
    let emit_app = app.clone();

    let result = tauri::async_runtime::spawn_blocking(move || {
        scan::scan_tree(&walk_root, options, &flag, |progress| {
            let _ = emit_app.emit("scan-progress", progress);
        })
    })
    .await;

    state.finish(window.label(), &id);

    match result {
        Ok(Ok(mut tree)) => {
            if startup {
                tree = scan::split_startup_system(tree);
                scan::append_hidden_space(&mut tree, Path::new(scan::DATA_VOLUME_PATH));
            }
            Ok(ScanResponse::tree(tree))
        }
        Ok(Err(ScanError::Cancelled)) => Ok(ScanResponse::cancelled(Some(id))),
        Ok(Err(error)) => Ok(ScanResponse::error(error.to_string())),
        Err(_) => Ok(ScanResponse::error("Scan task failed")),
    }
}

#[tauri::command(rename_all = "camelCase")]
pub async fn scan_subdir(
    target_path: String,
    include_package_contents: Option<bool>,
) -> ScanResponse {
    if !target_path.starts_with('/') || target_path.starts_with("__") {
        return ScanResponse::error("Invalid filesystem path");
    }

    let allow_package_contents = include_package_contents.unwrap_or(false)
        && PathBuf::from(&target_path)
            .file_name()
            .map(|name| scan::is_package_name(&name.to_string_lossy()))
            .unwrap_or(false);

    let target = PathBuf::from(&target_path);
    let options = ScanOptions {
        detail_depth: 10,
        include_package_contents: allow_package_contents,
        ..ScanOptions::default()
    };
    let cancel = AtomicBool::new(false);

    let result = tauri::async_runtime::spawn_blocking(move || {
        scan::scan_tree(&target, options, &cancel, |_| {})
    })
    .await;

    match result {
        Ok(Ok(tree)) => ScanResponse::tree(tree),
        Ok(Err(error)) => ScanResponse::error(error.to_string()),
        Err(_) => ScanResponse::error("Scan task failed"),
    }
}

#[tauri::command(rename_all = "camelCase")]
pub fn cancel_scan(
    window: Window,
    state: State<'_, ScanJobs>,
    request_id: Option<String>,
) -> CancelResponse {
    match state.cancel(window.label(), request_id.as_deref()) {
        Some(id) => CancelResponse {
            ok: true,
            cancelled: true,
            request_id: Some(id),
            error: None,
        },
        None => CancelResponse {
            ok: false,
            cancelled: false,
            request_id: None,
            error: Some("No matching scan is running".to_string()),
        },
    }
}

#[tauri::command(rename_all = "camelCase")]
pub fn set_window_layout(
    window: Window,
    layout: Option<String>,
    drive_count: Option<u32>,
) -> LayoutResponse {
    let count = drive_count.unwrap_or(0).min(8) as f64;
    let layout = layout.unwrap_or_else(|| "scan".to_string());
    let target_height = if layout == "drives" {
        (210.0 + count * 84.0).clamp(460.0, 860.0)
    } else {
        680.0
    };

    let scale = window.scale_factor().unwrap_or(1.0);
    let width = window
        .inner_size()
        .map(|size| size.width as f64 / scale)
        .unwrap_or(1020.0);

    let _ = window.set_size(LogicalSize::new(width, target_height));
    LayoutResponse {
        ok: true,
        height: Some(target_height),
    }
}

#[tauri::command(rename_all = "camelCase")]
pub async fn choose_folder(app: AppHandle) -> ChooseFolderResponse {
    // The native picker must run on the main thread, so use the callback form
    // and bridge it back with a oneshot channel.
    let (sender, receiver) = tokio::sync::oneshot::channel::<Option<PathBuf>>();
    app.dialog()
        .file()
        .set_title("Choose a folder to scan")
        .pick_folder(move |selection| {
            let resolved = selection.and_then(|file_path| file_path.into_path().ok());
            let _ = sender.send(resolved);
        });

    let Some(folder) = receiver.await.ok().flatten() else {
        return ChooseFolderResponse {
            ok: false,
            cancelled: Some(true),
            ..Default::default()
        };
    };

    let metadata = match std::fs::metadata(&folder) {
        Ok(metadata) => metadata,
        Err(error) => {
            return ChooseFolderResponse {
                ok: false,
                error: Some(error.to_string()),
                ..Default::default()
            }
        }
    };
    if !metadata.is_dir() {
        return ChooseFolderResponse {
            ok: false,
            error: Some("Selected item is not a folder".to_string()),
            ..Default::default()
        };
    }

    let resolved = capacity::resolve_path(&folder.to_string_lossy());
    let resolved_text = resolved.to_string_lossy().into_owned();
    let name = resolved
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| resolved_text.clone());

    let (total, free) = capacity::statfs_info(&resolved)
        .map(|info| {
            (
                info.blocks.saturating_mul(info.block_size),
                info.available_bytes,
            )
        })
        .unwrap_or((0, 0));
    let used = total.saturating_sub(free);
    let use_percent = if total > 0 {
        format!("{}%", (used as u128 * 100) / total as u128)
    } else {
        "0%".to_string()
    };

    ChooseFolderResponse {
        ok: true,
        folder: Some(FolderDrive {
            filesystem: resolved_text.clone(),
            name,
            mount: resolved_text.clone(),
            scan_path: resolved_text,
            total,
            free,
            used,
            use_percent,
            is_startup: false,
            is_custom_folder: true,
        }),
        ..Default::default()
    }
}

#[tauri::command(rename_all = "camelCase")]
pub async fn delete_items(items: Option<Vec<String>>) -> DeleteResponse {
    let requested = items.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || {
        let mut results = Vec::with_capacity(requested.len());
        for item_path in requested {
            if !is_filesystem_path(&item_path) {
                results.push(DeleteResultItem {
                    path: item_path,
                    success: false,
                    error: Some("Invalid filesystem path".to_string()),
                });
                continue;
            }
            if is_protected_system_path(&item_path) {
                results.push(DeleteResultItem {
                    path: item_path,
                    success: false,
                    error: Some("Protected system item".to_string()),
                });
                continue;
            }
            match trash::delete(&item_path) {
                Ok(()) => results.push(DeleteResultItem {
                    path: item_path,
                    success: true,
                    error: None,
                }),
                Err(error) => results.push(DeleteResultItem {
                    path: item_path,
                    success: false,
                    error: Some(error.to_string()),
                }),
            }
        }
        DeleteResponse { results }
    })
    .await
    .unwrap_or_default()
}

#[tauri::command(rename_all = "camelCase")]
pub async fn inspect_item(item_path: Option<String>) -> inspect::InspectItemResponse {
    let path = item_path.unwrap_or_default();
    let fallback = || inspect::InspectItemResponse {
        metadata: None,
        error: Some("Unable to inspect this item".to_string()),
    };
    tauri::async_runtime::spawn_blocking(move || match inspect::inspect_path(&path) {
        Some(metadata) => inspect::InspectItemResponse {
            metadata: Some(metadata),
            error: None,
        },
        None => inspect::InspectItemResponse {
            metadata: None,
            error: Some("Unable to inspect this item".to_string()),
        },
    })
    .await
    .unwrap_or_else(|_| fallback())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn inspect_items(
    item_paths: Option<Vec<String>>,
) -> std::collections::HashMap<String, inspect::ItemMetadata> {
    let paths = item_paths.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || inspect::inspect_many(paths))
        .await
        .unwrap_or_default()
}

#[tauri::command(rename_all = "camelCase")]
pub fn reveal_in_finder(item_path: Option<String>) -> bool {
    let path = item_path.unwrap_or_default();
    if !is_filesystem_path(&path) {
        return false;
    }
    // `open -R` is exactly what `shell.showItemInFolder` does on macOS.
    let _ = std::process::Command::new("/usr/bin/open")
        .arg("-R")
        .arg(&path)
        .spawn();
    true
}

#[tauri::command(rename_all = "camelCase")]
pub async fn inspect_app_related(app_path: Option<String>) -> related::RelatedResourcesResponse {
    let path = app_path.unwrap_or_default();
    let fallback = related::RelatedResourcesResponse::default();
    if !is_filesystem_path(&path) || !path.ends_with(".app") {
        return fallback;
    }
    tauri::async_runtime::spawn_blocking(move || match std::fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.is_dir() => related::RelatedResourcesResponse {
            resources: related::collect_app_related_resources(&path),
        },
        _ => related::RelatedResourcesResponse::default(),
    })
    .await
    .unwrap_or(fallback)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn get_open_with_apps(item_path: Option<String>) -> openwith::GetOpenWithAppsResponse {
    let path = item_path.unwrap_or_default();
    if !is_filesystem_path(&path) {
        return openwith::GetOpenWithAppsResponse {
            apps: Vec::new(),
            error: Some("Invalid filesystem path".to_string()),
        };
    }
    tauri::async_runtime::spawn_blocking(move || openwith::GetOpenWithAppsResponse {
        apps: openwith::open_with_applications(&path),
        error: None,
    })
    .await
    .unwrap_or_default()
}

#[tauri::command(rename_all = "camelCase")]
pub async fn open_with_application(
    app_path: Option<String>,
    item_path: Option<String>,
) -> openwith::OpenWithApplicationResponse {
    let app_path = app_path.unwrap_or_default();
    let item_path = item_path.unwrap_or_default();
    if !is_filesystem_path(&item_path)
        || !is_filesystem_path(&app_path)
        || !app_path.to_lowercase().ends_with(".app")
    {
        return openwith::OpenWithApplicationResponse {
            ok: false,
            error: Some("Invalid application or item path".to_string()),
        };
    }

    tauri::async_runtime::spawn_blocking(move || {
        let app_metadata = std::fs::symlink_metadata(&app_path);
        let item_metadata = std::fs::symlink_metadata(&item_path);
        match (app_metadata, item_metadata) {
            (Ok(app), Ok(item)) => {
                let file_type = item.file_type();
                let item_ok = file_type.is_file() || file_type.is_dir() || file_type.is_symlink();
                if !app.is_dir() || !item_ok {
                    openwith::OpenWithApplicationResponse {
                        ok: false,
                        error: Some("Application or item is unavailable".to_string()),
                    }
                } else {
                    openwith::open_item_with_application(&app_path, &item_path);
                    openwith::OpenWithApplicationResponse {
                        ok: true,
                        error: None,
                    }
                }
            }
            _ => openwith::OpenWithApplicationResponse {
                ok: false,
                error: Some("Application or item is unavailable".to_string()),
            },
        }
    })
    .await
    .unwrap_or_default()
}

#[tauri::command(rename_all = "camelCase")]
pub fn choose_other_application(app: AppHandle, item_path: Option<String>) {
    let path = item_path.unwrap_or_default();
    if !is_filesystem_path(&path) {
        return;
    }
    app.dialog()
        .file()
        .set_title("Choose an application")
        .add_filter("Applications", &["app"])
        .pick_file(move |selection| {
            if let Some(application) = selection.and_then(|file_path| file_path.into_path().ok()) {
                openwith::open_item_with_application(&application.to_string_lossy(), &path);
            }
        });
}

#[tauri::command(rename_all = "camelCase")]
pub async fn finder_get_info(item_path: Option<String>) -> openwith::FinderInfoResponse {
    let path = item_path.unwrap_or_default();
    if !is_filesystem_path(&path) {
        return openwith::FinderInfoResponse {
            ok: false,
            error: Some("Invalid filesystem path".to_string()),
        };
    }
    tauri::async_runtime::spawn_blocking(move || match std::fs::symlink_metadata(&path) {
        Ok(_) => openwith::finder_get_info(&path),
        Err(error) => openwith::FinderInfoResponse {
            ok: false,
            error: Some(error.to_string()),
        },
    })
    .await
    .unwrap_or_default()
}

#[tauri::command(rename_all = "camelCase")]
pub fn watch_current_folder(
    app: AppHandle,
    state: State<'_, watcher::FolderWatch>,
    folder_path: Option<String>,
    enabled: Option<bool>,
) -> watcher::WatchResponse {
    let enabled = enabled.unwrap_or(true);
    let folder_path = folder_path.unwrap_or_default();
    if !enabled || folder_path.is_empty() {
        watcher::stop(&app, &state);
        return watcher::WatchResponse {
            ok: true,
            active: false,
            ..Default::default()
        };
    }
    watcher::start(&app, &state, &folder_path)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn scan_archive(archive_path: Option<String>) -> ScanResponse {
    let path = archive_path.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || match archive::scan(&path) {
        Ok(tree) => ScanResponse::tree(tree),
        Err(error) => ScanResponse::error(error),
    })
    .await
    .unwrap_or_else(|_| ScanResponse::error("Archive could not be listed"))
}

#[tauri::command(rename_all = "camelCase")]
pub fn notify_scan_complete(
    app: AppHandle,
    scan_path: Option<String>,
    item_count: Option<f64>,
) -> serde_json::Value {
    let path = scan_path.unwrap_or_default();
    if !is_filesystem_path(&path) {
        return json!({ "ok": false, "error": "Invalid scan path" });
    }

    let count = match item_count.unwrap_or(0.0) {
        value if value.is_finite() && value > 0.0 => value as u64,
        _ => 0,
    };
    let name = path
        .rsplit('/')
        .next()
        .filter(|name| !name.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| path.clone());
    let title = "Disk scan complete".to_string();
    let body = format!("{count} objects indexed in {name}");

    // System notification. Errors (e.g. permission not yet granted) are
    // non-fatal: the renderer still shows its own toast below.
    let _ = app
        .notification()
        .builder()
        .title(title.clone())
        .body(body.clone())
        .sound("default")
        .show();

    // Renderer toast, matching the Electron `scan-complete` event.
    let _ = app.emit("scan-complete", json!({ "title": title, "body": body }));

    json!({ "ok": true })
}

/// Reusable Full Disk Access probe, mirroring `getFullDiskAccessStatus`.
pub(crate) fn full_disk_access_status() -> String {
    const PROBES: [&str; 3] = [
        "/System/Volumes/Data/private/var/vm",
        "/System/Volumes/Data/private/var/folders",
        "/System/Volumes/Data/.Spotlight-V100",
    ];
    let mut permission_denied = false;
    for probe in PROBES {
        match std::fs::read_dir(probe) {
            Ok(_) => return "granted".to_string(),
            Err(error) => {
                if matches!(error.raw_os_error(), Some(code) if code == libc::EACCES || code == libc::EPERM)
                {
                    permission_denied = true;
                }
            }
        }
    }
    if permission_denied {
        "not-granted".to_string()
    } else {
        "unavailable".to_string()
    }
}

#[tauri::command(rename_all = "camelCase")]
pub async fn get_permission_status() -> serde_json::Value {
    tauri::async_runtime::spawn_blocking(|| {
        json!({
            "fullDiskAccess": full_disk_access_status(),
            "notifications": "optional"
        })
    })
    .await
    .unwrap_or_else(|_| json!({ "fullDiskAccess": "unavailable", "notifications": "optional" }))
}

#[tauri::command(rename_all = "camelCase")]
pub async fn open_system_settings(section: Option<String>) -> serde_json::Value {
    let section = section.unwrap_or_default();
    let url = match section.as_str() {
        "notifications" => "x-apple.systempreferences:com.apple.Notifications-Settings.extension",
        _ => return json!({ "ok": false, "error": "Unknown System Settings section" }),
    };
    let url = url.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        match std::process::Command::new("/usr/bin/open")
            .arg(&url)
            .status()
        {
            Ok(status) if status.success() => json!({ "ok": true, "section": section }),
            Ok(_) => json!({ "ok": false, "error": "System Settings could not be opened" }),
            Err(error) => json!({ "ok": false, "error": error.to_string() }),
        }
    })
    .await
    .unwrap_or_else(|_| json!({ "ok": false, "error": "System Settings could not be opened" }))
}

/// Open an `http(s)` URL in the user's default browser (used by the renderer's
/// "Check for Updates…" affordance). Only http/https URLs are accepted, so the
/// bridge can never launch an arbitrary scheme or a local path.
#[tauri::command(rename_all = "camelCase")]
pub async fn open_external_url(url: Option<String>) -> serde_json::Value {
    let url = url.unwrap_or_default();
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return json!({ "ok": false, "error": "Only http(s) URLs can be opened" });
    }
    tauri::async_runtime::spawn_blocking(move || {
        match std::process::Command::new("/usr/bin/open")
            .arg(&url)
            .status()
        {
            Ok(status) if status.success() => json!({ "ok": true }),
            Ok(_) => json!({ "ok": false, "error": "The link could not be opened" }),
            Err(error) => json!({ "ok": false, "error": error.to_string() }),
        }
    })
    .await
    .unwrap_or_else(|_| json!({ "ok": false, "error": "The link could not be opened" }))
}

#[tauri::command(rename_all = "camelCase")]
pub async fn save_text_file(
    app: AppHandle,
    default_name: Option<String>,
    content: Option<String>,
) -> serde_json::Value {
    let raw_name =
        default_name.unwrap_or_else(|| "Sunburst-Disk-Ask-Siri-Shortcut-Guide.txt".to_string());
    let base = raw_name.rsplit('/').next().unwrap_or(&raw_name);
    let safe_name: String = base
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | ' ' | '-') {
                character
            } else {
                '_'
            }
        })
        .collect();
    let content = content.unwrap_or_default();

    let mut builder = app
        .dialog()
        .file()
        .set_title("Save Shortcut guide")
        .add_filter("Text document", &["txt"]);
    if let Ok(downloads) = app.path().download_dir() {
        builder = builder.set_directory(downloads);
    }
    builder = builder.set_file_name(&safe_name);

    let (sender, receiver) = tokio::sync::oneshot::channel::<Option<PathBuf>>();
    builder.save_file(move |selection| {
        let _ = sender.send(selection.and_then(|file_path| file_path.into_path().ok()));
    });

    let Some(file_path) = receiver.await.ok().flatten() else {
        return json!({ "ok": false, "canceled": true });
    };

    tauri::async_runtime::spawn_blocking(move || {
        match std::fs::write(&file_path, content.as_bytes()) {
            Ok(()) => json!({ "ok": true, "filePath": file_path.to_string_lossy() }),
            Err(error) => json!({ "ok": false, "error": error.to_string() }),
        }
    })
    .await
    .unwrap_or_else(|_| json!({ "ok": false, "error": "The file could not be saved" }))
}

#[tauri::command(rename_all = "camelCase")]
pub async fn eject_drive(mount: Option<String>) -> serde_json::Value {
    let resolved = capacity::resolve_path(&mount.unwrap_or_default())
        .to_string_lossy()
        .into_owned();
    if !resolved.starts_with("/Volumes/") {
        return json!({ "ok": false, "error": "Only mounted external volumes can be ejected." });
    }

    tauri::async_runtime::spawn_blocking(move || {
        let info = capacity::run_capture("/usr/sbin/diskutil", &["info", &resolved]).unwrap_or_default();
        if !capacity::is_ejectable_mount_info(&info) {
            return json!({ "ok": false, "error": "This volume is not reported as ejectable by macOS." });
        }
        match std::process::Command::new("/usr/sbin/diskutil")
            .args(["eject", &resolved])
            .output()
        {
            Ok(output) => {
                let message = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if output.status.success() {
                    json!({ "ok": true, "mount": resolved, "message": message, "error": "" })
                } else {
                    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
                    let error = if stderr.is_empty() {
                        "The volume could not be ejected.".to_string()
                    } else {
                        stderr
                    };
                    json!({ "ok": false, "mount": resolved, "message": message, "error": error })
                }
            }
            Err(error) => json!({ "ok": false, "mount": resolved, "message": "", "error": error.to_string() }),
        }
    })
    .await
    .unwrap_or_else(|_| json!({ "ok": false, "error": "The volume could not be ejected." }))
}

#[tauri::command(rename_all = "camelCase")]
pub async fn open_full_disk_access_settings(app: AppHandle) -> serde_json::Value {
    const FULL_DISK_ACCESS_URL: &str =
        "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles";

    let (sender, receiver) = tokio::sync::oneshot::channel::<bool>();
    app.dialog()
        .message("Hidden Space needs additional macOS permission.")
        .title("Full Disk Access Required")
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Open System Settings".to_string(),
            "Cancel".to_string(),
        ))
        .show(move |confirmed| {
            let _ = sender.send(confirmed);
        });

    if !receiver.await.unwrap_or(false) {
        return json!({ "ok": false, "cancelled": true });
    }

    let _ = tauri::async_runtime::spawn_blocking(move || {
        std::process::Command::new("/usr/bin/open")
            .arg(FULL_DISK_ACCESS_URL)
            .status()
    })
    .await;

    json!({
        "ok": false,
        "settingsOpened": true,
        "error": "Grant Full Disk Access to Sunburst Disk, then try again."
    })
}

#[tauri::command(rename_all = "camelCase")]
pub async fn terminal_authorize_admin(
    app: AppHandle,
    password: Option<String>,
) -> serde_json::Value {
    let password = password.unwrap_or_default();
    if password.is_empty() {
        return json!({ "ok": false, "error": "An administrator password is required." });
    }
    let valid =
        tauri::async_runtime::spawn_blocking(move || terminal::validate_admin_password(&password))
            .await
            .unwrap_or(false);
    app.state::<terminal::TerminalState>().set_admin(valid);
    if valid {
        json!({ "ok": true })
    } else {
        json!({ "ok": false, "error": "Administrator authentication failed." })
    }
}

#[tauri::command(rename_all = "camelCase")]
pub fn terminal_revoke_admin(app: AppHandle) -> serde_json::Value {
    app.state::<terminal::TerminalState>().set_admin(false);
    json!({ "ok": true })
}

#[tauri::command(rename_all = "camelCase")]
pub async fn hidden_space_authorize(
    app: AppHandle,
    window: Window,
    password: Option<String>,
) -> serde_json::Value {
    let password = password.unwrap_or_default();
    if password.is_empty() {
        return json!({ "ok": false, "error": "An administrator password is required." });
    }
    let valid =
        tauri::async_runtime::spawn_blocking(move || terminal::validate_admin_password(&password))
            .await
            .unwrap_or(false);
    app.state::<terminal::TerminalState>()
        .set_hidden_space(window.label(), valid);
    if valid {
        json!({ "ok": true })
    } else {
        json!({ "ok": false, "error": "Administrator authentication failed." })
    }
}

#[tauri::command(rename_all = "camelCase")]
pub fn hidden_space_revoke(app: AppHandle, window: Window) -> serde_json::Value {
    app.state::<terminal::TerminalState>()
        .set_hidden_space(window.label(), false);
    json!({ "ok": true })
}

#[tauri::command(rename_all = "camelCase")]
pub async fn terminal_run_safe(
    app: AppHandle,
    command: Option<String>,
    cwd: Option<String>,
    admin_mode: Option<bool>,
) -> serde_json::Value {
    let trimmed = command.unwrap_or_default().trim().to_string();
    let working_directory = terminal::resolve_working_directory(&cwd.unwrap_or_default());
    let admin_authorized = app.state::<terminal::TerminalState>().admin_authorized();

    let read_only = terminal::read_only_allowed(&trimmed);
    let admin_write = terminal::admin_operation_allowed(&trimmed, &working_directory);
    let use_admin = admin_mode.unwrap_or(false) && admin_authorized;

    if !read_only && !(use_admin && admin_write) {
        let error = if use_admin {
            terminal::admin_denied_message()
        } else {
            terminal::readonly_denied_message()
        };
        return json!({ "ok": false, "error": error });
    }

    if !terminal::directory_accessible(&working_directory) {
        return json!({ "ok": false, "error": "The selected working directory is not accessible." });
    }

    match tauri::async_runtime::spawn_blocking(move || {
        terminal::run_command(&trimmed, &working_directory, use_admin)
    })
    .await
    {
        Ok(result) => serde_json::to_value(result)
            .unwrap_or_else(|_| json!({ "ok": false, "error": "Command failed" })),
        Err(_) => json!({ "ok": false, "error": "Command failed" }),
    }
}

#[tauri::command(rename_all = "camelCase")]
pub async fn scan_hidden_space(
    app: AppHandle,
    window: Window,
    known_size: Option<f64>,
) -> hidden_space::HiddenSpaceResponse {
    if !app
        .state::<terminal::TerminalState>()
        .hidden_space_authorized(window.label())
    {
        return hidden_space::HiddenSpaceResponse {
            ok: false,
            needs_admin: Some(true),
            error: Some(
                "Administrator authorization is required to inspect Hidden Space.".to_string(),
            ),
            ..Default::default()
        };
    }
    let size = known_size.unwrap_or(0.0);
    tauri::async_runtime::spawn_blocking(move || hidden_space::scan(size))
        .await
        .unwrap_or_else(|_| hidden_space::HiddenSpaceResponse {
            ok: false,
            error: Some("Hidden Space could not be inspected".to_string()),
            ..Default::default()
        })
}

#[tauri::command(rename_all = "camelCase")]
pub async fn smart_clean_preview(
    scope: Option<String>,
    folder_path: Option<String>,
    storage_path: Option<String>,
) -> smart_clean::SmartCleanResponse {
    let scope = scope.unwrap_or_else(|| "storage".to_string());
    tauri::async_runtime::spawn_blocking(move || {
        smart_clean::preview(&scope, folder_path.as_deref(), storage_path.as_deref())
    })
    .await
    .unwrap_or_else(|_| smart_clean::SmartCleanResponse {
        ok: false,
        error: Some("Smart Clean preview failed".to_string()),
        ..Default::default()
    })
}

#[tauri::command(rename_all = "camelCase")]
pub async fn setup_ask_siri() -> serde_json::Value {
    tauri::async_runtime::spawn_blocking(ask_siri::setup_ask_siri_shortcut)
        .await
        .unwrap_or_else(|_| json!({ "ok": false, "error": "Ask Siri setup failed" }))
}

#[tauri::command(rename_all = "camelCase")]
pub async fn ask_siri(
    app: AppHandle,
    item_path: Option<String>,
    item_name: Option<String>,
    item: Option<serde_json::Value>,
) -> serde_json::Value {
    let item_path = item_path.unwrap_or_default();
    let item_name = item_name.unwrap_or_default();
    let item = item.unwrap_or_else(|| json!({}));

    let mut start_item = item.as_object().cloned().unwrap_or_default();
    let display_name = if item_name.is_empty() {
        item_path.rsplit('/').next().unwrap_or("").to_string()
    } else {
        item_name.clone()
    };
    start_item.insert("path".to_string(), json!(item_path.clone()));
    start_item.insert("name".to_string(), json!(display_name));
    let _ = app.emit(
        "ask-siri-start",
        json!({ "item": serde_json::Value::Object(start_item) }),
    );

    let result = tauri::async_runtime::spawn_blocking(move || {
        ask_siri::ask_siri_for_item(&item_path, &item_name, &item)
    })
    .await
    .unwrap_or_else(|_| json!({ "ok": false, "error": "Ask Siri failed" }));

    let _ = app.emit("ask-siri-result", result.clone());
    result
}

#[tauri::command(rename_all = "camelCase")]
pub async fn ask_siri_transform(
    mode: Option<String>,
    text: Option<String>,
    item_name: Option<String>,
) -> serde_json::Value {
    let mode = mode.unwrap_or_default();
    let text = text.unwrap_or_default();
    let item_name = item_name.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || {
        ask_siri::reformat_ask_siri_result(&mode, &text, &item_name)
    })
    .await
    .unwrap_or_else(|_| json!({ "ok": false, "error": "Ask Siri formatting failed" }))
}

#[tauri::command(rename_all = "camelCase")]
pub async fn quick_look(
    app: AppHandle,
    item_path: Option<String>,
) -> quick_look::QuickLookResponse {
    let path = item_path.unwrap_or_default();
    if !is_filesystem_path(&path) {
        return quick_look::QuickLookResponse {
            ok: false,
            error: Some("Invalid filesystem path".to_string()),
            ..Default::default()
        };
    }
    match std::fs::symlink_metadata(&path) {
        Ok(metadata) => {
            let file_type = metadata.file_type();
            if !file_type.is_file() && !file_type.is_dir() && !file_type.is_symlink() {
                return quick_look::QuickLookResponse {
                    ok: false,
                    error: Some(
                        "Quick Look is unavailable for this filesystem object.".to_string(),
                    ),
                    ..Default::default()
                };
            }
        }
        Err(error) => {
            return quick_look::QuickLookResponse {
                ok: false,
                error: Some(error.to_string()),
                ..Default::default()
            }
        }
    }

    tauri::async_runtime::spawn_blocking(move || quick_look::start(&app, &path))
        .await
        .unwrap_or_else(|_| quick_look::QuickLookResponse {
            ok: false,
            error: Some("Quick Look failed".to_string()),
            ..Default::default()
        })
}

#[tauri::command(rename_all = "camelCase")]
pub fn quick_look_close() -> quick_look::QuickLookResponse {
    quick_look::close()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filesystem_path_guard_rejects_relative_and_sentinels() {
        assert!(is_filesystem_path("/Users/me/file.txt"));
        assert!(!is_filesystem_path("relative/path"));
        assert!(!is_filesystem_path("__hidden__"));
    }

    #[test]
    fn protected_system_paths_are_blocked() {
        assert!(is_protected_system_path("/System"));
        assert!(is_protected_system_path("/System/Library"));
        assert!(is_protected_system_path("/System/Volumes/Data/System"));
        assert!(is_protected_system_path("/System/Volumes/Data/private/var"));
        assert!(is_protected_system_path("/System/Volumes/Data/usr/local"));
        // User data and apps stay deletable.
        assert!(!is_protected_system_path("/Users/me/Documents"));
        assert!(!is_protected_system_path("/System/Volumes/Data/Users/me"));
        assert!(!is_protected_system_path("/Applications/Safari.app"));
    }

    #[test]
    fn startup_paths_are_detected() {
        assert!(is_startup_path("/"));
        assert!(is_startup_path("/System/Volumes/Data"));
        assert!(!is_startup_path("/Volumes/exAPFS"));
    }
}
