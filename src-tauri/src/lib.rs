//! Sunburst Disk — Rust core.
//!
//! Tauri v2 replaces the Electron main process. The React renderer is reused
//! unchanged; `src/tauri-bridge.js` maps `window.electronAPI.*` onto the
//! commands registered here.

mod archive;
mod ask_siri;
mod capacity;
mod commands;
mod drives;
mod hidden_space;
mod inspect;
mod openwith;
mod quick_look;
mod related;
mod scan;
mod smart_clean;
mod terminal;
mod types;
mod watcher;

use commands::ScanJobs;
use terminal::TerminalState;
use watcher::FolderWatch;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(ScanJobs::default())
        .manage(FolderWatch::default())
        .manage(TerminalState::default())
        .invoke_handler(tauri::generate_handler![
            commands::get_drives,
            commands::get_capacity_snapshot,
            commands::scan_directory,
            commands::scan_subdir,
            commands::cancel_scan,
            commands::set_window_layout,
            commands::choose_folder,
            commands::delete_items,
            commands::inspect_item,
            commands::inspect_items,
            commands::reveal_in_finder,
            commands::inspect_app_related,
            commands::get_open_with_apps,
            commands::open_with_application,
            commands::choose_other_application,
            commands::finder_get_info,
            commands::watch_current_folder,
            commands::scan_archive,
            commands::notify_scan_complete,
            commands::get_permission_status,
            commands::open_system_settings,
            commands::save_text_file,
            commands::eject_drive,
            commands::open_full_disk_access_settings,
            commands::terminal_authorize_admin,
            commands::terminal_revoke_admin,
            commands::hidden_space_authorize,
            commands::hidden_space_revoke,
            commands::terminal_run_safe,
            commands::scan_hidden_space,
            commands::smart_clean_preview,
            commands::setup_ask_siri,
            commands::ask_siri,
            commands::ask_siri_transform,
            commands::quick_look,
            commands::quick_look_close,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Sunburst Disk");
}
