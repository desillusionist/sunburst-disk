//! Mounted-volume discovery, ported from the `get-drives` IPC handler.

use std::collections::HashSet;

use crate::capacity::{is_ejectable_mount_info, run_capture};
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

fn fallback_drives() -> Vec<Drive> {
    vec![
        Drive {
            filesystem: "/dev/disk3s5".into(),
            name: "iDāsOS".into(),
            total: 245_100_000_000,
            used: 231_300_000_000,
            free: 22_700_000_000,
            use_percent: "89%".into(),
            mount: "/".into(),
            scan_path: "/System/Volumes/Data".into(),
            is_startup: true,
            is_ejectable: false,
        },
        Drive {
            filesystem: "/dev/disk7s1".into(),
            name: "exAPFS".into(),
            total: 2_000_000_000_000,
            used: 216_100_000_000,
            free: 1_783_900_000_000,
            use_percent: "11%".into(),
            mount: "/Volumes/exAPFS".into(),
            scan_path: "/Volumes/exAPFS".into(),
            is_startup: false,
            is_ejectable: true,
        },
        Drive {
            filesystem: "/dev/disk8s1".into(),
            name: "I-MOVIES".into(),
            total: 2_000_000_000_000,
            used: 1_286_900_000_000,
            free: 713_100_000_000,
            use_percent: "64%".into(),
            mount: "/Volumes/I-MOVIES".into(),
            scan_path: "/Volumes/I-MOVIES".into(),
            is_startup: false,
            is_ejectable: true,
        },
    ]
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
            let percent = if total > 0 {
                format!("{}%", (used as u128 * 100) / total as u128)
            } else {
                use_percent
            };
            drives.push(Drive {
                filesystem: parts[0].clone(),
                name: "iDāsOS".into(),
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
    fn fallback_has_startup_drive() {
        let drives = fallback_drives();
        assert!(drives.iter().any(|drive| drive.is_startup));
        assert_eq!(drives.len(), 3);
    }
}
