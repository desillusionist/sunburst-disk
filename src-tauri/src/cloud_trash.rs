//! Cloud "Move to Google Drive Trash" — the one write path allowed on cloud
//! FileProvider trees.
//!
//! Guardrails (see `docs/electron-to-tauri-migration.md`, r39):
//!   * only paths inside a File Provider cloud domain are eligible — the local
//!     Collector's delete path can never be reached from here;
//!   * protected system paths are still refused;
//!   * the call uses `NSFileManager.trashItem` (the `trash` crate's
//!     `NsFileManager` method, not its Finder/osascript default): the provider
//!     moves the item to its own cloud Trash, and a **dataless placeholder is
//!     never downloaded** to do so (proven in the Phase A spike);
//!   * nothing here ever reads, downloads, pins or materialises content.

use std::sync::atomic::{AtomicBool, Ordering};

use trash::macos::TrashContextExtMacos;

use crate::commands::is_protected_system_path;
use crate::types::{CloudTrashItem, CloudTrashProgress, CloudTrashResponse, CloudTrashResult};

/// True when `path` sits inside a File Provider cloud domain.
pub(crate) fn is_cloud_storage_path(path: &str) -> bool {
    path.contains("/Library/CloudStorage/") || path.contains("/Library/Mobile Documents/")
}

/// The reason a path may not be trashed, or `None` when it may.
pub(crate) fn trash_refusal(path: &str) -> Option<String> {
    if !path.starts_with('/') || path.starts_with("__") {
        return Some("Invalid filesystem path".to_string());
    }
    if is_protected_system_path(path) {
        return Some("Protected system item".to_string());
    }
    if !is_cloud_storage_path(path) {
        return Some("Not a cloud item".to_string());
    }
    None
}

fn is_ancestor(ancestor: &str, descendant: &str) -> bool {
    descendant.len() > ancestor.len()
        && descendant.starts_with(ancestor)
        && descendant.as_bytes()[ancestor.len()] == b'/'
}

/// Drop any item whose ancestor is also staged: trashing the parent removes the
/// child too, and a separate call for the child would only fail.
pub(crate) fn dedupe_nested(mut items: Vec<CloudTrashItem>) -> Vec<CloudTrashItem> {
    items.sort_by(|a, b| a.path.cmp(&b.path));
    items.dedup_by(|a, b| a.path == b.path);
    let mut kept: Vec<CloudTrashItem> = Vec::with_capacity(items.len());
    for item in items {
        if kept
            .iter()
            .any(|parent| is_ancestor(&parent.path, &item.path))
        {
            continue;
        }
        kept.push(item);
    }
    kept
}

/// Trash the staged cloud items **sequentially**, reporting progress after each
/// and honouring `cancel` between items. Sequential (never thousands of
/// concurrent provider calls) keeps the provider and the user's network calm.
pub(crate) fn trash_items(
    items: Vec<CloudTrashItem>,
    cancel: &AtomicBool,
    mut progress: impl FnMut(CloudTrashProgress),
) -> CloudTrashResponse {
    let staged = dedupe_nested(items);
    let total = staged.len() as u64;
    let mut results: Vec<CloudTrashResult> = Vec::with_capacity(staged.len());
    let mut succeeded = 0u64;
    let mut failed = 0u64;
    let mut canceled = false;

    // One context for the whole batch. `NsFileManager` means no Finder sound, no
    // Automation permission, and provider-mediated removal (no download).
    let mut context = trash::TrashContext::new();
    context.set_delete_method(trash::macos::DeleteMethod::NsFileManager);

    progress(CloudTrashProgress {
        done: 0,
        total,
        ..Default::default()
    });

    for item in staged {
        if cancel.load(Ordering::Relaxed) {
            canceled = true;
            break;
        }
        let (success, error) = match trash_refusal(&item.path) {
            Some(reason) => (false, Some(reason)),
            None => match context.delete(&item.path) {
                Ok(()) => (true, None),
                Err(err) => (false, Some(err.to_string())),
            },
        };
        if success {
            succeeded += 1;
        } else {
            failed += 1;
        }
        let result = CloudTrashResult {
            path: item.path,
            name: item.name,
            success,
            error,
        };
        progress(CloudTrashProgress {
            done: results.len() as u64 + 1,
            total,
            current_path: result.path.clone(),
            current_name: result.name.clone(),
            failed,
        });
        results.push(result);
    }

    CloudTrashResponse {
        results,
        canceled,
        total,
        succeeded,
        failed,
        error: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cloud_path_detection_is_narrow() {
        assert!(is_cloud_storage_path(
            "/Users/x/Library/CloudStorage/GoogleDrive-a/My Drive/f.txt"
        ));
        assert!(is_cloud_storage_path(
            "/Users/x/Library/Mobile Documents/com~apple~CloudDocs/f.txt"
        ));
        assert!(!is_cloud_storage_path("/Users/x/Documents/f.txt"));
        assert!(!is_cloud_storage_path(
            "/Users/x/Library/Preferences/f.plist"
        ));
    }

    #[test]
    fn refuses_non_cloud_and_protected_paths() {
        assert_eq!(
            trash_refusal("/Users/x/Documents/f.txt").as_deref(),
            Some("Not a cloud item")
        );
        assert_eq!(
            trash_refusal("/System/Library/thing").as_deref(),
            Some("Protected system item")
        );
        assert_eq!(
            trash_refusal("__hidden__").as_deref(),
            Some("Invalid filesystem path")
        );
        assert!(trash_refusal("/Users/x/Library/CloudStorage/P/My Drive/f.txt").is_none());
    }

    #[test]
    fn nested_duplicates_are_dropped() {
        let items = vec![
            CloudTrashItem {
                path: "/Users/x/Library/CloudStorage/P/My Drive/a".into(),
                name: "a".into(),
                size: 1,
            },
            CloudTrashItem {
                path: "/Users/x/Library/CloudStorage/P/My Drive/a/b".into(),
                name: "b".into(),
                size: 2,
            },
            CloudTrashItem {
                path: "/Users/x/Library/CloudStorage/P/My Drive/c".into(),
                name: "c".into(),
                size: 3,
            },
        ];
        let kept = dedupe_nested(items);
        let paths: Vec<&str> = kept.iter().map(|item| item.path.as_str()).collect();
        assert_eq!(
            paths,
            vec![
                "/Users/x/Library/CloudStorage/P/My Drive/a",
                "/Users/x/Library/CloudStorage/P/My Drive/c",
            ]
        );
    }

    #[test]
    fn non_cloud_items_fail_before_the_filesystem_is_touched() {
        let cancel = AtomicBool::new(false);
        let items = vec![CloudTrashItem {
            path: "/definitely/not/cloud/f.txt".into(),
            name: "f.txt".into(),
            size: 1,
        }];
        let mut events = 0;
        let response = trash_items(items, &cancel, |_| events += 1);
        assert_eq!(response.total, 1);
        assert_eq!(response.succeeded, 0);
        assert_eq!(response.failed, 1);
        assert_eq!(
            response.results[0].error.as_deref(),
            Some("Not a cloud item")
        );
        assert!(
            events >= 2,
            "expected an initial and a per-item progress event"
        );
    }

    #[test]
    fn cancellation_stops_before_the_first_item() {
        let cancel = AtomicBool::new(true);
        let items = vec![CloudTrashItem {
            path: "/Users/x/Library/CloudStorage/P/My Drive/a".into(),
            name: "a".into(),
            size: 1,
        }];
        let response = trash_items(items, &cancel, |_| {});
        assert!(response.canceled);
        assert_eq!(response.total, 1);
        assert_eq!(response.succeeded, 0);
        assert!(response.results.is_empty());
    }
}
