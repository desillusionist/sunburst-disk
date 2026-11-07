//! Read-only terminal plus scoped administrator write commands.
//!
//! Ported from `electron/main.js`. The security model is unchanged:
//!   * a read-only command allowlist (`SAFE_TERMINAL_COMMANDS`) runs under the
//!     user's shell,
//!   * an administrator password establishes a reusable sudo credential (a
//!     plain `sudo -S -v` after `sudo -k`), then a narrow, path-scoped write
//!     allowlist (`SAFE_ADMIN_COMMANDS`) runs under `sudo -n`,
//!   * every write target must resolve inside the current folder and outside
//!     the protected System roots.
//!
//! The allowlists are expressed with the `regex` crate using the *same* pattern
//! sources as Electron, so behaviour stays identical.

use std::collections::HashSet;
use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::capacity::resolve_path;
use crate::commands::is_protected_system_path;

const SAFE_TERMINAL_ARGUMENT: &str = r"[^\n\r;|&><`$]+";
const SAFE_ADMIN_ARGUMENT: &str = r#"[A-Za-z0-9_./~'() "-]+"#;
const COMMAND_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_OUTPUT_BYTES: usize = 2 * 1024 * 1024;

const ADMIN_DENIED: &str = "Allowed commands are read-only helpers plus scoped touch, mkdir -p, rm, mv, cp -R and ln -s on mounted drives. Protected system paths (System, usr, private, etc.) and arbitrary shell commands remain blocked. Paths that contain spaces must be quoted, e.g. mv \"My App\" /Volumes/External/.";
const READONLY_DENIED: &str = "Only read-only commands are allowed: pwd, ls, du -sh and df -h.";

static SAFE_TERMINAL_COMMANDS: OnceLock<Regex> = OnceLock::new();
static SAFE_ADMIN_COMMANDS: OnceLock<Regex> = OnceLock::new();
static ADMIN_TOKENIZER: OnceLock<Regex> = OnceLock::new();

fn safe_terminal_commands() -> &'static Regex {
    SAFE_TERMINAL_COMMANDS.get_or_init(|| {
        Regex::new(&format!(
            r"^(?:pwd|df -h|ls(?: -la|-lah)?(?: {argument})?|du -sh(?: {argument})?)$",
            argument = SAFE_TERMINAL_ARGUMENT
        ))
        .expect("valid terminal command regex")
    })
}

fn safe_admin_commands() -> &'static Regex {
    SAFE_ADMIN_COMMANDS.get_or_init(|| {
        Regex::new(&format!(
            r"^(?:touch|mkdir -p|rm(?: -i)?(?: --)?|mv(?: --)?|cp -R(?: --)?|ln -s(?: --)?) {argument}(?: {argument})?$",
            argument = SAFE_ADMIN_ARGUMENT
        ))
        .expect("valid admin command regex")
    })
}

fn admin_tokenizer() -> &'static Regex {
    ADMIN_TOKENIZER
        .get_or_init(|| Regex::new(r#""[^"]*"|'[^']*'|[^\s]+"#).expect("valid tokenizer regex"))
}

/// Shared, session-scoped authorization state.
#[derive(Default)]
pub struct TerminalState {
    admin_authorized: Mutex<bool>,
    hidden_space_authorized: Mutex<HashSet<String>>,
}

impl TerminalState {
    pub fn set_admin(&self, value: bool) {
        if let Ok(mut admin) = self.admin_authorized.lock() {
            *admin = value;
        }
    }

    pub fn admin_authorized(&self) -> bool {
        self.admin_authorized
            .lock()
            .map(|admin| *admin)
            .unwrap_or(false)
    }

    pub fn set_hidden_space(&self, label: &str, value: bool) {
        if let Ok(mut senders) = self.hidden_space_authorized.lock() {
            if value {
                senders.insert(label.to_string());
            } else {
                senders.remove(label);
            }
        }
    }

    pub fn hidden_space_authorized(&self, label: &str) -> bool {
        self.hidden_space_authorized
            .lock()
            .map(|senders| senders.contains(label))
            .unwrap_or(false)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CommandRun {
    pub ok: bool,
    pub command: String,
    pub cwd: String,
    pub admin_mode: bool,
    pub stdout: String,
    pub stderr: String,
    pub error: String,
    /// Set when an admin command could not run because sudo needed a password
    /// again (the cached credential expired). The renderer re-opens the prompt.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub needs_admin: Option<bool>,
}

pub(crate) fn read_only_allowed(command: &str) -> bool {
    safe_terminal_commands().is_match(command)
}

pub(crate) fn admin_denied_message() -> &'static str {
    ADMIN_DENIED
}

pub(crate) fn readonly_denied_message() -> &'static str {
    READONLY_DENIED
}

/// Lexically resolve `.`/`..` without touching the filesystem (like `path.resolve`).
fn lexical_normalize(input: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for component in input.split('/') {
        match component {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    format!("/{}", parts.join("/"))
}

fn resolve_against(base: &str, target: &str) -> String {
    if target.starts_with('/') {
        lexical_normalize(target)
    } else {
        lexical_normalize(&format!("{}/{}", base.trim_end_matches('/'), target))
    }
}

fn expand_tilde(value: &str, home: &str) -> String {
    if value == "~" {
        return home.to_string();
    }
    if let Some(rest) = value.strip_prefix("~/") {
        return format!("{home}/{rest}");
    }
    value.to_string()
}

/// Mounts that are system-managed and never legitimate write targets. Mirrors
/// the hidden mounts the Home screen excludes.
const HIDDEN_MOUNTS: [&str; 8] = [
    "/dev",
    "/System/Volumes/VM",
    "/System/Volumes/Preboot",
    "/System/Volumes/Update",
    "/System/Volumes/xarts",
    "/System/Volumes/iSCPreboot",
    "/System/Volumes/Hardware",
    "/Volumes/Recovery",
];

fn is_hidden_mount(path: &str) -> bool {
    HIDDEN_MOUNTS
        .iter()
        .any(|mount| path == *mount || path.starts_with(&format!("{mount}/")))
}

/// Top-level locations that are system-owned. These are the firmlink aliases that
/// point into the Data volume, so widening the admin scope must not reach them.
const PROTECTED_ADMIN_ROOTS: [&str; 10] = [
    "/bin", "/sbin", "/usr", "/etc", "/private", "/var", "/tmp", "/dev", "/cores", "/Library",
];

/// Stronger protected-path check for *admin writes* than the shared
/// `is_protected_system_path`: it also covers the firmlink aliases (`/usr`,
/// `/private`, `/etc`, …) that resolve into `/System/Volumes/Data/...`.
fn is_protected_admin_target(value: &str) -> bool {
    if is_protected_system_path(value) {
        return true;
    }
    let normalized = value.trim_end_matches('/');
    let under =
        |prefix: &str| normalized == prefix || normalized.starts_with(&format!("{prefix}/"));
    if PROTECTED_ADMIN_ROOTS.iter().any(|prefix| under(prefix)) {
        return true;
    }
    [
        "bin", "sbin", "usr", "etc", "private", "var", "tmp", "dev", "cores", "Library",
    ]
    .iter()
    .any(|segment| under(&format!("/System/Volumes/Data/{segment}")))
}

/// Resolve symlinks in the longest existing prefix of `path` (for the safety
/// checks only) so a symlink cannot smuggle a protected location past the
/// lexical checks. Non-existent tail components are re-appended lexically.
fn real_check_path(path: &str) -> String {
    let mut probe = std::path::PathBuf::from(path);
    let mut tail: Vec<String> = Vec::new();
    loop {
        if let Ok(canonical) = probe.canonicalize() {
            let mut result = canonical.to_string_lossy().into_owned();
            for part in tail.iter().rev() {
                result.push('/');
                result.push_str(part);
            }
            return lexical_normalize(&result);
        }
        let Some(name) = probe
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
        else {
            break;
        };
        tail.push(name);
        if !probe.pop() {
            break;
        }
    }
    lexical_normalize(path)
}

/// Mount points of the user-visible drives (`/` plus `/Volumes/*`), excluding
/// hidden/system mounts. Read from the same `df -k` the Home screen uses.
fn mounted_drive_roots() -> Vec<String> {
    let mut roots = vec!["/".to_string()];
    if let Some(stdout) = crate::capacity::run_capture("/bin/df", &["-k"]) {
        for line in stdout.lines().skip(1) {
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() < 9 {
                continue;
            }
            let mount = parts[8..].join(" ");
            if !mount.starts_with('/') || is_hidden_mount(&mount) {
                continue;
            }
            if !roots.iter().any(|root| root == &mount) {
                roots.push(mount);
            }
        }
    }
    roots
}

/// True when `path` lives on a mounted drive the app exposes. `/` is the startup
/// disk, so this is true for essentially every absolute path; it exists to keep
/// the rule explicit and to reject hidden/system mounts.
pub(crate) fn within_mounted_drives(path: &str) -> bool {
    if is_hidden_mount(path) {
        return false;
    }
    mounted_drive_roots()
        .iter()
        .any(|root| root == "/" || path == root || path.starts_with(&format!("{root}/")))
}

/// Resolve a write target against `working_directory`, allowing it to leave that
/// folder but requiring it to stay on a mounted drive and outside protected roots.
fn admin_target_path(raw_target: &str, working_directory: &str) -> Option<String> {
    if raw_target.is_empty() || raw_target.starts_with('-') {
        return None;
    }
    let home = std::env::var("HOME").unwrap_or_default();
    let expanded = expand_tilde(raw_target, &home);
    let resolved = resolve_against(working_directory, &expanded);
    if resolved == "/" {
        return None;
    }
    // Check both the lexical path and the symlink-resolved path, so a symlink
    // inside an allowed folder cannot point at a protected location.
    let real = real_check_path(&resolved);
    if real == "/"
        || is_protected_admin_target(&resolved)
        || is_protected_admin_target(&real)
        || !within_mounted_drives(&real)
    {
        return None;
    }
    Some(resolved)
}

fn parse_simple_admin_command(command: &str) -> Option<Vec<String>> {
    if !safe_admin_commands().is_match(command) {
        return None;
    }
    Some(
        admin_tokenizer()
            .find_iter(command)
            .map(|matched| {
                let token = matched.as_str();
                let quoted = token.len() >= 2
                    && ((token.starts_with('"') && token.ends_with('"'))
                        || (token.starts_with('\'') && token.ends_with('\'')));
                if quoted {
                    token[1..token.len() - 1].to_string()
                } else {
                    token.to_string()
                }
            })
            .collect(),
    )
}

/// True when `command` is an allowlisted admin write whose targets are all on a
/// mounted drive and outside the protected system roots. Targets may leave
/// `working_directory`; the folder only anchors relative paths.
pub(crate) fn admin_operation_allowed(command: &str, working_directory: &str) -> bool {
    let normalized = lexical_normalize(working_directory);
    let Some(tokens) = parse_simple_admin_command(command) else {
        return false;
    };
    if tokens.is_empty() {
        return false;
    }
    // The working directory only anchors relative targets now; each target is
    // validated against the mounted drives and the protected system roots.

    match tokens[0].as_str() {
        "touch" if tokens.len() == 2 => admin_target_path(&tokens[1], &normalized).is_some(),
        "mkdir" if tokens.len() == 3 && tokens[1] == "-p" => {
            admin_target_path(&tokens[2], &normalized).is_some()
        }
        // `--` is optional: targets are validated individually and one that
        // starts with `-` is rejected, so a flag cannot masquerade as a path.
        "rm" if (2..=4).contains(&tokens.len()) => {
            let target = tokens.last().expect("non-empty tokens");
            let flags_ok = tokens[1..tokens.len() - 1]
                .iter()
                .all(|token| token == "-i" || token == "--");
            flags_ok && admin_target_path(target, &normalized).is_some()
        }
        "mv" if tokens.len() == 3 => {
            admin_target_path(&tokens[1], &normalized).is_some()
                && admin_target_path(&tokens[2], &normalized).is_some()
        }
        "mv" if tokens.len() == 4 && tokens[1] == "--" => {
            admin_target_path(&tokens[2], &normalized).is_some()
                && admin_target_path(&tokens[3], &normalized).is_some()
        }
        "cp" if tokens.len() == 4 && tokens[1] == "-R" => {
            admin_target_path(&tokens[2], &normalized).is_some()
                && admin_target_path(&tokens[3], &normalized).is_some()
        }
        "cp" if tokens.len() == 5 && tokens[1] == "-R" && tokens[2] == "--" => {
            admin_target_path(&tokens[3], &normalized).is_some()
                && admin_target_path(&tokens[4], &normalized).is_some()
        }
        "ln" if tokens.len() == 4 && tokens[1] == "-s" => {
            admin_target_path(&tokens[2], &normalized).is_some()
                && admin_target_path(&tokens[3], &normalized).is_some()
        }
        "ln" if tokens.len() == 5 && tokens[1] == "-s" && tokens[2] == "--" => {
            admin_target_path(&tokens[3], &normalized).is_some()
                && admin_target_path(&tokens[4], &normalized).is_some()
        }
        _ => false,
    }
}

/// Whether a command runs under `sudo -n`.
///
/// Only an admin *write* does: a read-only helper must keep working when the
/// sudo ticket has expired, otherwise `ls` would prompt for a password and drop
/// the unlocked session.
pub(crate) fn should_use_admin(admin_mode: bool, admin_authorized: bool, read_only: bool) -> bool {
    admin_mode && admin_authorized && !read_only
}

/// Why an admin command was refused, so the UI can explain the reason instead of
/// only showing the generic allowlist message. `None` when it is allowed.
pub(crate) fn admin_denial_reason(command: &str, working_directory: &str) -> Option<&'static str> {
    if admin_operation_allowed(command, working_directory) {
        return None;
    }
    let normalized = lexical_normalize(working_directory);
    let Some(tokens) = parse_simple_admin_command(command) else {
        return Some(admin_denied_message());
    };
    let targets: Vec<&str> = match tokens.first().map(String::as_str) {
        Some("touch") if tokens.len() == 2 => vec![&tokens[1]],
        Some("mkdir") if tokens.len() == 3 && tokens[1] == "-p" => vec![&tokens[2]],
        Some("rm") if (2..=4).contains(&tokens.len()) => {
            vec![tokens.last().expect("non-empty tokens")]
        }
        Some("mv") if tokens.len() == 3 => vec![&tokens[1], &tokens[2]],
        Some("mv") if tokens.len() == 4 && tokens[1] == "--" => vec![&tokens[2], &tokens[3]],
        Some("cp") if tokens.len() == 4 && tokens[1] == "-R" => vec![&tokens[2], &tokens[3]],
        Some("cp") if tokens.len() == 5 && tokens[1] == "-R" && tokens[2] == "--" => {
            vec![&tokens[3], &tokens[4]]
        }
        Some("ln") if tokens.len() == 4 && tokens[1] == "-s" => vec![&tokens[2], &tokens[3]],
        Some("ln") if tokens.len() == 5 && tokens[1] == "-s" && tokens[2] == "--" => {
            vec![&tokens[3], &tokens[4]]
        }
        _ => return Some(admin_denied_message()),
    };
    let home = std::env::var("HOME").unwrap_or_default();
    for target in targets {
        if target.is_empty() || target.starts_with('-') {
            return Some("Options and flags are not allowed in admin write commands.");
        }
        let resolved = resolve_against(&normalized, &expand_tilde(target, &home));
        let real = real_check_path(&resolved);
        if resolved == "/" || real == "/" {
            return Some("The filesystem root is not a valid write target.");
        }
        if is_protected_admin_target(&resolved) || is_protected_admin_target(&real) {
            return Some(
                "The target is inside a protected system path (System, usr, private, Library, …).",
            );
        }
        if !within_mounted_drives(&real) {
            return Some("The target is outside the mounted drives.");
        }
    }
    Some(admin_denied_message())
}

/// Run sudo non-interactively, feeding `password` on stdin when one is given.
fn run_sudo(args: &[&str], password: Option<&str>) -> bool {
    let mut command = Command::new("/usr/bin/sudo");
    command
        .args(args)
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    command.stdin(if password.is_some() {
        Stdio::piped()
    } else {
        Stdio::null()
    });

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(_) => return false,
    };

    if let Some(password) = password {
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(format!("{password}\n").as_bytes());
        }
    }

    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) => {
                if start.elapsed() >= COMMAND_TIMEOUT {
                    let _ = child.kill();
                    let _ = child.wait();
                    return false;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(_) => return false,
        }
    }
}

/// Authenticate `password` *and* leave a reusable credential behind.
///
/// `sudo -S -k -v` only validates: since sudo 1.9.10 `-k` combined with an
/// option that may require a password makes sudo ignore cached credentials and
/// deliberately not update them. The later `sudo -n` calls therefore found no
/// ticket and looped on "a password is required". So: drop any cached ticket
/// (a stale one must never make a wrong password look valid), authenticate with
/// a plain `-v` -- which *does* update the cache -- then prove the ticket the
/// run path depends on actually exists.
pub(crate) fn validate_admin_password(password: &str) -> bool {
    if password.is_empty() {
        return false;
    }
    let _ = run_sudo(&["-k"], None);
    if !run_sudo(&["-S", "-v"], Some(password)) {
        return false;
    }
    run_sudo(&["-n", "-v"], None)
}

/// True when an admin command failed because sudo needed the password again
/// (the cached credential expired or was never established).
fn sudo_needs_password(use_admin: bool, success: bool, stderr: &str) -> bool {
    use_admin
        && !success
        && (stderr.contains("a password is required")
            || stderr.contains("a terminal is required")
            || stderr.contains("no tty present"))
}

fn read_capped<R: Read>(mut reader: R) -> String {
    let mut buffer: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        match reader.read(&mut chunk) {
            Ok(0) => break,
            Ok(read) => {
                // Keep draining the pipe after the cap so the child never blocks.
                if buffer.len() < MAX_OUTPUT_BYTES {
                    buffer.extend_from_slice(&chunk[..read]);
                }
            }
            Err(_) => break,
        }
    }
    buffer.truncate(MAX_OUTPUT_BYTES);
    String::from_utf8_lossy(&buffer).into_owned()
}

fn capture(
    program: &str,
    args: &[&str],
    cwd: &str,
    timeout: Duration,
) -> Result<(bool, String, String, bool), String> {
    let mut child = Command::new(program)
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| error.to_string())?;

    let stdout = child.stdout.take().ok_or_else(|| "no stdout".to_string())?;
    let stderr = child.stderr.take().ok_or_else(|| "no stderr".to_string())?;
    let stdout_thread = std::thread::spawn(move || read_capped(stdout));
    let stderr_thread = std::thread::spawn(move || read_capped(stderr));

    let start = Instant::now();
    let mut timed_out = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {
                if start.elapsed() >= timeout {
                    timed_out = true;
                    let _ = child.kill();
                    let _ = child.wait();
                    break None;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(_) => break None,
        }
    };

    let stdout = stdout_thread.join().unwrap_or_default();
    let stderr = stderr_thread.join().unwrap_or_default();
    let success = !timed_out && status.map(|status| status.success()).unwrap_or(false);
    Ok((success, stdout, stderr, timed_out))
}

/// Run an allowlisted command (already validated) and capture its output.
pub(crate) fn run_command(command: &str, working_directory: &str, use_admin: bool) -> CommandRun {
    let (program, args): (&str, Vec<&str>) = if use_admin {
        ("/usr/bin/sudo", vec!["-n", "/bin/zsh", "-lc", command])
    } else {
        ("/bin/zsh", vec!["-lc", command])
    };

    let base = CommandRun {
        command: command.to_string(),
        cwd: working_directory.to_string(),
        admin_mode: use_admin,
        ..Default::default()
    };

    match capture(program, &args, working_directory, COMMAND_TIMEOUT) {
        Ok((success, stdout, stderr, timed_out)) => {
            // `sudo -n` fails this way when the cached credential has expired (or
            // was never established): the caller must ask for the password again.
            let needs_admin = sudo_needs_password(use_admin, success, &stderr);
            let error = if needs_admin {
                "Administrator authorization expired. Enter your macOS password again.".to_string()
            } else if success {
                String::new()
            } else if timed_out {
                "Command timed out".to_string()
            } else if stdout.is_empty() && stderr.is_empty() {
                "Command failed".to_string()
            } else {
                String::new()
            };
            CommandRun {
                ok: success,
                stdout,
                stderr,
                error,
                needs_admin: needs_admin.then_some(true),
                ..base
            }
        }
        Err(error) => CommandRun { error, ..base },
    }
}

/// Resolve the working directory the same way `terminal-run-safe` does.
pub(crate) fn resolve_working_directory(cwd: &str) -> String {
    if cwd.starts_with('/') && !cwd.starts_with("__") {
        resolve_path(cwd).to_string_lossy().into_owned()
    } else {
        std::env::var("HOME").unwrap_or_else(|_| "/".to_string())
    }
}

/// Whether `directory` is readable and searchable (`R_OK | X_OK`).
pub(crate) fn directory_accessible(directory: &str) -> bool {
    match std::ffi::CString::new(directory) {
        Ok(path) => unsafe { libc::access(path.as_ptr(), libc::R_OK | libc::X_OK) == 0 },
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CWD: &str = "/Users/me/projects";

    #[test]
    fn read_only_allowlist() {
        assert!(read_only_allowed("pwd"));
        assert!(read_only_allowed("ls -la"));
        assert!(read_only_allowed("du -sh /Users/me"));
        assert!(read_only_allowed("df -h"));
        assert!(!read_only_allowed("rm -rf /"));
        assert!(!read_only_allowed("ls; rm -rf /"));
        assert!(!read_only_allowed("ls | cat"));
        assert!(!read_only_allowed("pwd && whoami"));
        assert!(!read_only_allowed("ls `whoami`"));
        assert!(!read_only_allowed("cat /etc/passwd"));
    }

    #[test]
    fn admin_allowlist_allows_targets_anywhere_on_mounted_drives() {
        // Inside the current folder still works.
        assert!(admin_operation_allowed("touch a.txt", CWD));
        assert!(admin_operation_allowed("mkdir -p sub/dir", CWD));
        assert!(admin_operation_allowed("rm -- a.txt", CWD));
        assert!(admin_operation_allowed("rm -i -- a.txt", CWD));
        assert!(admin_operation_allowed("mv -- a b", CWD));
        assert!(admin_operation_allowed("cp -R -- a b", CWD));
        assert!(admin_operation_allowed("ln -s -- a b", CWD));

        // `--` is optional; the plain forms are accepted too.
        assert!(admin_operation_allowed("rm a.txt", CWD));
        assert!(admin_operation_allowed("rm -i a.txt", CWD));
        assert!(admin_operation_allowed("mv a b", CWD));
        assert!(admin_operation_allowed("cp -R a b", CWD));
        assert!(admin_operation_allowed("ln -s a b", CWD));
        // Quoted paths with spaces (the shape a manual `mv` produces).
        assert!(admin_operation_allowed(
            "mv 'My File.app/' /Users/me/Applications/",
            CWD
        ));

        // Outside the current folder, on a mounted drive, is now allowed -- both
        // relative and absolute.
        assert!(admin_operation_allowed("touch ../sibling.txt", CWD));
        assert!(admin_operation_allowed(
            "touch /Users/me/elsewhere.txt",
            CWD
        ));
        assert!(admin_operation_allowed(
            "mkdir -p /Users/me/new/nested",
            CWD
        ));
        assert!(admin_operation_allowed("mv -- a /Users/me/b", CWD));
        assert!(admin_operation_allowed(
            "cp -R -- /Users/me/src /Users/me/dst",
            CWD
        ));
        assert!(admin_operation_allowed(
            "ln -s -- /Users/me/target /Users/me/link",
            CWD
        ));

        // Flags and arbitrary shell syntax remain blocked.
        assert!(!admin_operation_allowed("rm -rf -- a", CWD));
        assert!(!admin_operation_allowed("touch -m a", CWD));
        assert!(!admin_operation_allowed("touch a.txt && rm b", CWD));
        assert!(!admin_operation_allowed("sudo rm -- a", CWD));
    }

    #[test]
    fn admin_allowlist_refuses_protected_system_roots() {
        for target in [
            "/System/Library/x",
            "/System/Volumes/Data/System/x",
            "/System/Volumes/Data/usr/local/x",
            "/usr/local/x",
            "/private/etc/hosts",
            "/etc/hosts",
            "/var/tmp/x",
            "/tmp/x",
            "/bin/x",
            "/sbin/x",
            "/Library/x",
            "/Volumes/Recovery/x",
            "/",
        ] {
            assert!(
                !admin_operation_allowed(&format!("touch {target}"), CWD),
                "protected target {target} must be refused"
            );
        }
        // A relative target from a protected folder resolves into it and is refused.
        assert!(!admin_operation_allowed("touch x", "/System/Library"));
        // User data on the Data volume is not a system root.
        assert!(admin_operation_allowed(
            "touch /System/Volumes/Data/Users/me/x",
            CWD
        ));
    }

    #[test]
    fn admin_denial_reason_explains_the_refusal() {
        assert_eq!(admin_denial_reason("touch a.txt", CWD), None);
        assert!(admin_denial_reason("touch /System/Library/x", CWD)
            .unwrap()
            .contains("protected system path"));
        assert!(
            admin_denial_reason("mv -- a /System/Volumes/exAPFS/Applications/", CWD)
                .unwrap()
                .contains("protected system path")
        );
        assert!(admin_denial_reason("touch -m a", CWD).is_some());
    }

    #[test]
    fn lexical_normalize_handles_dot_segments() {
        assert_eq!(lexical_normalize("/a/b/../c"), "/a/c");
        assert_eq!(lexical_normalize("/a/./b/"), "/a/b");
        assert_eq!(lexical_normalize("/.."), "/");
        assert_eq!(lexical_normalize("/"), "/");
    }

    #[test]
    fn tilde_expansion() {
        assert_eq!(expand_tilde("~", "/Users/me"), "/Users/me");
        assert_eq!(expand_tilde("~/x", "/Users/me"), "/Users/me/x");
        assert_eq!(expand_tilde("~other", "/Users/me"), "~other");
    }

    #[test]
    fn empty_admin_password_never_authenticates() {
        // Guard against accidentally accepting a blank password (and spawning sudo).
        assert!(!validate_admin_password(""));
    }

    #[test]
    fn sudo_password_expiry_is_detected() {
        assert!(sudo_needs_password(
            true,
            false,
            "sudo: a password is required"
        ));
        assert!(sudo_needs_password(
            true,
            false,
            "sudo: a terminal is required to read the password"
        ));
        assert!(!sudo_needs_password(
            false,
            false,
            "sudo: a password is required"
        ));
        assert!(!sudo_needs_password(true, true, ""));
        assert!(!sudo_needs_password(
            true,
            false,
            "mv: No such file or directory"
        ));
    }

    #[test]
    fn quoted_targets_keep_spaces() {
        let tokens = parse_simple_admin_command("touch 'a b.txt'").expect("valid");
        assert_eq!(tokens, vec!["touch".to_string(), "a b.txt".to_string()]);
        assert!(admin_operation_allowed("touch 'a b.txt'", CWD));
    }

    #[test]
    fn read_only_commands_never_use_sudo() {
        // Unlocked admin session: write -> sudo, read-only -> never.
        assert!(should_use_admin(true, true, false));
        assert!(!should_use_admin(true, true, true));
        // Locked: no sudo either way.
        assert!(!should_use_admin(true, false, false));
        assert!(!should_use_admin(false, true, false));
    }

    #[test]
    fn double_quoted_paths_with_spaces_are_allowed_and_unquoted_ones_explain_why() {
        const DEST: &str = "/System/Volumes/Data/Users/me/Applications/";
        // A bundle whose name contains a space, quoted the way a shell needs it.
        assert!(admin_operation_allowed("touch \"My Report.txt\"", CWD));
        assert!(admin_operation_allowed(
            &format!("mv \"LM Studio.app/\" {DEST}"),
            CWD
        ));
        // Unquoted, a shell would read three arguments; the refusal must say how
        // to fix it instead of only naming the allowlist.
        let unquoted = format!("mv LM Studio.app/ {DEST}");
        assert!(!admin_operation_allowed(&unquoted, CWD));
        assert!(admin_denial_reason(&unquoted, CWD)
            .unwrap()
            .contains("quoted"));
    }
}
