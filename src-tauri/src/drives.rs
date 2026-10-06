//! Mounted-volume discovery, ported from the `get-drives` IPC handler.

use std::collections::HashSet;

use crate::capacity::{diskutil_field, is_ejectable_mount_info, run_capture};
use crate::types::{Drive, DrivesResponse};

/// Mount points that are hidden from the Home screen.
const EXCLUDED_MOUNTS: [&str; 8] = [
    "/dev",
    "/System/Volumes/VM",
    "/System/Volumes/Preboot",
    "/System/Volumes/Update",
    "/System/Volumes/xarts",
    "/System/Volumes/iSCPreboot",
    "/System/Volumes/Hardware",
    // The recoveryOS volume mounts here on Apple silicon; it is system-managed
    // and not a user storage target.
    "/Volumes/Recovery",
];

/// Display name of the startup disk as the user named it (for example
/// "Macintosh HD"). The sealed System volume mounted at `/` carries that name;
/// the Data volume is often just "Data", so it is not used as a source.
fn startup_volume_name() -> String {
    if let Some(info) = run_capture("/usr/sbin/diskutil", &["info", "/"]) {
        if let Some(name) = diskutil_field(&info, "Volume Name") {
            let name = name.trim();
            if !name.is_empty() && !name.contains("com.apple") {
                return name.to_string();
            }
        }
    }
    "Macintosh HD".to_string()
}

/// Minimal single-drive list used only when `df` cannot be read at all. It never
/// invents volumes or capacities: the startup disk is shown without metrics.
fn fallback_drives() -> Vec<Drive> {
    vec![Drive {
        filesystem: String::new(),
        name: startup_volume_name(),
        total: 0,
        used: 0,
        free: 0,
        use_percent: String::new(),
        mount: "/".into(),
        scan_path: "/System/Volumes/Data".into(),
        is_startup: true,
        is_ejectable: false,
    }]
}

/// Fullness of a volume whose free space is shared with its APFS container.
///
/// `df` reports a volume `total` that is the *volume's* size while `available` is
/// the container's shared free space, so `used / total` understates fullness badly
/// (a 245 GB disk with 148 MB free reads as 75%). The real fraction is
/// `used / (used + available)`, which is also what `df`'s "Capacity" column shows;
/// like `df`, round up.
fn capacity_percent(used: u64, free: u64, fallback: String) -> String {
    let capacity = used.saturating_add(free);
    if capacity == 0 {
        return fallback;
    }
    format!("{}%", (used as u128 * 100).div_ceil(capacity as u128))
}

fn excluded(mount: &str) -> bool {
    EXCLUDED_MOUNTS
        .iter()
        .any(|prefix| mount.starts_with(prefix))
        || mount == "/System/Volumes/Data/home"
}

fn user_home() -> String {
    std::env::var("HOME").unwrap_or_else(|_| "/".to_string())
}

fn mount_of(parts: &[String]) -> String {
    parts[8..].join(" ")
}

fn kib_to_bytes(parts: &[String], index: usize) -> u64 {
    parts
        .get(index)
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0)
        .saturating_mul(1024)
}

/// Enumerate mounted volumes from `df -k`, enriching `/Volumes/*` entries with
/// `diskutil` so external volumes can show an Eject action.
pub fn get_drives() -> DrivesResponse {
    let home = user_home();
    let Some(stdout) = run_capture("/bin/df", &["-k"]) else {
        return DrivesResponse {
            drives: fallback_drives(),
            user_home: home,
        };
    };

    // Parse every row first so the startup merge can look up the Data volume
    // regardless of ordering.
    let rows: Vec<Vec<String>> = stdout
        .lines()
        .skip(1)
        .map(|line| {
            line.split_whitespace()
                .map(str::to_string)
                .collect::<Vec<String>>()
        })
        .filter(|parts| {
            parts.len() >= 9 && mount_of(parts).starts_with('/') && !excluded(&mount_of(parts))
        })
        .collect();

    let mut drives: Vec<Drive> = Vec::new();
    let startup_name = startup_volume_name();
    for parts in &rows {
        let mount = mount_of(parts);
        let use_percent = parts[4].clone();

        if mount == "/" || mount == "/System/Volumes/Data" {
            // The root mount's `df` row describes the read-only System volume,
            // not real disk fullness; prefer the Data volume's numbers.
            let mut total = kib_to_bytes(parts, 1);
            let mut used = kib_to_bytes(parts, 2);
            let mut free = kib_to_bytes(parts, 3);
            if let Some(data_row) = rows
                .iter()
                .find(|row| mount_of(row) == "/System/Volumes/Data")
            {
                let data_total = kib_to_bytes(data_row, 1);
                if data_total > 0 {
                    total = data_total;
                    used = kib_to_bytes(data_row, 2);
                    free = kib_to_bytes(data_row, 3);
                }
            }
            let percent = capacity_percent(used, free, use_percent);
            drives.push(Drive {
                filesystem: parts[0].clone(),
                name: startup_name.clone(),
                total,
                used,
                free,
                use_percent: percent,
                mount: mount.clone(),
                scan_path: "/System/Volumes/Data".into(),
                is_startup: true,
                is_ejectable: false,
            });
            continue;
        }

        let name = mount
            .strip_prefix("/Volumes/")
            .map(str::to_string)
            .unwrap_or_else(|| mount.clone());
        drives.push(Drive {
            filesystem: parts[0].clone(),
            name,
            total: kib_to_bytes(parts, 1),
            used: kib_to_bytes(parts, 2),
            free: kib_to_bytes(parts, 3),
            use_percent,
            mount: mount.clone(),
            scan_path: mount.clone(),
            is_startup: false,
            is_ejectable: false,
        });
    }

    // De-duplicate by display name, keeping the first occurrence.
    let mut unique: Vec<Drive> = Vec::new();
    let mut seen_names: HashSet<String> = HashSet::new();
    for drive in drives {
        if seen_names.insert(drive.name.clone()) {
            unique.push(drive);
        }
    }

    for drive in &mut unique {
        if drive.is_startup || !drive.mount.starts_with("/Volumes/") {
            continue;
        }
        let info = run_capture("/usr/sbin/diskutil", &["info", &drive.mount]).unwrap_or_default();
        drive.is_ejectable = is_ejectable_mount_info(&info);
    }

    if unique.is_empty() {
        unique = fallback_drives();
    }

    DrivesResponse {
        drives: unique,
        user_home: home,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn excluded_mounts_are_filtered() {
        assert!(excluded("/dev"));
        assert!(excluded("/System/Volumes/VM"));
        assert!(excluded("/System/Volumes/Hardware"));
        assert!(excluded("/System/Volumes/Data/home"));
        assert!(!excluded("/"));
        assert!(!excluded("/Volumes/exAPFS"));
    }

    #[test]
    fn capacity_percent_uses_shared_free_space() {
        // 180.2 GB used with 27 GB of shared free space is 87%, not used/total (75%).
        assert_eq!(
            capacity_percent(180_230_064, 26_980_536, "0%".into()),
            "87%"
        );
        // A volume with 148 MB free on a 245 GB disk is effectively full.
        assert_eq!(
            capacity_percent(245_000_000_000 - 148_000_000, 148_000_000, "0%".into()),
            "100%"
        );
        // No usable numbers: keep whatever `df` reported.
        assert_eq!(capacity_percent(0, 0, "42%".into()), "42%");
    }

    #[test]
    fn fallback_is_a_single_named_startup_drive() {
        let drives = fallback_drives();
        assert_eq!(drives.len(), 1);
        assert!(drives[0].is_startup);
        assert_eq!(drives[0].mount, "/");
        assert!(!drives[0].name.is_empty());
    }
}
