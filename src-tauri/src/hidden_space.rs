//! Hidden Space diagnostics.
//!
//! Ported from the `scan-hidden-space` handler: the diagnostic candidates are
//! measured with the normal scanner and marked as hidden-space rows, plus a
//! `Purgeable space` row from `diskutil` and an "other protected space"
//! remainder that reconciles the original `df`-vs-`du` aggregate.

use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::sync::OnceLock;

use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2_foundation::{
    NSNumber, NSString, NSURLVolumeAvailableCapacityForImportantUsageKey,
    NSURLVolumeAvailableCapacityKey, NSURL,
};
use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::capacity::run_capture;
use crate::commands::full_disk_access_status;
use crate::scan::{self, ScanOptions};
use crate::terminal::directory_accessible;
use crate::types::{NodeType, TreeNode};

const HIDDEN_SPACE_CANDIDATES: [(&str, &str); 5] = [
    ("Virtual memory", "/System/Volumes/Data/private/var/vm"),
    ("System caches", "/System/Volumes/Data/private/var/folders"),
    ("Spotlight index", "/System/Volumes/Data/.Spotlight-V100"),
    (
        "Document revisions",
        "/System/Volumes/Data/.DocumentRevisions-V100",
    ),
    (
        "Installer data",
        "/System/Volumes/Data/.PKInstallSandboxManager",
    ),
];

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct HiddenSpaceResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tree: Option<TreeNode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub needs_admin: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

fn purgeable_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)Purgeable(?: Space| Capacity)?\s*:\s*([0-9][0-9,]*)\s*Bytes?")
            .expect("valid purgeable regex")
    })
}

/// Reads one `NSURLVolume*CapacityKey` as bytes for a file URL.
fn volume_capacity(url: &NSURL, key: &NSString) -> Option<i64> {
    let mut value: Option<Retained<AnyObject>> = None;
    // SAFETY: both keys passed by callers are volume-capacity keys, which return
    // an `NSNumber` for a file URL, so the downcast below is valid.
    unsafe { url.getResourceValue_forKey_error(&mut value, key) }.ok()?;
    let number = value?.downcast::<NSNumber>().ok()?;
    Some(number.longLongValue())
}

/// Purgeable space as Finder/DaisyDisk define it: the difference between the
/// volume's capacity "for important usage" (available plus reclaimable) and its
/// plain available capacity. `None` when Foundation cannot answer.
fn foundation_purgeable_bytes(path: &str) -> Option<u64> {
    let url = NSURL::fileURLWithPath(&NSString::from_str(path));
    let available = volume_capacity(&url, unsafe { NSURLVolumeAvailableCapacityKey })?;
    let important = volume_capacity(&url, unsafe {
        NSURLVolumeAvailableCapacityForImportantUsageKey
    })?;
    Some(important.saturating_sub(available).max(0) as u64)
}

/// `getPurgeableSpaceBytes`. Prefers the Foundation volume capacities; newer
/// macOS (this was observed on 27.2 APFS) no longer prints a `Purgeable Space`
/// line in `diskutil info`, so the regex is only a fallback. `None` means "not
/// reported by macOS".
fn get_purgeable_space_bytes(volume_path: &str) -> Option<u64> {
    if let Some(bytes) = foundation_purgeable_bytes(volume_path) {
        return Some(bytes);
    }
    let stdout = run_capture("/usr/sbin/diskutil", &["info", volume_path])?;
    let captures = purgeable_regex().captures(&stdout)?;
    let digits: String = captures
        .get(1)?
        .as_str()
        .chars()
        .filter(|character| character.is_ascii_digit())
        .collect();
    digits.parse::<u64>().ok()
}

/// Names of local APFS snapshots (Time Machine). Public tooling lists them but
/// does not report their individual block usage, so they are surfaced as a count
/// rather than a measured size; their space is otherwise folded into purgeable.
fn local_snapshots() -> Vec<String> {
    let Some(stdout) = run_capture("/usr/bin/tmutil", &["listlocalsnapshots", "/"]) else {
        return Vec::new();
    };
    stdout
        .lines()
        .map(str::trim)
        .filter(|line| line.contains("com.apple.TimeMachine"))
        .map(str::to_string)
        .collect()
}

/// Mark a subtree as hidden-space diagnostics, mirroring `markHiddenSpaceTree`.
fn mark_hidden_space(node: &mut TreeNode, permission_status: &str, depth: u32) {
    node.hidden_space_diagnostic = Some(true);
    node.hidden_space_depth = Some(depth);
    node.hidden_space_permission_status = Some(permission_status.to_string());
    node.hidden_space_admin_unlocked = Some(true);
    for child in &mut node.children {
        mark_hidden_space(child, permission_status, depth + 1);
    }
}

fn special_node(name: &str, path: &str, size: u64) -> TreeNode {
    TreeNode {
        name: name.to_string(),
        path: path.to_string(),
        size,
        node_type: NodeType::Special,
        ..Default::default()
    }
}

/// Build the Hidden Space tree. The caller must have checked authorization.
pub(crate) fn scan(known_size: f64) -> HiddenSpaceResponse {
    let permission = full_disk_access_status();
    let aggregate = if known_size.is_finite() && known_size > 0.0 {
        known_size as u64
    } else {
        0
    };

    let mut visible: Vec<TreeNode> = Vec::new();
    for (name, path) in HIDDEN_SPACE_CANDIDATES {
        if !directory_accessible(path) {
            continue;
        }
        let cancel = AtomicBool::new(false);
        let options = ScanOptions {
            detail_depth: 8,
            include_package_contents: false,
            ..ScanOptions::default()
        };
        let Ok(mut tree) = scan::scan_tree(Path::new(path), options, &cancel, |_| {}) else {
            continue;
        };
        if tree.size > 0 {
            tree.name = name.to_string();
            tree.path = path.to_string();
            tree.is_hidden_space_child = Some(true);
            mark_hidden_space(&mut tree, &permission, 1);
            visible.push(tree);
        }
    }

    let measured_size: u64 = visible.iter().map(|child| child.size).sum();

    if visible.is_empty() && aggregate == 0 {
        let granted = permission == "granted";
        let mut node = special_node(
            if granted {
                "No visible protected data"
            } else {
                "Still hidden (Full Disk Access required)"
            },
            if granted {
                "__hidden__:empty"
            } else {
                "__hidden__:full-disk-access"
            },
            0,
        );
        node.is_hidden_space_remainder = Some(true);
        node.hidden_space_admin_unlocked = Some(true);
        visible.push(node);
    }

    let purgeable = get_purgeable_space_bytes("/System/Volumes/Data");
    let purgeable_bytes = purgeable.unwrap_or(0);
    let mut purgeable_node = special_node(
        "Purgeable space",
        "__hidden__:purgeable-space",
        purgeable_bytes,
    );
    purgeable_node.hidden_space_diagnostic = Some(true);
    purgeable_node.hidden_space_depth = Some(1);
    purgeable_node.is_hidden_space_remainder = Some(true);
    purgeable_node.hidden_space_unavailable = Some(purgeable.is_none());
    purgeable_node.hidden_space_permission_status = Some(permission.clone());
    purgeable_node.hidden_space_admin_unlocked = Some(true);
    visible.push(purgeable_node);

    let snapshots = local_snapshots();
    let snapshots_size = 0_u64;
    let mut snapshots_node = special_node(
        &if snapshots.is_empty() {
            "Snapshots".to_string()
        } else {
            format!("Snapshots ({})", snapshots.len())
        },
        "__hidden__:snapshots",
        snapshots_size,
    );
    snapshots_node.hidden_space_diagnostic = Some(true);
    snapshots_node.hidden_space_depth = Some(1);
    snapshots_node.is_hidden_space_remainder = Some(true);
    // Present snapshots cannot be sized with public tooling, so flag the row as
    // unmeasured rather than presenting a confident 0 B.
    snapshots_node.hidden_space_unavailable = Some(!snapshots.is_empty());
    snapshots_node.hidden_space_permission_status = Some(permission.clone());
    snapshots_node.hidden_space_admin_unlocked = Some(true);
    visible.push(snapshots_node);

    // The remainder closes the gap between the aggregate and everything we could
    // account for, so it must subtract the purgeable and snapshot rows as well --
    // otherwise the children would sum to more than the parent `hidden space...`.
    let accounted = measured_size
        .saturating_add(purgeable_bytes)
        .saturating_add(snapshots_size);
    let remainder = aggregate.saturating_sub(accounted);
    if remainder > 0 {
        let mut node = special_node(
            "Still hidden",
            "__hidden__:other-protected-space",
            remainder,
        );
        node.is_hidden_space_remainder = Some(true);
        node.hidden_space_diagnostic = Some(true);
        node.hidden_space_depth = Some(1);
        node.hidden_space_admin_unlocked = Some(true);
        visible.push(node);
    }

    let total_size = aggregate.max(measured_size);
    let tree = TreeNode {
        name: "hidden space...".to_string(),
        path: "__hidden__".to_string(),
        size: total_size,
        node_type: NodeType::Directory,
        children: visible,
        hidden_space_aggregate_size: Some(total_size),
        hidden_space_measured_size: Some(measured_size),
        hidden_space_needs_full_disk_access: Some(permission != "granted"),
        hidden_space_permission_status: Some(permission),
        hidden_space_admin_unlocked: Some(true),
        ..Default::default()
    };

    HiddenSpaceResponse {
        ok: true,
        tree: Some(tree),
        ..Default::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unauthorised_shaped_response_has_the_expected_keys() {
        // The command layer builds this variant; verify serialization shape.
        let response = HiddenSpaceResponse {
            ok: false,
            needs_admin: Some(true),
            error: Some(
                "Administrator authorization is required to inspect Hidden Space.".to_string(),
            ),
            ..Default::default()
        };
        let json = serde_json::to_value(&response).expect("serializable");
        assert_eq!(json["ok"], serde_json::json!(false));
        assert_eq!(json["needsAdmin"], serde_json::json!(true));
        assert!(json.get("tree").is_none());
    }

    #[test]
    fn purgeable_regex_matches_diskutil_lines() {
        let text = "   Purgeable Space:            12,345,678 Bytes\n";
        let captures = purgeable_regex().captures(text).expect("match");
        let digits: String = captures
            .get(1)
            .unwrap()
            .as_str()
            .chars()
            .filter(|c| c.is_ascii_digit())
            .collect();
        assert_eq!(digits.parse::<u64>().unwrap(), 12_345_678);
        assert!(purgeable_regex().captures("   Volume Name: x\n").is_none());
    }

    #[test]
    fn foundation_reports_volume_capacities() {
        // Regression guard for the `diskutil` fallback: newer macOS no longer
        // prints a Purgeable line, so Foundation must answer for a real volume.
        let url = NSURL::fileURLWithPath(&NSString::from_str("/"));
        let available = volume_capacity(&url, unsafe { NSURLVolumeAvailableCapacityKey });
        assert!(
            available.is_some_and(|value| value > 0),
            "available capacity for / must be reported"
        );
        assert!(
            foundation_purgeable_bytes("/").is_some(),
            "purgeable space must be derivable for a live volume"
        );
        eprintln!(
            "foundation purgeable bytes: {:?}",
            foundation_purgeable_bytes("/")
        );
    }

    #[test]
    #[ignore = "probe: real hidden-space scan (~seconds)"]
    fn hidden_space_probe() {
        let response = scan(0.0);
        let tree = response.tree.expect("tree present");
        eprintln!("hidden space rows:");
        for child in &tree.children {
            eprintln!(
                "  {:<28} {:>14} bytes  unavailable={:?}",
                child.name, child.size, child.hidden_space_unavailable
            );
        }
    }

    #[test]
    fn mark_sets_depth_recursively() {
        let mut node = TreeNode {
            children: vec![TreeNode::default()],
            ..Default::default()
        };
        mark_hidden_space(&mut node, "granted", 1);
        assert_eq!(node.hidden_space_depth, Some(1));
        assert_eq!(node.children[0].hidden_space_depth, Some(2));
        assert_eq!(node.children[0].hidden_space_admin_unlocked, Some(true));
    }
}
