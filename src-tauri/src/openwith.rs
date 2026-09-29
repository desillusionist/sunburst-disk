//! "Open With" support and the Finder "Get Info" action.
//!
//! `open_with_applications` replaces the Swift `openwith-applications` helper
//! with a direct `NSWorkspace` query via objc2, so no native helper binary has
//! to be bundled. Opening with an application and Finder Get Info keep using
//! the same `/usr/bin/open` and `/usr/bin/osascript` calls as Electron.

use std::collections::HashSet;

use objc2_app_kit::NSWorkspace;
use objc2_foundation::{NSArray, NSString, NSURL};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct OpenWithApp {
    pub label: String,
    pub app_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GetOpenWithAppsResponse {
    pub apps: Vec<OpenWithApp>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FinderInfoResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct OpenWithApplicationResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// `Safari.app` -> `Safari` (suffix stripped case-insensitively).
fn app_label(app_path: &str) -> String {
    let base = app_path.rsplit('/').next().unwrap_or(app_path);
    if base.len() >= 4 && base[base.len() - 4..].eq_ignore_ascii_case(".app") {
        base[..base.len() - 4].to_string()
    } else {
        base.to_string()
    }
}

/// Applications LaunchServices would offer for `path`, deduplicated and capped
/// at 80, mirroring `listOpenWithApplications`.
pub(crate) fn open_with_applications(path: &str) -> Vec<OpenWithApp> {
    let ns_path = NSString::from_str(path);
    let url = NSURL::fileURLWithPath(&ns_path);
    let applications = NSWorkspace::sharedWorkspace().URLsForApplicationsToOpenURL(&url);
    let applications: &NSArray<NSURL> = &applications;

    let mut seen: HashSet<String> = HashSet::new();
    let mut result = Vec::new();
    for index in 0..applications.count() {
        let application = applications.objectAtIndex(index);
        let Some(application_path) = application.path() else {
            continue;
        };
        let application_path = application_path.to_string();
        if !application_path.to_lowercase().ends_with(".app")
            || !seen.insert(application_path.clone())
        {
            continue;
        }
        result.push(OpenWithApp {
            label: app_label(&application_path),
            app_path: application_path,
        });
        if result.len() >= 80 {
            break;
        }
    }
    result
}

/// Fire-and-forget `open -a <app> <item>`.
pub(crate) fn open_item_with_application(app_path: &str, item_path: &str) {
    let _ = std::process::Command::new("/usr/bin/open")
        .args(["-a", app_path, item_path])
        .spawn();
}

/// Reveal the item in Finder and open its information window, matching
/// `openFinderGetInfo`.
pub(crate) fn finder_get_info(item_path: &str) -> FinderInfoResponse {
    // serde_json produces a safely quoted, escaped literal for AppleScript.
    let quoted = serde_json::to_string(item_path).unwrap_or_else(|_| "\"\"".to_string());
    let script = format!(
        "tell application \"Finder\"\n  activate\n  set targetItem to (POSIX file {quoted} as alias)\n  reveal targetItem\n  open information window of targetItem\nend tell"
    );

    let _ = std::process::Command::new("/usr/bin/open")
        .args(["-R", item_path])
        .status();

    match std::process::Command::new("/usr/bin/osascript")
        .args(["-e", &script])
        .output()
    {
        Ok(output) if output.status.success() => FinderInfoResponse {
            ok: true,
            error: None,
        },
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            FinderInfoResponse {
                ok: false,
                error: Some(if stderr.is_empty() {
                    "Finder Get Info failed".to_string()
                } else {
                    stderr
                }),
            }
        }
        Err(error) => FinderInfoResponse {
            ok: false,
            error: Some(error.to_string()),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_strip_the_app_suffix() {
        assert_eq!(app_label("/Applications/Safari.app"), "Safari");
        assert_eq!(app_label("/System/Applications/Music.app"), "Music");
        assert_eq!(
            app_label("/Applications/Visual Studio Code.app"),
            "Visual Studio Code"
        );
        assert_eq!(app_label("/opt/tool"), "tool");
    }

    #[test]
    fn workspace_query_returns_normally() {
        // In a desktop session this lists editors/browsers; in a headless
        // sandbox it may be empty. Either way the objc2 NSWorkspace FFI call
        // must execute and return without panicking.
        let sample = concat!(env!("CARGO_MANIFEST_DIR"), "/Cargo.toml");
        let applications = open_with_applications(sample);
        eprintln!(
            "open_with_applications returned {} app(s)",
            applications.len()
        );
        for application in &applications {
            assert!(application.app_path.to_lowercase().ends_with(".app"));
            assert!(!application.label.is_empty());
        }
    }
}
