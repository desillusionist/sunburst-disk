//! Read-only terminal plus scoped administrator write commands.
//!
//! Ported from `electron/main.js`. The security model is unchanged:
//!   * a read-only command allowlist (`SAFE_TERMINAL_COMMANDS`) runs under the
//!     user's shell,
//!   * an administrator password is validated with `sudo -S -k -v`, then a
//!     narrow, path-scoped write allowlist (`SAFE_ADMIN_COMMANDS`) runs under
//!     `sudo -n`,
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
const SAFE_ADMIN_ARGUMENT: &str = r"[A-Za-z0-9_./~'() -]+";
const COMMAND_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_OUTPUT_BYTES: usize = 2 * 1024 * 1024;

const ADMIN_DENIED: &str = "Allowed commands are read-only helpers plus scoped touch, mkdir -p, rm, mv, cp -R and ln -s inside the current folder. Sudo and arbitrary shell commands remain blocked.";
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
            r"^(?:touch|mkdir -p|rm(?: -i)? --|mv --|cp -R --|ln -s --) {argument}(?: {argument})?$",
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

/// Resolve a write target inside `working_directory`, rejecting flags, the
/// directory itself, escapes above it, and protected System roots.
fn admin_target_path(raw_target: &str, working_directory: &str) -> Option<String> {
    if raw_target.is_empty() || raw_target.starts_with('-') {
        return None;
    }
    let home = std::env::var("HOME").unwrap_or_default();
    let expanded = expand_tilde(raw_target, &home);
    let resolved = resolve_against(working_directory, &expanded);
    let root = lexical_normalize(working_directory);
    if resolved == root || !resolved.starts_with(&format!("{root}/")) {
        return None;
    }
    if is_protected_system_path(&resolved) {
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

/// True when `command` is an allowlisted admin write whose targets are all
/// inside `working_directory` (and outside protected roots).
pub(crate) fn admin_operation_allowed(command: &str, working_directory: &str) -> bool {
    let normalized = lexical_normalize(working_directory);
    if normalized == "/"
        || normalized == "/System/Volumes/Data"
        || is_protected_system_path(&normalized)
    {
        return false;
    }
    let Some(tokens) = parse_simple_admin_command(command) else {
        return false;
    };
    if tokens.is_empty() {
        return false;
    }

    match tokens[0].as_str() {
        "touch" if tokens.len() == 2 => admin_target_path(&tokens[1], &normalized).is_some(),
        "mkdir" if tokens.len() == 3 && tokens[1] == "-p" => {
            admin_target_path(&tokens[2], &normalized).is_some()
        }
        "rm" if tokens.len() == 3 || tokens.len() == 4 => {
            let target = tokens.last().expect("non-empty tokens");
            let flags_ok = tokens[1..tokens.len() - 1]
                .iter()
                .all(|token| token == "-i" || token == "--");
            flags_ok && admin_target_path(target, &normalized).is_some()
        }
        "mv" if tokens.len() == 4 && tokens[1] == "--" => {
            admin_target_path(&tokens[2], &normalized).is_some()
                && admin_target_path(&tokens[3], &normalized).is_some()
        }
        "cp" if tokens.len() == 5 && tokens[1] == "-R" && tokens[2] == "--" => {
            admin_target_path(&tokens[3], &normalized).is_some()
                && admin_target_path(&tokens[4], &normalized).is_some()
        }
        "ln" if tokens.len() == 5 && tokens[1] == "-s" && tokens[2] == "--" => {
            admin_target_path(&tokens[3], &normalized).is_some()
                && admin_target_path(&tokens[4], &normalized).is_some()
        }
        _ => false,
    }
}

/// Validate a password non-interactively via `sudo -S -k -v` (10 s timeout).
pub(crate) fn validate_admin_password(password: &str) -> bool {
    let mut child = match Command::new("/usr/bin/sudo")
        .args(["-S", "-k", "-v"])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(child) => child,
        Err(_) => return false,
    };

    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(format!("{password}\n").as_bytes());
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
            let error = if success {
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
    fn admin_allowlist_scopes_targets_inside_cwd() {
        assert!(admin_operation_allowed("touch a.txt", CWD));
        assert!(admin_operation_allowed("mkdir -p sub/dir", CWD));
        assert!(admin_operation_allowed("rm -- a.txt", CWD));
        assert!(admin_operation_allowed("rm -i -- a.txt", CWD));
        assert!(admin_operation_allowed("mv -- a b", CWD));
        assert!(admin_operation_allowed("cp -R -- a b", CWD));
        assert!(admin_operation_allowed("ln -s -- a b", CWD));

        // Escapes and flags are rejected.
        assert!(!admin_operation_allowed("touch ../escape", CWD));
        assert!(!admin_operation_allowed("touch /etc/passwd", CWD));
        assert!(!admin_operation_allowed("rm -rf -- a", CWD));
        assert!(!admin_operation_allowed("touch -m a", CWD));
        assert!(!admin_operation_allowed("touch a.txt && rm b", CWD));
        assert!(!admin_operation_allowed("sudo rm -- a", CWD));
        assert!(!admin_operation_allowed("mv -- a /tmp/b", CWD));
    }

    #[test]
    fn admin_refused_for_root_and_protected_workdirs() {
        assert!(!admin_operation_allowed("touch a.txt", "/"));
        assert!(!admin_operation_allowed(
            "touch a.txt",
            "/System/Volumes/Data"
        ));
        assert!(!admin_operation_allowed(
            "touch a.txt",
            "/System/Volumes/Data/private/x"
        ));
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
    fn quoted_targets_keep_spaces() {
        let tokens = parse_simple_admin_command("touch 'a b.txt'").expect("valid");
        assert_eq!(tokens, vec!["touch".to_string(), "a b.txt".to_string()]);
        assert!(admin_operation_allowed("touch 'a b.txt'", CWD));
    }
}
