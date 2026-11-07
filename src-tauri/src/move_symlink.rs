//! “Move & Symlink”: relocate an item on a mounted drive and leave a symlink at
//! the old path, so anything that still refers to it keeps working.
//!
//! Nothing here reads file contents, and nothing downloads or materialises a
//! cloud placeholder: the work is a rename (or a cross-volume copy performed by
//! `/bin/mv`) plus a symlink. Both directions are reversible, and the renderer
//! only calls them after an explicit confirmation.

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::capacity::resolve_path;
use crate::commands::is_protected_system_path;
use crate::terminal::{self, TerminalState};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MoveSymlinkResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

fn failed(error: impl Into<String>) -> MoveSymlinkResponse {
    MoveSymlinkResponse {
        ok: false,
        error: Some(error.into()),
        ..Default::default()
    }
}

fn text(value: &Path) -> String {
    value.to_string_lossy().into_owned()
}

/// A target must be an existing parent directory on a mounted drive, outside the
/// protected system roots -- the same scope admin writes already have.
fn check_destination_dir(path: &Path) -> Result<(), String> {
    if path == Path::new("/") {
        return Err("The filesystem root is not a valid destination.".to_string());
    }
    if is_protected_system_path(&text(path)) {
        return Err("That folder is inside a protected system path.".to_string());
    }
    if !terminal::within_mounted_drives(&text(path)) {
        return Err("That folder is outside the mounted drives.".to_string());
    }
    match std::fs::metadata(path) {
        Ok(metadata) if metadata.is_dir() => Ok(()),
        Ok(_) => Err("The destination is not a folder.".to_string()),
        Err(error) => Err(error.to_string()),
    }
}

/// Resolve the source to move and the exact path it will land on.
///
/// Pure path arithmetic plus `symlink_metadata`, so it can be unit tested without
/// moving anything.
pub(crate) fn plan_move(
    item_path: &str,
    destination_dir: &str,
) -> Result<(PathBuf, PathBuf), String> {
    if item_path.trim().is_empty() || destination_dir.trim().is_empty() {
        return Err("A source and a destination folder are required.".to_string());
    }
    let source = resolve_path(item_path);
    let destination = resolve_path(destination_dir);

    if source == Path::new("/") {
        return Err("The filesystem root cannot be moved.".to_string());
    }
    if is_protected_system_path(&text(&source)) {
        return Err("That item is inside a protected system path.".to_string());
    }
    match std::fs::symlink_metadata(&source) {
        Ok(_) => {}
        Err(error) => return Err(error.to_string()),
    }
    check_destination_dir(&destination)?;

    let name = source
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .ok_or_else(|| "That item has no name to move.".to_string())?;
    let target = destination.join(&name);

    if target == source {
        return Err(format!("“{name}” is already in that folder."));
    }
    if std::fs::symlink_metadata(&target).is_ok() {
        return Err(format!("“{name}” already exists in that folder."));
    }
    // Moving a folder into itself would delete the tree.
    if std::fs::symlink_metadata(&source)
        .map(|metadata| metadata.is_dir())
        .unwrap_or(false)
        && text(&destination).starts_with(&format!("{}/", text(&source)))
    {
        return Err("A folder cannot be moved inside itself.".to_string());
    }

    Ok((source, target))
}

fn permission_denied(output: &Output) -> bool {
    let stderr = String::from_utf8_lossy(&output.stderr);
    stderr.contains("Permission denied")
        || stderr.contains("Operation not permitted")
        || stderr.contains("are not permitted")
}

fn describe_output(output: &Output, action: &str) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if stderr.is_empty() {
        format!("{action} failed.")
    } else if permission_denied(output) {
        format!(
            "Sunburst Disk does not have permission to {action}. Unlock the Terminal's administrator mode and try again, or use Finder."
        )
    } else {
        stderr
    }
}

/// Run a fixed tool (never a shell) optionally through `sudo -n`.
fn run_tool(program: &str, args: &[&str], admin: bool) -> Result<(), String> {
    let mut command = if admin {
        let mut command = Command::new("/usr/bin/sudo");
        command.arg("-n").arg(program);
        command
    } else {
        Command::new(program)
    };
    command.args(args);
    let output = command
        .output()
        .map_err(|error| format!("Could not start the operation: {error}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(describe_output(&output, "complete the move"))
    }
}

fn move_path(from: &Path, to: &Path, admin: bool) -> Result<(), String> {
    run_tool("/bin/mv", &["-n", "--", &text(from), &text(to)], admin)?;
    // `mv -n` exits 0 when the destination exists, so verify the move happened.
    if std::fs::symlink_metadata(to).is_err() || std::fs::symlink_metadata(from).is_ok() {
        return Err(format!(
            "“{}” could not be moved — it may already exist in the destination.",
            from.file_name()
                .map(|value| value.to_string_lossy().into_owned())
                .unwrap_or_default()
        ));
    }
    Ok(())
}

fn create_symlink(target: &Path, link: &Path, admin: bool) -> Result<(), String> {
    match std::os::unix::fs::symlink(target, link) {
        Ok(()) => Ok(()),
        Err(_) if admin => run_tool("/bin/ln", &["-s", &text(target), &text(link)], true),
        Err(error) => Err(format!(
            "The item was moved, but the symlink could not be created: {error}"
        )),
    }
}

fn remove_link(link: &Path, admin: bool) -> Result<(), String> {
    match std::fs::remove_file(link) {
        Ok(()) => Ok(()),
        Err(_) if admin => run_tool("/bin/rm", &["-f", &text(link)], true),
        Err(error) => Err(error.to_string()),
    }
}

fn admin_authorized(app: &AppHandle) -> bool {
    app.state::<TerminalState>().admin_authorized()
}

/// Move `source` to `target` and leave a symlink at `source`.
///
/// If the symlink cannot be created the move is rolled back, so the tree is
/// never left half-moved.
pub(crate) fn move_with_symlink(source: &Path, target: &Path, admin: bool) -> Result<(), String> {
    move_path(source, target, admin)?;
    if let Err(error) = create_symlink(target, source, admin) {
        let _ = move_path(target, source, admin);
        return Err(error);
    }
    Ok(())
}

/// Reverse a move: only while `link` is still the symlink this app created and it
/// still points at `moved`. Anything else is left alone and reported.
pub(crate) fn undo_move_with_symlink(link: &Path, moved: &Path, admin: bool) -> Result<(), String> {
    let points_here = std::fs::read_link(link)
        .map(|target| target == moved)
        .unwrap_or(false);
    if !points_here {
        return Err(
            "The symlink at the original path no longer points at the moved item.".to_string(),
        );
    }
    if std::fs::symlink_metadata(moved).is_err() {
        return Err("The moved item is no longer at its new location.".to_string());
    }
    remove_link(link, admin)?;
    if let Err(error) = move_path(moved, link, admin) {
        // Put the symlink back so the tree matches what it looked like before.
        let _ = create_symlink(moved, link, admin);
        return Err(error);
    }
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn move_and_symlink(
    app: AppHandle,
    item_path: String,
    destination_dir: String,
) -> MoveSymlinkResponse {
    let admin = admin_authorized(&app);
    tauri::async_runtime::spawn_blocking(move || match plan_move(&item_path, &destination_dir) {
        Ok((source, target)) => match move_with_symlink(&source, &target, admin) {
            Ok(()) => MoveSymlinkResponse {
                ok: true,
                from: Some(text(&source)),
                to: Some(text(&target)),
                error: None,
            },
            Err(error) => failed(error),
        },
        Err(error) => failed(error),
    })
    .await
    .unwrap_or_else(|_| failed("The move could not be completed."))
}

/// Undo a move: only when `from` is still the symlink this app created and it
/// still points at `to`. Anything else is left alone and reported.
#[tauri::command(rename_all = "camelCase")]
pub async fn undo_move_and_symlink(
    app: AppHandle,
    from: String,
    to: String,
) -> MoveSymlinkResponse {
    let admin = admin_authorized(&app);
    tauri::async_runtime::spawn_blocking(move || {
        let link = resolve_path(&from);
        let moved = resolve_path(&to);
        if is_protected_system_path(&text(&link)) || is_protected_system_path(&text(&moved)) {
            return failed("That item is inside a protected system path.");
        }
        if let Err(error) = undo_move_with_symlink(&link, &moved, admin) {
            return failed(error);
        }
        MoveSymlinkResponse {
            ok: true,
            from: Some(text(&moved)),
            to: Some(text(&link)),
            error: None,
        }
    })
    .await
    .unwrap_or_else(|_| failed("The undo could not be completed."))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sandbox(name: &str) -> PathBuf {
        let root =
            std::env::temp_dir().join(format!("sunburst-move-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("sandbox");
        root
    }

    #[test]
    fn plans_a_move_into_an_existing_folder() {
        let root = sandbox("plan");
        let source = root.join("Report.pages");
        std::fs::write(&source, b"x").expect("write");
        let destination = root.join("Archive");
        std::fs::create_dir_all(&destination).expect("destination");

        let (from, to) = plan_move(&text(&source), &text(&destination)).expect("plan");
        assert_eq!(from, source);
        assert_eq!(to, destination.join("Report.pages"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn refuses_collisions_the_root_and_missing_items() {
        let root = sandbox("refuse");
        let source = root.join("a.txt");
        std::fs::write(&source, b"x").expect("write");
        let destination = root.join("Out");
        std::fs::create_dir_all(&destination).expect("destination");
        std::fs::write(destination.join("a.txt"), b"y").expect("collision");

        assert!(plan_move(&text(&source), &text(&destination)).is_err());
        assert!(plan_move("/", &text(&destination)).is_err());
        assert!(plan_move(&text(&root.join("missing")), &text(&destination)).is_err());
        assert!(plan_move(&text(&source), &text(&root.join("not-a-folder"))).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn refuses_a_folder_moved_inside_itself() {
        let root = sandbox("self");
        let source = root.join("Parent");
        std::fs::create_dir_all(source.join("Child")).expect("tree");
        assert!(plan_move(&text(&source), &text(&source.join("Child"))).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn refuses_protected_destinations() {
        let root = sandbox("protected");
        let source = root.join("a.txt");
        std::fs::write(&source, b"x").expect("write");
        assert!(plan_move(&text(&source), "/System/Library").is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn moves_leaves_a_symlink_and_undoes() {
        let root = sandbox("roundtrip");
        let source = root.join("Report.txt");
        std::fs::write(&source, b"payload").expect("write");
        let destination = root.join("Archive");
        std::fs::create_dir_all(&destination).expect("destination");

        let (from, to) = plan_move(&text(&source), &text(&destination)).expect("plan");
        move_with_symlink(&from, &to, false).expect("move");

        // The item moved, and the old path is now a symlink that still resolves.
        assert!(std::fs::symlink_metadata(&from)
            .expect("link")
            .file_type()
            .is_symlink());
        assert_eq!(std::fs::read_link(&from).expect("target"), to);
        assert_eq!(
            std::fs::read_to_string(&from).expect("read through link"),
            "payload"
        );
        assert_eq!(std::fs::read_to_string(&to).expect("moved file"), "payload");

        undo_move_with_symlink(&from, &to, false).expect("undo");
        assert!(std::fs::symlink_metadata(&from)
            .expect("restored")
            .file_type()
            .is_file());
        assert!(std::fs::symlink_metadata(&to).is_err());
        assert_eq!(std::fs::read_to_string(&from).expect("content"), "payload");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn undo_refuses_a_link_that_points_elsewhere() {
        let root = sandbox("undo-guard");
        let moved = root.join("Moved.txt");
        std::fs::write(&moved, b"x").expect("write");
        let link = root.join("Link.txt");
        std::os::unix::fs::symlink(root.join("Elsewhere.txt"), &link).expect("link");

        assert!(undo_move_with_symlink(&link, &moved, false).is_err());
        // The guarded link is untouched.
        assert!(std::fs::symlink_metadata(&link)
            .expect("still a link")
            .file_type()
            .is_symlink());
        let _ = std::fs::remove_dir_all(&root);
    }
}
