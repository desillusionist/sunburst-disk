const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getDrives:             ()                     => ipcRenderer.invoke('get-drives'),
  setWindowLayout:       (layout, driveCount = 0) => ipcRenderer.invoke('set-window-layout', { layout, driveCount }),
  chooseFolder:          ()                     => ipcRenderer.invoke('choose-folder'),
  smartCleanPreview:     (scope, paths = {})    => ipcRenderer.invoke('smart-clean-preview', { scope, ...paths }),
  scanDirectory:         (targetPath, detailDepth) => ipcRenderer.invoke('scan-directory', { targetPath, detailDepth }),
  notifyScanComplete:     (scanPath, itemCount = 0) => ipcRenderer.invoke('notify-scan-complete', { scanPath, itemCount }),
  scanSubdir:            (targetPath, includePackageContents = false) => ipcRenderer.invoke('scan-subdir', { targetPath, includePackageContents }),
  scanArchive:           (archivePath) => ipcRenderer.invoke('scan-archive', archivePath),
  watchCurrentFolder:    (folderPath)            => ipcRenderer.invoke('watch-current-folder', { folderPath, enabled: true }),
  stopCurrentFolderWatcher: ()                     => ipcRenderer.invoke('watch-current-folder', { enabled: false }),
  deleteItems:           (items)                => ipcRenderer.invoke('delete-items', items),
  revealInFinder:        (itemPath)             => ipcRenderer.invoke('reveal-in-finder', itemPath),
  ejectDrive:            (mount)                => ipcRenderer.invoke('eject-drive', { mount }),
  showContextMenu:       (item)                 => ipcRenderer.invoke('show-context-menu', item),
  askSiri:               (item)                 => ipcRenderer.invoke('ask-siri', {
    itemPath: item?.path,
    itemName: item?.name,
    item
  }),
  askSiriTransform:      (mode, text, itemName) => ipcRenderer.invoke('ask-siri-transform', { mode, text, itemName }),
  inspectItem:            (itemPath)             => ipcRenderer.invoke('inspect-item', itemPath),
  inspectItems:           (itemPaths)            => ipcRenderer.invoke('inspect-items', itemPaths),
  inspectAppRelated:      (appPath)             => ipcRenderer.invoke('inspect-app-related', appPath),
  terminalAuthorizeAdmin: (password)          => ipcRenderer.invoke('terminal-authorize-admin', { password }),
  terminalRevokeAdmin:   ()                     => ipcRenderer.invoke('terminal-revoke-admin'),
  terminalRunSafe:        (command, cwd, adminMode = false) => ipcRenderer.invoke('terminal-run-safe', { command, cwd, adminMode }),
  quickLook:              (itemPath)             => ipcRenderer.invoke('quick-look', itemPath),
  scanHiddenSpace:        (knownSize = 0)        => ipcRenderer.invoke('scan-hidden-space', { knownSize }),
  onScanProgress:        (cb)                   => ipcRenderer.on('scan-progress', (_, data) => cb(data)),
  onFolderWatchChange:   (cb)                   => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('folder-watch-change', listener);
    return () => ipcRenderer.removeListener('folder-watch-change', listener);
  },
  onFolderWatchStatus:   (cb)                   => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('folder-watch-status', listener);
    return () => ipcRenderer.removeListener('folder-watch-status', listener);
  },
  onScanComplete:        (cb)                   => ipcRenderer.on('scan-complete', (_, data) => cb(data)),
  onAskSiriStart:         (cb)                   => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('ask-siri-start', listener);
    return () => ipcRenderer.removeListener('ask-siri-start', listener);
  },
  onAskSiriResult:        (cb)                   => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('ask-siri-result', listener);
    return () => ipcRenderer.removeListener('ask-siri-result', listener);
  },
  onAddToCollectorRequest: (callback)            => ipcRenderer.on('add-to-collector-request', (_e, item) => callback(item)),
  onTogglePackageContentsRequest: (callback)    => {
    const listener = (_e, item) => callback(item);
    ipcRenderer.on('toggle-package-contents-request', listener);
    return () => ipcRenderer.removeListener('toggle-package-contents-request', listener);
  },
});

