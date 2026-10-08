//! Sunburst Disk — Rust core.
//!
//! Tauri v2 replaces the Electron main process. The React renderer is reused
//! unchanged; `src/tauri-bridge.js` maps `window.electronAPI.*` onto the
//! commands registered here.

mod archive;
mod ask_siri;
mod capacity;
mod cloud;
mod cloud_trash;
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
use tauri::menu::{Menu, MenuItem, MenuItemKind};
use terminal::TerminalState;
use watcher::FolderWatch;

/// Id of the app-menu item that runs the update check.
const CHECK_FOR_UPDATES_ID: &str = "check-for-updates";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(ScanJobs::default())
        .manage(FolderWatch::default())
        .manage(TerminalState::default())
        .menu(|app_handle| {
            // Start from Tauri's default macOS menu (About/Edit/Window/Help) and add
            // "Check for Updates…" directly under "About Sunburst Disk".
            let menu = Menu::default(app_handle)?;
            let check_item = MenuItem::with_id(
                app_handle,
                CHECK_FOR_UPDATES_ID,
                "Check for Updates…",
                true,
                None::<&str>,
            )?;
            if let Some(MenuItemKind::Submenu(app_submenu)) = menu
                .items()?
                .into_iter()
                .find(|item| matches!(item, MenuItemKind::Submenu(_)))
            {
                // Position 1 sits directly below "About Sunburst Disk".
                app_submenu.insert(&check_item, 1)?;
            }
            Ok(menu)
        })
        .on_menu_event(|app_handle, event| {
            if event.id() == CHECK_FOR_UPDATES_ID {
                let app_handle = app_handle.clone();
                tauri::async_runtime::spawn(async move {
                    commands::check_for_update(app_handle).await;
                });
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_drives,
            commands::get_capacity_snapshot,
            commands::scan_directory,
            commands::scan_subdir,
            commands::cancel_scan,
            commands::set_window_layout,
            commands::choose_folder,
            commands::delete_items,
            commands::trash_cloud_items,
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
            commands::open_external_url,
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
            commands::cloud_storage_survey,
            commands::cloud_storage_client_state,
            commands::setup_ask_siri,
            commands::ask_siri,
            commands::ask_siri_transform,
            commands::quick_look,
            commands::quick_look_close,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Sunburst Disk");
}
