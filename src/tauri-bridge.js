// Tauri bridge shim.
//
// The React renderer talks to the backend through `window.electronAPI`. Under
// Tauri we install that same object, backed by `invoke`/`listen`, so App.jsx
// and the components need no changes. This module is a no-op in a plain
// browser/Vite session (no `window.__TAURI__`), which preserves the existing
// "web build has no filesystem access" behaviour.
//
// Commands that were not reachable from the renderer are documented in
// docs/electron-to-tauri-migration.md.
//
// Every channel the renderer uses is now backed by a Rust command.

const tauri = typeof window !== 'undefined' ? window.__TAURI__ : undefined;

if (tauri?.core?.invoke) {
  const { invoke } = tauri.core;
  const listen = tauri.event?.listen;

  // Subscribe to a backend event; resolves to an unsubscribe function.
  const on = (eventName, callback) => {
    if (typeof listen !== 'function') return () => {};
    let unlisten = null;
    let disposed = false;
    listen(eventName, event => callback(event.payload)).then(stop => {
      if (disposed) stop();
      else unlisten = stop;
    }).catch(() => {});
    return () => {
      disposed = true;
      if (unlisten) unlisten();
    };
  };

  window.electronAPI = {
    // ── Migrated (see src-tauri/src/commands.rs) ──────────────────────────
    getDrives: () => invoke('get_drives'),
    getCapacitySnapshot: targetPath => invoke('get_capacity_snapshot', { targetPath }),
    scanDirectory: (targetPath, detailDepth, requestId = null) =>
      invoke('scan_directory', { targetPath, detailDepth, requestId }),
    cancelScan: (requestId = null) => invoke('cancel_scan', { requestId }),
    scanSubdir: (targetPath, includePackageContents = false) =>
      invoke('scan_subdir', { targetPath, includePackageContents }),
    setWindowLayout: (layout, driveCount = 0) =>
      invoke('set_window_layout', { layout, driveCount }),
    chooseFolder: () => invoke('choose_folder'),
    deleteItems: items => invoke('delete_items', { items }),
    inspectItem: itemPath => invoke('inspect_item', { itemPath }),
    inspectItems: itemPaths => invoke('inspect_items', { itemPaths }),
    revealInFinder: itemPath => invoke('reveal_in_finder', { itemPath }),
    inspectAppRelated: appPath => invoke('inspect_app_related', { appPath }),
    getOpenWithApps: itemPath => invoke('get_open_with_apps', { itemPath }),
    openWithApplication: (appPath, itemPath) =>
      invoke('open_with_application', { appPath, itemPath }),
    chooseOtherApplication: itemPath => invoke('choose_other_application', { itemPath }),
    finderGetInfo: itemPath => invoke('finder_get_info', { itemPath }),
    watchCurrentFolder: folderPath =>
      invoke('watch_current_folder', { folderPath, enabled: true }),
    stopCurrentFolderWatcher: () =>
      invoke('watch_current_folder', { enabled: false }),
    scanArchive: archivePath => invoke('scan_archive', { archivePath }),
    notifyScanComplete: (scanPath, itemCount = 0) =>
      invoke('notify_scan_complete', { scanPath, itemCount }),
    getPermissionStatus: () => invoke('get_permission_status'),
    openSystemSettings: section => invoke('open_system_settings', { section }),
    saveTextFile: (defaultName, content) =>
      invoke('save_text_file', { defaultName, content }),
    ejectDrive: mount => invoke('eject_drive', { mount }),
    openFullDiskAccessSettings: () => invoke('open_full_disk_access_settings'),
    terminalAuthorizeAdmin: password => invoke('terminal_authorize_admin', { password }),
    terminalRevokeAdmin: () => invoke('terminal_revoke_admin'),
    authorizeHiddenSpace: password => invoke('hidden_space_authorize', { password }),
    revokeHiddenSpace: () => invoke('hidden_space_revoke'),
    terminalRunSafe: (command, cwd, adminMode = false) =>
      invoke('terminal_run_safe', { command, cwd, adminMode }),
    smartCleanPreview: (scope, paths = {}) =>
      invoke('smart_clean_preview', {
        scope,
        folderPath: paths.folderPath ?? null,
        storagePath: paths.storagePath ?? null,
      }),
    scanHiddenSpace: (knownSize = 0) => invoke('scan_hidden_space', { knownSize }),
    setupAskSiri: () => invoke('setup_ask_siri'),
    askSiri: item =>
      invoke('ask_siri', {
        itemPath: item?.path,
        itemName: item?.name,
        item,
      }),
    askSiriTransform: (mode, text, itemName) =>
      invoke('ask_siri_transform', { mode, text, itemName }),
    quickLook: itemPath => invoke('quick_look', { itemPath }),
    quickLookClose: () => invoke('quick_look_close'),

    onScanProgress: callback => on('scan-progress', callback),
    onScanComplete: callback => on('scan-complete', callback),

    onFolderWatchChange: callback => on('folder-watch-change', callback),
    onFolderWatchStatus: callback => on('folder-watch-status', callback),
    onQuickLookKey: callback => on('quick-look-key', callback),
    onAskSiriStart: callback => on('ask-siri-start', callback),
    onAskSiriResult: callback => on('ask-siri-result', callback),
    onAddToCollectorRequest: callback => on('add-to-collector-request', callback),
    onTogglePackageContentsRequest: callback => on('toggle-package-contents-request', callback),
  };

  window.__SUNBURST_RUNTIME__ = 'tauri';
} else if (typeof window !== 'undefined') {
  window.__SUNBURST_RUNTIME__ = window.electronAPI ? 'electron' : 'web';
}

export const runtime =
  (typeof window !== 'undefined' && window.__SUNBURST_RUNTIME__) || 'web';
