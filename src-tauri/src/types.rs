//! Wire types shared between the Rust core and the React renderer.
//!
//! Field names and casing match the JSON the Electron main process produced so
//! the existing renderer keeps working unchanged (`App.jsx` reads `node.type`,
//! `drive.usePercent`, `data.tree`, `data.canceled`, and so on).

use serde::{Deserialize, Serialize};

/// One node of the sunburst / content-tree model.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TreeNode {
    pub name: String,
    pub path: String,
    pub size: u64,
    #[serde(rename = "type")]
    pub node_type: NodeType,
    pub children: Vec<TreeNode>,
    /// Number of descendants (files and directories), excluding `self`.
    pub item_count: u64,
    /// Presence marks a node that belongs to a cloud FileProvider tree. The
    /// renderer treats every such node as read-only: it can never be added to the
    /// deletion collector and never appears in Smart Clean.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cloud_managed: Option<bool>,
    /// Presence marks a cloud snapshot that stopped at its entry/time budget, so
    /// every size below it is a lower bound rather than a total.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub truncated: Option<bool>,
    /// Present only on the synthetic `hidden space...` reconciliation node.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hidden_space_aggregate_size: Option<u64>,
    /// Archive-viewer fields; `None` for ordinary filesystem scans.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub archive_virtual: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub archive_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub archive_entry: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub archive_container: Option<bool>,
    /// Modification time in milliseconds; used by the archive root row.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modified_at: Option<f64>,
    /// Hidden-space diagnostic fields.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_hidden_space_child: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_hidden_space_remainder: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hidden_space_unavailable: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hidden_space_diagnostic: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hidden_space_depth: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hidden_space_permission_status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hidden_space_admin_unlocked: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hidden_space_measured_size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hidden_space_needs_full_disk_access: Option<bool>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum NodeType {
    #[default]
    Directory,
    File,
    Special,
}

/// A mounted volume as shown on the Home screen.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Drive {
    pub filesystem: String,
    pub name: String,
    pub total: u64,
    pub used: u64,
    pub free: u64,
    pub use_percent: String,
    pub mount: String,
    pub scan_path: String,
    pub is_startup: bool,
    pub is_ejectable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DrivesResponse {
    pub drives: Vec<Drive>,
    pub user_home: String,
}

/// Result of `scan-directory` / `scan-subdir`. Exactly one of `tree`,
/// `canceled`, or `error` is set, mirroring the Electron handler's contract.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ScanResponse {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tree: Option<TreeNode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub canceled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl ScanResponse {
    pub fn cancelled(request_id: Option<String>) -> Self {
        Self {
            canceled: Some(true),
            request_id,
            ..Default::default()
        }
    }

    pub fn error(message: impl Into<String>) -> Self {
        Self {
            error: Some(message.into()),
            ..Default::default()
        }
    }

    pub fn tree(tree: TreeNode) -> Self {
        Self {
            tree: Some(tree),
            ..Default::default()
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CancelResponse {
    pub ok: bool,
    pub cancelled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LayoutResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<f64>,
}

/// A user-picked folder presented as a drive-shaped object for `handleScanDrive`.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FolderDrive {
    pub filesystem: String,
    pub name: String,
    pub mount: String,
    pub scan_path: String,
    pub total: u64,
    pub free: u64,
    pub used: u64,
    pub use_percent: String,
    pub is_startup: bool,
    pub is_custom_folder: bool,
}

/// Result of `choose-folder`.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ChooseFolderResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cancelled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub folder: Option<FolderDrive>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DeleteResultItem {
    pub path: String,
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Result of `delete-items`; one entry per requested path, in order.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DeleteResponse {
    pub results: Vec<DeleteResultItem>,
}

/// Payload emitted on the `scan-progress` event.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ScanProgress {
    pub current_dir: String,
    pub items_scanned: u64,
    /// `-1` means "indeterminate", matching the renderer's expectation.
    pub percent: i64,
}
