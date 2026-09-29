//! App-related resource discovery for `inspect-app-related`.
//!
//! Ported from `collectAppRelatedResources`: for a `.app` bundle it finds the
//! user-side data macOS keeps in `~/Library` (containers, caches, preferences,
//! saved state, ...) that belongs to the app, so the Collector can offer it
//! alongside the bundle itself.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use crate::capacity::run_capture;

const MAX_CANDIDATES: usize = 24;
const MAX_SEARCH_RESULTS: usize = 40;
const MEASURE_THREADS: usize = 6;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RelatedResource {
    pub name: String,
    pub path: String,
    #[serde(rename = "type")]
    pub resource_type: String,
    pub size: u64,
    pub relation: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RelatedResourcesResponse {
    pub resources: Vec<RelatedResource>,
}

fn basename(path: &str) -> String {
    path.rsplit('/').next().unwrap_or(path).to_string()
}

fn dirname(path: &str) -> String {
    match path.rfind('/') {
        Some(0) => "/".to_string(),
        Some(index) => path[..index].to_string(),
        None => ".".to_string(),
    }
}

/// Lowercase, drop a trailing `.app`, and keep only `[a-z0-9]`.
pub(crate) fn normalize_token(value: &str) -> String {
    let lower = value.to_lowercase();
    let stripped = lower.strip_suffix(".app").unwrap_or(&lower);
    stripped
        .chars()
        .filter(|character| character.is_ascii_lowercase() || character.is_ascii_digit())
        .collect()
}

/// True when `name` normalises to a token or starts with one.
pub(crate) fn related_name_matches(name: &str, tokens: &[String]) -> bool {
    let normalized = normalize_token(name);
    !normalized.is_empty()
        && tokens.iter().any(|token| {
            !token.is_empty() && (normalized == *token || normalized.starts_with(token.as_str()))
        })
}

/// Files keep their logical size; directories use `du -sk -x` disk usage,
/// matching `measureRelatedPath`.
fn measure_related_path(path: &str) -> u64 {
    let Ok(metadata) = std::fs::symlink_metadata(path) else {
        return 0;
    };
    let file_type = metadata.file_type();
    if file_type.is_file() || file_type.is_symlink() {
        return metadata.len();
    }
    match run_capture("/usr/bin/du", &["-sk", "-x", path]) {
        Some(stdout) => stdout
            .split_whitespace()
            .next()
            .and_then(|kb| kb.parse::<u64>().ok())
            .map(|kb| kb.saturating_mul(1024))
            .unwrap_or(0),
        None => 0,
    }
}

fn build_resource(path: &str) -> Option<RelatedResource> {
    let metadata = std::fs::symlink_metadata(path).ok()?;
    Some(RelatedResource {
        name: basename(path),
        path: path.to_string(),
        resource_type: if metadata.is_dir() {
            "directory"
        } else {
            "file"
        }
        .to_string(),
        size: measure_related_path(path),
        relation: basename(&dirname(path)),
    })
}

fn push_unique(list: &mut Vec<String>, seen: &mut HashSet<String>, value: String) {
    if seen.insert(value.clone()) {
        list.push(value);
    }
}

/// Collect `~/Library` resources related to the app bundle at `app_path`.
pub(crate) fn collect_app_related_resources(app_path: &str) -> Vec<RelatedResource> {
    let base = basename(app_path);
    let app_name = base.strip_suffix(".app").unwrap_or(&base).to_string();
    let app_token = normalize_token(&app_name);
    if app_token.is_empty() {
        return Vec::new();
    }

    let home = std::env::var("HOME").unwrap_or_default();
    let library = format!("{home}/Library");

    let mut tokens = vec![app_token];
    let mut direct = vec![
        format!("{library}/Application Support/{app_name}"),
        format!("{library}/Caches/{app_name}"),
        format!("{library}/Logs/{app_name}"),
        format!("{library}/WebKit/{app_name}"),
        format!("{library}/HTTPStorages/{app_name}"),
        format!("{library}/Saved Application State/{app_name}.savedState"),
    ];

    // Read the bundle identifier without walking or launching the bundle.
    let info_plist = format!("{app_path}/Contents/Info.plist");
    if let Some(bundle_id) = run_capture(
        "/usr/bin/plutil",
        &[
            "-extract",
            "CFBundleIdentifier",
            "raw",
            "-o",
            "-",
            &info_plist,
        ],
    )
    .map(|stdout| stdout.trim().to_string())
    .filter(|value| !value.is_empty())
    {
        let bundle_token = normalize_token(&bundle_id);
        if !bundle_token.is_empty() && !tokens.contains(&bundle_token) {
            tokens.push(bundle_token);
        }
        direct.push(format!("{library}/Preferences/{bundle_id}.plist"));
        direct.push(format!("{library}/Containers/{bundle_id}"));
        direct.push(format!("{library}/WebKit/{bundle_id}"));
        direct.push(format!("{library}/HTTPStorages/{bundle_id}"));
        direct.push(format!(
            "{library}/Saved Application State/{bundle_id}.savedState"
        ));
    }

    let search_roots = [
        "Application Support",
        "Caches",
        "Logs",
        "Containers",
        "Group Containers",
        "WebKit",
        "HTTPStorages",
        "Saved Application State",
        "Preferences",
    ];

    let mut candidates: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for candidate in direct {
        push_unique(&mut candidates, &mut seen, candidate);
    }
    for root in search_roots {
        if candidates.len() >= MAX_SEARCH_RESULTS {
            break;
        }
        let root_path = format!("{library}/{root}");
        let Ok(entries) = std::fs::read_dir(&root_path) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if related_name_matches(&name, &tokens) {
                push_unique(&mut candidates, &mut seen, format!("{root_path}/{name}"));
            }
            if candidates.len() >= MAX_SEARCH_RESULTS {
                break;
            }
        }
    }

    let selected: Vec<String> = candidates
        .into_iter()
        .filter(|path| path != app_path)
        .take(MAX_CANDIDATES)
        .collect();
    if selected.is_empty() {
        return Vec::new();
    }

    // Measuring directory sizes spawns `du`; fan out a few at a time.
    let mut resources: Vec<RelatedResource> = std::thread::scope(|scope| {
        let handles: Vec<_> = selected
            .chunks(MEASURE_THREADS)
            .map(|chunk| {
                scope.spawn(move || {
                    chunk
                        .iter()
                        .filter_map(|path| build_resource(path))
                        .collect::<Vec<_>>()
                })
            })
            .collect();
        handles
            .into_iter()
            .flat_map(|handle| handle.join().unwrap_or_default())
            .collect()
    });

    resources.sort_by_key(|resource| std::cmp::Reverse(resource.size));
    resources
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_strip_app_suffix_and_punctuation() {
        assert_eq!(normalize_token("Safari.app"), "safari");
        assert_eq!(normalize_token("Google Chrome"), "googlechrome");
        assert_eq!(normalize_token("com.apple.Safari"), "comapplesafari");
        assert_eq!(normalize_token(""), "");
    }

    #[test]
    fn related_names_match_by_prefix() {
        let tokens = vec!["safari".to_string(), "comapplesafari".to_string()];
        assert!(related_name_matches("Safari", &tokens));
        assert!(related_name_matches("Safari.app", &tokens));
        assert!(related_name_matches("com.apple.Safari", &tokens));
        assert!(related_name_matches("SafariTechnologyPreview", &tokens));
        assert!(!related_name_matches("Firefox", &tokens));
        assert!(!related_name_matches("", &tokens));
    }

    #[test]
    fn basename_and_dirname_helpers() {
        assert_eq!(basename("/a/b/c.plist"), "c.plist");
        assert_eq!(dirname("/a/b/c.plist"), "/a/b");
        assert_eq!(basename(&dirname("/a/b/c.plist")), "b");
        assert_eq!(dirname("/c"), "/");
    }
}
