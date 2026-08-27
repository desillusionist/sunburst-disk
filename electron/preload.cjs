const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getDrives:             ()                     => ipcRenderer.invoke('get-drives'),
  chooseFolder:          ()                     => ipcRenderer.invoke('choose-folder'),
  smartCleanPreview:     (scope, paths = {})    => ipcRenderer.invoke('smart-clean-preview', { scope, ...paths }),
  scanDirectory:         (targetPath, detailDepth) => ipcRenderer.invoke('scan-directory', { targetPath, detailDepth }),
  scanSubdir:            (targetPath, includePackageContents = false) => ipcRenderer.invoke('scan-subdir', { targetPath, includePackageContents }),
  deleteItems:           (items)                => ipcRenderer.invoke('delete-items', items),
  revealInFinder:        (itemPath)             => ipcRenderer.invoke('reveal-in-finder', itemPath),
  showContextMenu:       (item)                 => ipcRenderer.invoke('show-context-menu', item),
  askSiri:               (item)                 => ipcRenderer.invoke('ask-siri', {
    itemPath: item?.path,
    itemName: item?.name,
    item
  }),
  inspectItem:            (itemPath)             => ipcRenderer.invoke('inspect-item', itemPath),
  inspectItems:           (itemPaths)            => ipcRenderer.invoke('inspect-items', itemPaths),
  inspectAppRelated:      (appPath)             => ipcRenderer.invoke('inspect-app-related', appPath),
  terminalRunSafe:        (command, cwd)       => ipcRenderer.invoke('terminal-run-safe', { command, cwd }),
  quickLook:              (itemPath)             => ipcRenderer.invoke('quick-look', itemPath),
  scanHiddenSpace:        (knownSize = 0)        => ipcRenderer.invoke('scan-hidden-space', { knownSize }),
  onScanProgress:        (cb)                   => ipcRenderer.on('scan-progress', (_, data) => cb(data)),
  onScanComplete:        (cb)                   => ipcRenderer.on('scan-complete', (_, data) => cb(data)),
  onAddToCollectorRequest: (callback)            => ipcRenderer.on('add-to-collector-request', (_e, item) => callback(item)),
  onTogglePackageContentsRequest: (callback)    => {
    const listener = (_e, item) => callback(item);
    ipcRenderer.on('toggle-package-contents-request', listener);
    return () => ipcRenderer.removeListener('toggle-package-contents-request', listener);
  },
});

