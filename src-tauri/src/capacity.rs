//! Volume capacity reads: `statfs(2)` plus the `/bin/df` and `/usr/sbin/diskutil`
//! probes that `electron/main.js` used. The returned JSON keeps the exact shape
//! the renderer's `syncDriveCapacityFromSnapshot` and telemetry expect.

use std::ffi::CString;
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

use regex::Regex;
use serde_json::{json, Value};

#[derive(Debug, Clone, Copy, Default)]
pub struct StatfsInfo {
    pub blocks: u64,
    pub bfree: u64,
    pub bavail: u64,
    pub block_size: u64,
    pub used_bytes: u64,
    pub available_bytes: u64,
}

/// Wrap `statfs(2)`; returns `None` if the path cannot be inspected.
pub fn statfs_info(path: &Path) -> Option<StatfsInfo> {
    let c_path = CString::new(path.as_os_str().as_bytes()).ok()?;
    let mut stats: libc::statfs = unsafe { std::mem::zeroed() };
    let rc = unsafe { libc::statfs(c_path.as_ptr(), &mut stats) };
    if rc != 0 {
        return None;
    }
    let block_size = stats.f_bsize as u64;
    let blocks = stats.f_blocks as u64;
    let bfree = stats.f_bfree as u64;
    let bavail = stats.f_bavail as u64;
    Some(StatfsInfo {
        blocks,
        bfree,
        bavail,
        block_size,
        used_bytes: blocks.saturating_sub(bfree).saturating_mul(block_size),
        available_bytes: bavail.saturating_mul(block_size),
    })
}

/// Resolve a user-supplied path to an absolute, lexically-normalised path
/// without touching symlinks (matching Node's `path.resolve`).
pub fn resolve_path(input: &str) -> PathBuf {
    let raw = PathBuf::from(input);
    let absolute = if raw.is_absolute() {
        raw
    } else {
        std::env::current_dir()
            .map(|cwd| cwd.join(&raw))
            .unwrap_or(raw)
    };
    let text = absolute.to_string_lossy();
    let trimmed = text.trim_end_matches('/');
    if trimmed.is_empty() {
        PathBuf::from("/")
    } else {
        PathBuf::from(trimmed)
    }
}

/// Run a command and return stdout, or `None` on failure.
pub fn run_capture(program: &str, args: &[&str]) -> Option<String> {
    let output = Command::new(program).args(args).output().ok()?;
    if !output.status.success() && output.stdout.is_empty() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).into_owned())
}

#[derive(Debug, Clone, Default)]
pub struct DfCapacity {
    pub filesystem: String,
    pub blocks1024: u64,
    pub used1024: u64,
    pub available1024: u64,
    pub capacity: String,
    pub mounted_on: String,
}

/// Parse the single data row of `df -kP <path>`.
pub fn parse_df_capacity(stdout: &str) -> Option<DfCapacity> {
    let line = stdout.lines().nth(1)?.trim();
    if line.is_empty() {
        return None;
    }
    let parts: Vec<&str> = line.split_whitespace().collect();
    if parts.len() < 6 {
        return None;
    }
    let blocks = parts[1].parse::<u64>().ok()?;
    let used = parts[2].parse::<u64>().ok()?;
    let available = parts[3].parse::<u64>().ok()?;
    let capacity = parts[4].to_string();
    let mounted_on = parts[5..].join(" ");
    Some(DfCapacity {
        filesystem: parts[0].to_string(),
        blocks1024: blocks,
        used1024: used,
        available1024: available,
        capacity,
        mounted_on,
    })
}

/// Find `Label: value` inside `diskutil info` output (case-insensitive).
pub fn diskutil_field(info: &str, label: &str) -> Option<String> {
    let prefix = format!("{}:", label.to_lowercase());
    for line in info.lines() {
        let trimmed = line.trim_start();
        if trimmed.to_lowercase().starts_with(&prefix) {
            let value = trimmed[prefix.len()..].trim();
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }
    None
}

/// Extract the byte count from a `diskutil` value such as
/// `Volume Used Space`. Handles both `N Bytes (x GB)` and `x GB (N Bytes)`.
pub fn diskutil_capacity(info: &str, label: &str) -> Option<u64> {
    let value = diskutil_field(info, label)?;
    let lower = value.to_lowercase();
    let bytes_index = lower.find("bytes")?;
    let prefix = value[..bytes_index].trim_end();
    let digits: String = prefix
        .chars()
        .rev()
        .take_while(|character| character.is_ascii_digit() || *character == ',')
        .filter(|character| character.is_ascii_digit())
        .collect::<String>()
        .chars()
        .rev()
        .collect();
    digits.parse::<u64>().ok()
}

fn diskutil_info(path: &Path) -> String {
    run_capture("/usr/sbin/diskutil", &["info", &path.to_string_lossy()]).unwrap_or_default()
}

/// Build the full capacity snapshot for a path.
pub fn get_capacity_snapshot(target_path: &str) -> Value {
    let resolved = resolve_path(target_path);
    let resolved_text = resolved.to_string_lossy().into_owned();

    let df_text = run_capture("/bin/df", &["-kP", &resolved_text]).unwrap_or_default();
    let df = parse_df_capacity(&df_text);
    let info = diskutil_info(&resolved);
    let statfs = statfs_info(&resolved);

    let is_startup = resolved_text == "/" || resolved_text == "/System/Volumes/Data";

    let drive = json!({
        "filesystem": df.as_ref().map(|value| value.filesystem.clone()),
        "mount": df.as_ref().map(|value| value.mounted_on.clone()).unwrap_or_else(|| resolved_text.clone()),
        "scanPath": resolved_text,
        "isStartup": is_startup,
    });

    let df_json = df.map(|value| {
        json!({
            "filesystem": value.filesystem,
            "blocks1024": value.blocks1024,
            "used1024": value.used1024,
            "available1024": value.available1024,
            "capacity": value.capacity,
            "mountedOn": value.mounted_on,
            "usedBytes": value.used1024 * 1024,
            "availableBytes": value.available1024 * 1024,
            "totalBytes": value.blocks1024 * 1024,
        })
    });

    let statfs_json = statfs.map(|stats| {
        json!({
            "blocks": stats.blocks,
            "bfree": stats.bfree,
            "bavail": stats.bavail,
            "blockSize": stats.block_size,
            "usedBytes": stats.used_bytes,
            "availableBytes": stats.available_bytes,
        })
    });

    let diskutil = json!({
        "deviceIdentifier": diskutil_field(&info, "Device Identifier"),
        "volumeName": diskutil_field(&info, "Volume Name"),
        "volumeUsedBytes": diskutil_capacity(&info, "Volume Used Space"),
        "volumeFreeBytes": diskutil_capacity(&info, "Volume Free Space"),
        "containerTotalBytes": diskutil_capacity(&info, "Container Total Space"),
        "containerFreeBytes": diskutil_capacity(&info, "Container Free Space"),
        "diskSizeBytes": diskutil_capacity(&info, "Disk Size"),
    });

    json!({
        "source": "fresh",
        "capturedPath": resolved_text,
        "drive": drive,
        "df": df_json,
        "statfs": statfs_json,
        "diskutil": diskutil,
        "symlinks": {
            "policy": "do-not-follow-external-targets",
            "externalTargetsFollowed": false,
            "entriesSeen": Value::Null,
            "entriesExcluded": Value::Null,
        }
    })
}

/// True when `diskutil info` marks a volume as external/removable/ejectable.
///
/// `diskutil info` aligns columns with multiple spaces, so the Electron regexes
/// used `\s+` — a plain substring match with a single space never matches.
pub fn is_ejectable_mount_info(info: &str) -> bool {
    fn device_location() -> &'static Regex {
        static RE: OnceLock<Regex> = OnceLock::new();
        RE.get_or_init(|| {
            Regex::new(r"(?i)Device Location:\s+External").expect("valid device-location regex")
        })
    }
    fn removable_media() -> &'static Regex {
        static RE: OnceLock<Regex> = OnceLock::new();
        RE.get_or_init(|| {
            Regex::new(r"(?i)Removable Media:\s+(?:Removable|Ejectable)")
                .expect("valid removable-media regex")
        })
    }
    device_location().is_match(info) || removable_media().is_match(info)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_df_line() {
        let output = "Filesystem 1024-blocks      Used Available Capacity Mounted on\n/dev/disk3s5  994662584 812345678  223456789     79%   /System/Volumes/Data\n";
        let parsed = parse_df_capacity(output).expect("df row should parse");
        assert_eq!(parsed.filesystem, "/dev/disk3s5");
        assert_eq!(parsed.blocks1024, 994_662_584);
        assert_eq!(parsed.used1024, 812_345_678);
        assert_eq!(parsed.available1024, 223_456_789);
        assert_eq!(parsed.capacity, "79%");
        assert_eq!(parsed.mounted_on, "/System/Volumes/Data");
    }

    #[test]
    fn parses_diskutil_capacity_labels() {
        let info = "   Device Identifier:         disk3s5\n   Volume Name:               iDāsOS\n   Volume Used Space:         812,345,678 Bytes (812.3 GB)\n";
        assert_eq!(
            diskutil_field(info, "Device Identifier").as_deref(),
            Some("disk3s5")
        );
        assert_eq!(
            diskutil_field(info, "Volume Name").as_deref(),
            Some("iDāsOS")
        );
        assert_eq!(
            diskutil_capacity(info, "Volume Used Space"),
            Some(812_345_678)
        );

        // The GB-first layout must parse identically.
        let gb_first = "   Volume Free Space:         22.7 GB (22,700,000,000 Bytes)\n";
        assert_eq!(
            diskutil_capacity(gb_first, "Volume Free Space"),
            Some(22_700_000_000)
        );
    }

    #[test]
    fn statfs_reports_used_space() {
        let info = statfs_info(Path::new("/")).expect("statfs on / should work");
        assert!(info.blocks > 0);
        assert!(info.used_bytes > 0);
    }

    #[test]
    fn ejectable_detection_handles_diskutil_column_spacing() {
        // diskutil aligns values with multiple spaces; `\s+` must match.
        let external =
            "   Device Location:          External\n   Removable Media:          Fixed\n";
        assert!(is_ejectable_mount_info(external));
        let removable =
            "   Device Location:          Internal\n   Removable Media:          Removable\n";
        assert!(is_ejectable_mount_info(removable));
        let ejectable = "   Removable Media:          Ejectable\n";
        assert!(is_ejectable_mount_info(ejectable));
        let internal =
            "   Device Location:          Internal\n   Removable Media:          Fixed\n";
        assert!(!is_ejectable_mount_info(internal));
        assert!(!is_ejectable_mount_info(""));
    }
}
