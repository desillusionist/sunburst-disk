import React, { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef } from 'react';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, ChevronDown, PanelRight, PanelRightClose, RefreshCw, ShieldCheck, ShieldAlert, LockKeyhole, AlertTriangle, Folder, FileText, Trash2, X, RotateCcw, Copy, Eye, Maximize2, Minimize2, Sparkles, List, ListFilter } from 'lucide-react';
import SunburstChart from './components/SunburstChart';
import DetailsSidebar from './components/DetailsSidebar';
import DebugDownbar from './components/DebugDownbar';
import { recordPerfEvent, recordPerfInstant } from './debug/perfTelemetry';
import shortcutGuideText from './Sunburst-Disk-Ask-Siri-Shortcut-Guide.txt?raw';

// macOS Finder uses decimal gigabytes (1000^3) for disk and application display:
function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1000;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(Math.max(1, bytes)) / Math.log(k));
  const val = (bytes / Math.pow(k, i));
  return (val >= 100 ? val.toFixed(0) : val.toFixed(1)) + ' ' + sizes[i];
}

function normalizeAssistantOutput(text, mode) {
  const source = String(text || '').trim();
  if (mode !== 'bullets' || !source) return source;
  const lines = source.split(/\r?\n/);
  const output = [];
  for (const line of lines) {
    const cleaned = line
      .replace(/^\s*(?:[-*•‣◦]|\d+[.)])\s+/, '')
      .replace(/^\s*#+\s*/, '')
      .replace(/\*\*/g, '')
      .trim();
    if (!cleaned) {
      if (output.length && output[output.length - 1] !== '') output.push('');
      continue;
    }
    output.push(`• ${cleaned}`);
    output.push('');
  }
  while (output[output.length - 1] === '') output.pop();
  return output.join('\n');
}

const COLOR_MAP = {
  Users: '#eab308',         // Yellow
  System: '#22c55e',        // Green
  Applications: '#06b6d4',  // Cyan/Light Blue
  Library: '#3b82f6',       // Blue
  private: '#8b5cf6',       // Purple
  opt: '#a855f7',           // Purple
  Volumes: '#6366f1',       // Indigo
  usr: '#ec4899',           // Pink
  'smaller objects...': '#52525b',
  'hidden space...': '#7e22ce' // Dark Purple
};
const RING_COLORS = ['#eab308','#22c55e','#06b6d4','#3b82f6','#8b5cf6','#ec4899','#f97316','#14b8a6','#6366f1'];
function getNodeColor(node, idx, matrixTheme = false) {
  // Hidden space is pale-red only once the session is unlocked with the admin
  // password; while locked it uses a neutral grey. Match on the hidden-space
  // flags (the remainder row was renamed from 'Other protected space' to
  // 'Still hidden') rather than a name.
  const isHiddenSpace = node?.path === '__hidden__'
    || node?.name === 'hidden space...'
    || node?.isHiddenSpaceRemainder;
  if (isHiddenSpace) {
    return node?.hiddenSpaceAdminUnlocked === true ? 'rgba(255, 123, 138, 0.9)' : 'rgba(154, 160, 172, 0.9)';
  }
  if (matrixTheme) return '#39ff66';
  if (node?.name === 'smaller objects...') return COLOR_MAP['smaller objects...'];
  if (node?.type === 'special') return COLOR_MAP['hidden space...'];
  if (node?.type === 'file') return '#64748b';
  return COLOR_MAP[node?.name] || RING_COLORS[idx % RING_COLORS.length];
}

function getDriveKey(drive) {
  return drive?.filesystem || drive?.mount || drive?.name;
}

function recordCapacitySnapshot(phase, snapshot, renderer = {}, scan = {}) {
  if (!snapshot || snapshot.error) return;
  recordPerfInstant('capacity.snapshot', {
    phase,
    capturedPath: snapshot.capturedPath || null,
    drive: snapshot.drive || null,
    df: snapshot.df || null,
    statfs: snapshot.statfs || null,
    diskutil: snapshot.diskutil || null,
    symlinks: snapshot.symlinks || null,
    scan: {
      rootPath: scan.rootPath || null,
      indexedTreeBytes: Number(scan.indexedTreeBytes || 0),
      indexedObjectCount: Number(scan.indexedObjectCount || 0),
      hiddenSpaceEstimateBytes: Number(scan.hiddenSpaceEstimateBytes || 0),
      source: scan.source || 'fresh'
    },
    renderer: {
      currentDriveFreeBytes: Number(renderer.currentDriveFreeBytes || 0),
      currentDriveUsedBytes: Number(renderer.currentDriveUsedBytes || 0),
      currentDriveTotalBytes: Number(renderer.currentDriveTotalBytes || 0),
      currentTotalSizeBytes: Number(renderer.currentTotalSizeBytes || 0),
      displayedFreeBytes: Number(renderer.displayedFreeBytes || 0),
      displayedUsedBytes: Number(renderer.displayedUsedBytes || 0),
      displayedTotalBytes: Number(renderer.displayedTotalBytes || 0)
    }
  });
}

function syncDriveCapacityFromSnapshot(drive, snapshot) {
  if (!drive || !snapshot?.df) return drive;
  const total = Number(snapshot.df.totalBytes || drive.total || 0);
  const used = Number(snapshot.df.usedBytes || 0);
  const free = Number(snapshot.df.availableBytes || 0);
  return {
    ...drive,
    total: total || drive.total,
    used: used || drive.used,
    free: free || drive.free,
    usePercent: total > 0 ? `${Math.round((used / total) * 100)}%` : drive.usePercent
  };
}

function quoteTerminalPath(value) {
  const text = String(value || '');
  return `'${text.replaceAll("'", "'\\''")}'`;
}

function pathFromDataTransfer(dataTransfer) {
  const rawJson = dataTransfer.getData('application/json');
  if (rawJson) {
    try {
      const item = JSON.parse(rawJson);
      if (typeof item?.path === 'string') return item.path;
    } catch {}
  }
  const uri = dataTransfer.getData('text/uri-list').split(/\r?\n/).find(value => value && !value.startsWith('#'));
  if (uri?.startsWith('file://')) {
    try { return decodeURIComponent(uri.replace(/^file:\/\//, '')); } catch { return uri.replace(/^file:\/\//, ''); }
  }
  const plain = dataTransfer.getData('text/plain').trim();
  return plain.startsWith('/') ? plain : '';
}

function isStartupDataCategory(node) {
  const parts = (node?.path || '').replace(/\/+$/, '').split('/').filter(Boolean);
  return parts.length === 4 && parts[0] === 'System' && parts[1] === 'Volumes' && parts[2] === 'Data';
}

function getRiskInfo(node) {
  if (!node) {
    return {
      level: 'review',
      label: 'Review before deleting',
      description: 'Select an item to inspect its deletion risk.',
      canDelete: false,
      Icon: AlertTriangle
    };
  }

  const normalizedPath = (node.path || '').replace(/\/+$/, '');
  const protectedCategory = ['System', 'private', 'usr'].includes(node.name) && isStartupDataCategory(node);
  const protectedDataBranch = /^\/System\/Volumes\/Data\/(System|private|usr)(\/|$)/.test(normalizedPath);
  const protectedSystem = node.type === 'special'
    || normalizedPath === '/System'
    || (normalizedPath.startsWith('/System/') && !normalizedPath.startsWith('/System/Volumes/Data/'))
    || protectedCategory
    || protectedDataBranch;

  if (protectedSystem) {
    return {
      level: 'protected',
      label: 'Protected system item',
      description: 'This item is part of macOS system data or filesystem accounting. It cannot be added to the deletion collector.',
      canDelete: false,
      Icon: LockKeyhole
    };
  }

  if (node.type === 'directory' && ['Applications', 'Library', 'Users'].includes(node.name)) {
    return {
      level: 'high',
      label: 'High deletion risk',
      description: 'Deleting this category can affect installed software, shared services, or user accounts. Review the contents carefully before moving anything to Trash.',
      canDelete: true,
      Icon: ShieldAlert
    };
  }

  if (node.type === 'directory') {
    return {
      level: 'review',
      label: 'Review before deleting',
      description: 'This is a directory. Review its contents and dependencies before moving it to Trash.',
      canDelete: true,
      Icon: AlertTriangle
    };
  }

  return {
    level: 'safe',
    label: 'Safe to review',
    description: 'This is an ordinary file entry. Review its location and contents before deleting it.',
    canDelete: true,
    Icon: ShieldCheck
  };
}

function getCategoryDescription(node) {
  if (!node) return 'Hover an item in the chart or list to inspect it.';
  const nodePath = String(node.path || '').replace(/\/+$/, '');
  if (node.isHiddenSpaceRemainder) {
    return 'Unclassified protected space reported by the filesystem accounting difference. It is not represented by one ordinary Finder folder and should not be deleted from this app.';
  }
  if (node.type === 'special' || node.path === '__hidden__') {
    return 'A reconciliation entry for filesystem space that is not visible in the normal directory tree. Viewing its diagnostic categories requires Full Disk Access and may include protected system data.';
  }

  const pathDescriptions = [
    [/\/Applications\/Dia\.app$/, 'Dia is an AI-powered web browser made by The Browser Company of New York, the same team behind Arc. This app bundle contains the browser executable, resources and its local support files.'],
    [/\/Applications\/[^/]+\.app$/, 'An installed macOS application bundle. The visible .app item contains the application executable and bundled resources; inspect Package Contents only when you need to understand its internal files.'],
    [/\/System\/Volumes\/Data\/System$/, 'System (Data volume) — the writable APFS Data-volume System directory exposed alongside the sealed operating-system volume. It is macOS-managed and protected; do not delete or modify its contents.'],
    [/\/System$/, 'System (OS volume) — the sealed APFS operating-system volume containing macOS components. It is protected and should be treated as read-only.'],
    [/\/Library\/Preferences$/, 'Preferences — small .plist settings files used by macOS and applications. They are usually lightweight configuration data; review the owning app before deleting anything.'],
    [/\/Library\/Caches$/, 'Caches — temporary, reproducible data used to speed up applications and macOS services. They are generally safe to recreate, but active applications should be closed before cleanup.'],
    [/\/Library\/Application Support$/, 'Application Support — substantial working data, indexes, models and supporting files used by applications. It can be important to the app and is not equivalent to a disposable cache.'],
    [/\/Library\/Group Containers$/, 'Group Containers — shared application data used by related apps or extensions, often through Apple app groups. Deleting contents may affect multiple applications.'],
    [/\/Library\/Containers$/, 'Containers — sandboxed application data, preferences and caches separated per app. The owning application may depend on these files.'],
    [/\/Library\/Developer$/, 'Developer — SDKs, build products, simulators and other development-tool data. Size can grow quickly when Xcode or developer tooling is installed.'],
    [/\/Library\/Logs$/, 'Logs — diagnostic records produced by macOS and applications. Older logs are often disposable, but active troubleshooting data may still be useful.'],
    [/\/Library\/Mail$/, 'Mail — local message databases, attachments, indexes and account data used by Mail-compatible clients. Treat as personal data and do not delete casually.'],
    [/\/Library\/CloudStorage$/, 'CloudStorage — local synchronization roots for cloud-storage providers. Files may be placeholders, offline copies or sync metadata depending on the provider.'],
    [/\/Library\/Metadata$/, 'Metadata — search indexes and metadata databases used by macOS services. These files are system-managed and may be regenerated or protected.'],
    [/\/Library\/Frameworks$/, 'Frameworks — reusable dynamic libraries and support frameworks used by macOS and third-party software. Removing one can break dependent applications.'],
    [/\/System\/Library$/, 'System Library — Apple frameworks, services, fonts, drivers and other operating-system resources. This location is protected and should be treated as read-only.'],
    [/\/System\/Volumes\/Data\/private$/, 'Private system data — runtime state, services, caches and protected operating-system support files. Its contents are managed by macOS and are high-risk to delete.'],
    [/\/System\/Volumes\/Data\/usr$/, 'Unix userland — command-line tools, libraries and executables used by macOS and installed software. It is system-managed and protected.'],
    [/\/System\/Volumes\/Data\/Users\/[^/]+\/Library$/, 'The user Library — per-user preferences, application support, caches, mail, cloud data and service state. Different subfolders have very different deletion risks.'],
    [/\/System\/Volumes\/Data\/Library$/, 'The system-wide Library — shared application support, preferences, services, frameworks, logs and caches used by macOS and installed software.'],
    [/\/Users$/, 'Home directories and personal data belonging to local users. The largest subfolders commonly include Documents, Downloads, Movies, Pictures and the per-user Library.'],
    [/\/System\/Volumes\/Data\/Users\/[^/]+\/Applications$/, 'Per-user Applications — apps installed only for this macOS user. Finder’s global /Applications folder is separate; a small list here can be correct.'],
    [/\/Applications$/, 'Global Applications — apps installed for all users. Each .app is a bundle containing an executable and resources; application support data may live separately under a user or system Library.']
  ];
  const matched = pathDescriptions.find(([pattern]) => pattern.test(nodePath));
  if (matched) return matched[1];

  const descriptions = {
    System: 'macOS system components, sealed system content and operating-system resources. These items are protected from deletion. The two visible System rows represent the sealed OS volume and the writable Data volume; their exact distinction is described when each row is selected.',
    private: 'Private operating-system data, services, caches and runtime state. It is protected because changes can affect macOS stability.',
    usr: 'Unix userland tools, libraries and executables used by macOS and installed software.',
    Users: 'Home directories and personal data belonging to local users.',
    Applications: 'Installed applications and their bundled resources.',
    Library: 'Shared application support, preferences, services and caches. The exact role depends on the subfolder; use the path-specific guidance when available.',
    opt: 'Optional third-party or package-manager content.',
    Volumes: 'Mounted-volume metadata and mount points.'
  };
  return descriptions[node.name] || (node.type === 'directory'
    ? 'A directory containing the items shown by the current level of the disk map.'
    : 'A file entry reported by the filesystem scanner.');
}

const MAX_BREADCRUMB_CHARS = 18;

function compactBreadcrumbLabel(label) {
  const value = String(label || '');
  return value.length > MAX_BREADCRUMB_CHARS
    ? `${value.slice(0, MAX_BREADCRUMB_CHARS)}…`
    : value;
}

function isAppBundleNode(node) {
  if (node?.type !== 'directory') return false;
  const name = String(node.name || '').trim().toLowerCase();
  const nodePath = String(node.path || '').trim().toLowerCase();
  return name.endsWith('.app') || nodePath.endsWith('.app');
}

const ARCHIVE_FILE_SUFFIXES = ['.7z', '.bz2', '.cpio', '.gz', '.iso', '.rar', '.tar', '.tbz', '.tbz2', '.tgz', '.txz', '.xz', '.zip'];

function isArchiveNode(node) {
  if (!node || node.archiveVirtual) return false;
  const name = String(node.name || '').trim().toLowerCase();
  const nodePath = String(node.path || '').trim().toLowerCase();
  return node.type === 'file' && ARCHIVE_FILE_SUFFIXES.some(suffix => name.endsWith(suffix) || nodePath.endsWith(suffix));
}

function isPackageContainerNode(node) {
  if (isAppBundleNode(node)) return true;
  const name = String(node?.name || '').trim().toLowerCase();
  const nodePath = String(node?.path || '').trim().toLowerCase();
  const photosLibrary = node?.type === 'directory' && (name.endsWith('.photoslibrary') || nodePath.endsWith('.photoslibrary'));
  return Boolean(photosLibrary || isArchiveNode(node));
}

function normalizeArchiveTree(node) {
  if (!node) return node;
  return {
    ...node,
    size: Number.isFinite(Number(node.size)) ? Number(node.size) : 0,
    children: Array.isArray(node.children) ? node.children.map(normalizeArchiveTree) : []
  };
}

function getNodeChain(tree, targetPath) {
  if (!tree || !targetPath) return [];
  const chain = [];
  function visit(node) {
    chain.push(node);
    if (node.path === targetPath) return true;
    for (const child of node.children || []) {
      if (visit(child)) return true;
    }
    chain.pop();
    return false;
  }
  return visit(tree) ? chain : [];
}
function isWithinPath(candidatePath, rootPath) {
  if (typeof candidatePath !== 'string' || typeof rootPath !== 'string') return false;
  const candidate = candidatePath.replace(/\/+$/, '') || '/';
  const root = rootPath.replace(/\/+$/, '') || '/';
  return candidate === root || candidate.startsWith(`${root === '/' ? '' : root}/`);
}
function pathDirname(value) {
  if (typeof value !== 'string' || value === '/') return '/';
  const trimmed = value.replace(/\/+$/, '');
  const index = trimmed.lastIndexOf('/');
  return index <= 0 ? '/' : trimmed.slice(0, index);
}
function pathResolveForRenderer(value) {
  return typeof value === 'string' ? value.replace(/\/+$/, '') || '/' : null;
}
function remapTreePathPrefix(tree, oldRoot, newRoot) {
  if (!tree || !oldRoot || !newRoot) return tree;
  const remap = value => {
    if (typeof value !== 'string') return value;
    if (value === oldRoot) return newRoot;
    return value.startsWith(`${oldRoot}/`) ? `${newRoot}${value.slice(oldRoot.length)}` : value;
  };
  const path = remap(tree.path);
  const children = Array.isArray(tree.children)
    ? tree.children.map(child => remapTreePathPrefix(child, oldRoot, newRoot))
    : tree.children;
  return {
    ...tree,
    path,
    name: tree.path === oldRoot ? (newRoot.split('/').filter(Boolean).pop() || tree.name) : tree.name,
    children
  };
}
function replaceNodeWithDelta(tree, targetPath, updatedNode) {
  if (!tree) return tree;
  if (tree.path === targetPath) return { ...updatedNode, path: targetPath };
  if (!tree.children?.length) return tree;
  let changed = false;
  let sizeDelta = 0;
  const children = tree.children.map(child => {
    const next = replaceNodeWithDelta(child, targetPath, updatedNode);
    if (next !== child) {
      changed = true;
      sizeDelta += Number(next?.size || 0) - Number(child?.size || 0);
    }
    return next;
  });
  return changed
    ? { ...tree, size: Math.max(0, Number(tree.size || 0) + sizeDelta), children }
    : tree;
}

function removePathsFromTree(tree, paths) {
  if (!tree || !Array.isArray(paths) || paths.length === 0) return { tree, changed: false, removedCount: 0, removedBytes: 0 };
  const targets = new Set(paths.filter(path => typeof path === 'string' && path && !path.startsWith('__')));
  if (!targets.size) return { tree, changed: false, removedCount: 0, removedBytes: 0 };

  const visit = node => {
    if (!node?.children?.length) return { node, changed: false, removedCount: 0, removedBytes: 0 };
    let changed = false;
    let removedCount = 0;
    let removedBytes = 0;
    const children = [];
    for (const child of node.children) {
      if (targets.has(child.path)) {
        changed = true;
        removedCount += Math.max(1, Number(child.itemCount) || 0);
        removedBytes += Math.max(0, Number(child.size) || 0);
        continue;
      }
      const result = visit(child);
      if (result.changed) {
        changed = true;
        removedCount += result.removedCount;
        removedBytes += result.removedBytes;
      }
      children.push(result.node);
    }
    return changed
      ? {
        node: {
          ...node,
          size: Math.max(0, Number(node.size || 0) - removedBytes),
          itemCount: Math.max(0, (Number(node.itemCount) || 0) - removedCount),
          children
        },
        changed: true,
        removedCount,
        removedBytes
      }
      : { node, changed: false, removedCount: 0, removedBytes: 0 };
  };

  const result = visit(tree);
  return { tree: result.node, changed: result.changed, removedCount: result.removedCount, removedBytes: result.removedBytes };
}
const TYPE_ORDER = { directory: 0, file: 1, special: 2 };
const TYPE_FILTER_EXTENSIONS = Object.freeze({
  audio: new Set(['.aac', '.aiff', '.alac', '.caf', '.flac', '.m4a', '.m4b', '.mp3', '.oga', '.ogg', '.opus', '.wav', '.wma']),
  video: new Set(['.3gp', '.avi', '.flv', '.m2ts', '.m4v', '.mkv', '.mov', '.mp4', '.mpeg', '.mpg', '.ts', '.webm', '.wmv']),
  image: new Set(['.avif', '.bmp', '.gif', '.heic', '.heif', '.ico', '.jpeg', '.jpg', '.png', '.raw', '.svg', '.tif', '.tiff', '.webp']),
  archive: new Set(['.7z', '.bz2', '.cpio', '.gz', '.iso', '.rar', '.tar', '.tbz', '.tbz2', '.tgz', '.txz', '.xz', '.zip']),
  text: new Set(['.c', '.cc', '.cpp', '.css', '.csv', '.h', '.hpp', '.html', '.ini', '.js', '.json', '.jsx', '.log', '.md', '.py', '.rtf', '.sh', '.swift', '.toml', '.ts', '.tsx', '.txt', '.xml', '.yaml', '.yml']),
  document: new Set(['.doc', '.docx', '.epub', '.key', '.numbers', '.pages', '.pdf', '.ppt', '.pptx', '.xls', '.xlsx']),
  font: new Set(['.otf', '.ttf', '.woff', '.woff2']),
  database: new Set(['.db', '.mdb', '.sqlite', '.sqlite3'])
});

function getNodeFileClass(node, metadataByPath) {
  if (node?.type === 'directory') return 'folders';
  if (node?.type === 'special') return 'special';
  if (node?.type !== 'file') return 'other';
  const classified = String(metadataByPath?.[node.path]?.classification || '').toLowerCase();
  if (classified && classified !== 'file') return classified;
  const value = String(node.name || node.path || '').toLowerCase();
  const dot = value.lastIndexOf('.');
  const extension = dot >= 0 ? value.slice(dot) : '';
  for (const [category, extensions] of Object.entries(TYPE_FILTER_EXTENSIONS)) {
    if (extensions.has(extension)) return category;
  }
  return 'other';
}

const TYPE_FILTER_OPTIONS = [
  ['folders', 'Folders'],
  ['files', 'Files'],
  ['audio', 'Audio'],
  ['video', 'Video'],
  ['image', 'Image'],
  ['text', 'Text'],
  ['document', 'Document'],
  ['archive', 'Archive'],
  ['font', 'Font'],
  ['database', 'Database'],
  ['other', 'Other files'],
  ['special', 'System accounting']
];
const DEFAULT_VIEW_OPTIONS = {
  sortBy: 'size',
  sortDirection: 'desc',
  typeFilter: [],
  sizeFilter: 'all',
  dateFilter: 'all',
  nameQuery: ''
};

function getNodeDate(node, metadataByPath) {
  return Number(metadataByPath?.[node?.path]?.modifiedAt || node?.modifiedAt || 0);
}

function matchesViewFilters(node, options, metadataByPath) {
  const query = options.nameQuery.trim().toLocaleLowerCase();
  if (query && !String(node.name || '').toLocaleLowerCase().includes(query)) return false;
  const selectedTypes = Array.isArray(options.typeFilter)
    ? options.typeFilter
    : (options.typeFilter && options.typeFilter !== 'all' ? [options.typeFilter] : []);
  if (selectedTypes.length) {
    const nodeClass = getNodeFileClass(node, metadataByPath);
    const matchesAnyType = selectedTypes.some(type => {
      if (type === 'files') return node.type === 'file';
      if (type === 'folders') return node.type === 'directory';
      if (type === 'special') return node.type === 'special';
      return nodeClass === type;
    });
    if (!matchesAnyType) return false;
  }

  const size = Number(node.size || 0);
  if (options.sizeFilter === '1mb' && size < 1e6) return false;
  if (options.sizeFilter === '100mb' && size < 100e6) return false;
  if (options.sizeFilter === '1gb' && size < 1e9) return false;

  const nodeDate = getNodeDate(node, metadataByPath);
  if (options.dateFilter !== 'all') {
    const days = Number(options.dateFilter);
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    if (!nodeDate || nodeDate < cutoff) return false;
  }
  return true;
}

function sortNodes(nodes, options, metadataByPath) {
  const direction = options.sortDirection === 'asc' ? 1 : -1;
  return [...nodes].sort((a, b) => {
    let result = 0;
    if (options.sortBy === 'name') {
      result = String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base', numeric: true });
    } else if (options.sortBy === 'type') {
      result = (TYPE_ORDER[a.type] ?? 99) - (TYPE_ORDER[b.type] ?? 99);
      if (result === 0) result = String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base', numeric: true });
    } else if (options.sortBy === 'date') {
      result = getNodeDate(a, metadataByPath) - getNodeDate(b, metadataByPath);
    } else {
      result = (Number(a.size) || 0) - (Number(b.size) || 0);
    }
    if (result === 0) result = String(a.path || '').localeCompare(String(b.path || ''));
    return result * direction;
  });
}

const EMPTY_METADATA = Object.freeze({});
const MAX_PREVIEW_CHILDREN = 100;
const ARROW_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
const ARROW_MODULE_SELECTORS = [
  ['terminal', '.terminal-drawer'],
  ['view-options', '.view-options-panel'],
  ['context-menu', '.ctx-menu'],
  ['assistant', '.assistant-drawer']
];

function describeArrowElement(element) {
  if (!element || typeof element.closest !== 'function') {
    return { tag: null, id: null, className: null, closestModule: null };
  }
  const className = element.getAttribute?.('class') || (typeof element.className === 'string' ? element.className : null);
  const moduleMatch = ARROW_MODULE_SELECTORS.find(([, selector]) => element.closest(selector));
  return {
    tag: element.tagName ? element.tagName.toLowerCase() : null,
    id: element.id || null,
    className: className || null,
    closestModule: moduleMatch?.[0] || null
  };
}

function ThemedSelect({ value, options, onChange, ariaLabel }) {
  const [open, setOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const rootRef = useRef(null);
  const triggerRef = useRef(null);
  const menuRef = useRef(null);
  const selectedIndex = Math.max(0, options.findIndex(option => option.value === value));
  const selectedOption = options[selectedIndex] || options[0];

  const close = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) window.requestAnimationFrame(() => triggerRef.current?.focus());
  };
  const choose = index => {
    const option = options[index];
    if (!option) return;
    onChange(option.value);
    setHighlightedIndex(index);
    close(true);
  };
  const openMenu = () => {
    setHighlightedIndex(selectedIndex);
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = event => {
      if (!rootRef.current?.contains(event.target)) close();
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.requestAnimationFrame(() => menuRef.current?.focus());
    return () => window.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  const handleTriggerKeyDown = event => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
      event.preventDefault();
      if (!open) openMenu();
      else setHighlightedIndex(index => Math.min(options.length - 1, index + 1));
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
      event.preventDefault();
      if (!open) openMenu();
      else setHighlightedIndex(index => Math.max(0, index - 1));
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (open) choose(highlightedIndex);
      else openMenu();
    } else if (event.key === 'Escape' && open) {
      event.preventDefault();
      close();
    }
  };
  const handleMenuKeyDown = event => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
      event.preventDefault();
      setHighlightedIndex(index => Math.min(options.length - 1, index + 1));
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
      event.preventDefault();
      setHighlightedIndex(index => Math.max(0, index - 1));
    } else if (event.key === 'Home') {
      event.preventDefault();
      setHighlightedIndex(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      setHighlightedIndex(options.length - 1);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      choose(highlightedIndex);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      close();
    } else if (event.key === 'Tab') {
      close();
    }
  };

  return (
    <div ref={rootRef} className="filter-select">
      <button
        ref={triggerRef}
        type="button"
        className={`filter-select-trigger ${open ? 'open' : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={event => {
          event.stopPropagation();
          if (open) close();
          else openMenu();
        }}
        onKeyDown={handleTriggerKeyDown}
      >
        <span>{selectedOption?.label || ''}</span>
        <ChevronDown size={10} />
      </button>
      {open && (
        <div ref={menuRef} className="filter-select-menu" role="listbox" tabIndex={-1} aria-label={ariaLabel} onClick={event => event.stopPropagation()} onKeyDown={handleMenuKeyDown}>
          {options.map((option, index) => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === value}
              className={`filter-select-option ${index === highlightedIndex ? 'highlighted' : ''} ${option.value === value ? 'selected' : ''}`}
              onMouseEnter={() => setHighlightedIndex(index)}
              onClick={() => choose(index)}
            >
              <span>{option.label}</span>
              {option.value === value && <span className="filter-select-check" aria-hidden="true">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function CrawlLabel({ name, className = '', active = false }) {
  const labelRef = useRef(null);
  const textRef = useRef(null);
  const [hovered, setHovered] = useState(false);
  const [crawling, setCrawling] = useState(false);
  const [crawlDistance, setCrawlDistance] = useState(0);

  useEffect(() => {
    setCrawling(false);
    setCrawlDistance(0);
    if (!active && !hovered) return undefined;
    const timer = window.setTimeout(() => {
      const label = labelRef.current;
      const text = textRef.current;
      const overflow = label && text ? text.scrollWidth - label.clientWidth : 0;
      if (overflow > 1 && text) {
        setCrawlDistance(text.scrollWidth + 28);
        setCrawling(true);
      }
    }, 100);
    return () => window.clearTimeout(timer);
  }, [active, hovered, name]);

  return (
    <span
      ref={labelRef}
      className={`legend-label ${className} ${crawling ? 'is-crawling' : ''}`}
      style={crawling ? { '--crawl-distance': `${crawlDistance}px` } : undefined}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <span className="legend-label-track">
        <span ref={textRef} className="legend-label-text">{name}</span>
        {crawling && <span className="legend-label-text legend-label-copy" aria-hidden="true">{name}</span>}
      </span>
    </span>
  );
}

function buildShallowDisplayNode(
  node,
  options,
  metadataByPath,
  packageContentsShown = {},
  cache,
  optionsKey,
  needsMetadata
) {
  if (!node) return null;
  const packageCollapsed = isPackageContainerNode(node) && !packageContentsShown[node.path];
  const cacheKey = `${optionsKey}|shallow|${packageCollapsed ? 'collapsed' : 'expanded'}`;
  const cached = cache?.get(node);
  if (cached && cached.key === cacheKey && (!needsMetadata || cached.metadata === metadataByPath)) {
    return cached.value;
  }

  const candidates = packageCollapsed ? [] : (node.children || [])
    .filter(child => matchesViewFilters(child, options, metadataByPath));
  let children = candidates;
  let previewLimited = false;
  const previewTotalFiles = candidates.filter(child => child.type === 'file').length;
  const fileCandidates = candidates.filter(child => child.type === 'file');

  if (fileCandidates.length > MAX_PREVIEW_CHILDREN || candidates.length > MAX_PREVIEW_CHILDREN) {
    const rankedPool = fileCandidates.length > MAX_PREVIEW_CHILDREN ? fileCandidates : candidates;
    const ranked = sortNodes(rankedPool, { ...options, sortBy: 'size', sortDirection: 'desc' }, metadataByPath);
    children = sortNodes(ranked.slice(0, MAX_PREVIEW_CHILDREN), options, metadataByPath);
    previewLimited = children.length < candidates.length;
  }

  const value = {
    ...node,
    children,
    previewLimited,
    previewTotalChildren: candidates.length,
    previewTotalFiles
  };
  cache?.set(node, { key: cacheKey, metadata: needsMetadata ? metadataByPath : null, value });
  return value;
}

function buildDisplayNode(
  node,
  options,
  metadataByPath,
  packageContentsShown = {},
  cache,
  optionsKey,
  needsMetadata
) {
  if (!node) return null;
  const packageCollapsed = isPackageContainerNode(node) && !packageContentsShown[node.path];
  const cacheKey = `${optionsKey}|${packageCollapsed ? 'collapsed' : 'expanded'}`;
  const cached = cache?.get(node);
  if (cached && cached.key === cacheKey && (!needsMetadata || cached.metadata === metadataByPath)) {
    return cached.value;
  }

  const children = packageCollapsed ? [] : sortNodes(
    (node.children || [])
      .filter(child => matchesViewFilters(child, options, metadataByPath))
      .map(child => buildDisplayNode(
        child,
        options,
        metadataByPath,
        packageContentsShown,
        cache,
        optionsKey,
        needsMetadata
      )),
    options,
    metadataByPath
  );
  const value = { ...node, children };
  cache?.set(node, { key: cacheKey, metadata: needsMetadata ? metadataByPath : null, value });
  return value;
}

const TERMINAL_COMMAND_PRESETS = [
  {
    command: 'pwd',
    label: 'pwd',
    syntax: 'pwd [-L|-P]',
    purpose: 'Print the current working directory.',
    options: '-L keeps the logical path; -P resolves physical symlinks.',
    examples: 'pwd\npwd -P',
    help: 'Print the current working directory. macOS options: -L uses the logical path; -P resolves physical symlinks. Examples: pwd, pwd -P. This drawer executes the safe pwd template only.'
  },
  {
    command: 'ls -lah',
    label: 'ls',
    syntax: 'ls [options] [path]',
    purpose: 'List files and folders in a directory.',
    options: '-a hidden entries; -A omit . and ..; -l long format; -h human sizes; -G color; -t modified-time order; -S size order; -R recursive.',
    examples: 'ls -lah\nls -lt ~/Library',
    help: 'List directory contents. Common macOS options: -a include hidden entries, -A omit . and .., -l long format, -h human sizes, -G colorize, -t sort by modified time, -S sort by size, -R recurse. Examples: ls -lah, ls -lt. This drawer permits read-only ls templates.'
  },
  {
    command: 'du -sh .',
    label: 'du -sh',
    syntax: 'du [options] [path]',
    purpose: 'Measure disk usage, normally as a directory summary.',
    options: '-s summary only; -h human-readable; -a every file; -d depth limit; -x one filesystem.',
    examples: 'du -sh .\ndu -sh ~/Library/Caches',
    help: 'Show disk usage for a directory. -s summary, -h human-readable sizes; common macOS options include -a all files, -d depth, -x stay on one filesystem. Examples: du -sh ., du -sh ~/Library/Caches. This drawer executes the safe du -sh template only.'
  },
  {
    command: 'df -h',
    label: 'df',
    syntax: 'df [options] [path]',
    purpose: 'Show free, used and available space for mounted filesystems.',
    options: '-h human-readable; -k 1024-byte blocks; -P portable format; -T type where supported.',
    examples: 'df -h\ndf -h /System/Volumes/Data',
    help: 'Show filesystem free/used space. -h human-readable, -k 1024-byte blocks, -P portable one-line format, -T filesystem type on supported macOS versions. Examples: df -h, df -h /System/Volumes/Data. This drawer executes the safe df -h template only.'
  },
  {
    command: 'clear',
    label: 'clear',
    syntax: 'clear',
    purpose: 'Clear the visible Terminal output without running a shell command.',
    options: 'No options. This is handled locally by Sunburst Disk.',
    examples: 'clear',
    help: 'Clear the Terminal output locally. No filesystem or shell operation is performed.'
  }
];

const TERMINAL_ADMIN_COMMAND_PRESETS = [
  {
    command: 'touch new-file.txt',
    label: 'touch',
    syntax: 'touch [file]',
    purpose: 'Create an empty file inside the current folder.',
    options: 'Use a relative filename or path; the app rejects targets outside the current folder.',
    examples: 'touch new-file.txt',
    help: 'Admin-only write helper. Creates an empty file inside the current folder; delete, overwrite scripts and arbitrary shell syntax remain blocked.'
  },
  {
    command: 'mkdir -p new-folder',
    label: 'mkdir',
    syntax: 'mkdir -p [folder]',
    purpose: 'Create a folder, including missing parent folders, inside the current folder.',
    options: '-p creates missing parents; the app rejects targets outside the current folder.',
    examples: 'mkdir -p new-folder',
    help: 'Admin-only write helper. Creates a directory inside the current folder; deletion and arbitrary shell syntax remain blocked.'
  },
  {
    command: 'rm -- file.txt',
    label: 'rm',
    syntax: 'rm -- [file]',
    purpose: 'Remove one selected file or folder from the current folder.',
    options: '-- ends options; the app rejects targets outside the current folder and protected roots.',
    examples: 'rm -- old-file.txt',
    help: 'Admin-only destructive helper. The app asks for confirmation before running it and blocks protected roots.'
  },
  {
    command: 'mv -- source target',
    label: 'mv',
    syntax: 'mv -- [source] [target]',
    purpose: 'Move or rename an object inside the current folder.',
    options: '-- ends options; both source and destination must stay inside the current folder.',
    examples: 'mv -- draft.txt Archive/draft.txt',
    help: 'Admin-only move/rename helper. The app asks for confirmation and keeps both paths inside the current folder.'
  },
  {
    command: 'cp -R -- source target',
    label: 'cp -R',
    syntax: 'cp -R -- [source] [target]',
    purpose: 'Copy a file or folder inside the current folder.',
    options: '-R copies directories; -- ends options; both paths remain scoped to the current folder.',
    examples: 'cp -R -- Photos Photos-copy',
    help: 'Admin-only copy helper. The app asks for confirmation and rejects paths outside the current folder.'
  },
  {
    command: 'ln -s -- target link-name',
    label: 'ln',
    syntax: 'ln -s -- [target] [link-name]',
    purpose: 'Create a symbolic link to a file or folder inside the current folder.',
    options: '-s creates a symbolic link; -- ends options; both target and link name stay scoped to the current folder.',
    examples: 'ln -s -- Documents Shared-Documents',
    help: 'Admin-only link helper. Creates a symbolic link without copying the target; the app rejects paths outside the current folder and protected system roots.'
  }
];

function normalizeSmartCleanRiskValue(risk) {
  const value = String(risk || '').trim().toLowerCase().replaceAll('_', '-');
  if (value === 'safe') return 'safe';
  if (value === 'high' || value === 'high-risk' || value === 'high risk') return 'high';
  return 'review';
}

// Smart Clean candidates carry an ISO `modifiedAt`; surface its age so stale
// caches read like the review lists in comparable disk tools.
function smartCleanAgeDays(candidate) {
  const parsed = Date.parse(candidate?.modifiedAt || '');
  if (!Number.isFinite(parsed)) return null;
  const days = Math.floor((Date.now() - parsed) / 86400000);
  return days >= 0 ? days : null;
}

function formatSmartCleanAge(days) {
  if (days === null || days === undefined) return null;
  return days <= 0 ? 'today' : `${days}d ago`;
}

function buildSmartCleanTelemetry(candidates, riskFilter = 'all', categoryFilters = new Set()) {
  const categoryIds = [...categoryFilters];
  const normalized = (candidates || []).map(candidate => ({
    ...candidate,
    normalizedRisk: normalizeSmartCleanRiskValue(candidate.risk),
    rawRisk: String(candidate.risk ?? '')
  }));
  const visible = normalized.filter(candidate => (
    (riskFilter === 'all' || candidate.normalizedRisk === riskFilter)
      && (categoryIds.length === 0 || categoryIds.includes(candidate.categoryId))
  ));
  const counts = values => values.reduce((result, value) => ({ ...result, [value || '(empty)']: (result[value || '(empty)'] || 0) + 1 }), {});
  const sample = items => items.slice(0, 80).map(candidate => ({
    path: candidate.path,
    name: candidate.name,
    category: candidate.category,
    categoryId: candidate.categoryId,
    rawRisk: candidate.rawRisk,
    normalizedRisk: candidate.normalizedRisk,
    size: Number(candidate.size) || 0
  }));
  return {
    activeRiskFilter: riskFilter,
    activeCategoryIds: categoryIds,
    totalCandidates: normalized.length,
    rawRiskCounts: counts(normalized.map(candidate => candidate.rawRisk)),
    normalizedRiskCounts: counts(normalized.map(candidate => candidate.normalizedRisk)),
    visibleRiskCounts: counts(visible.map(candidate => candidate.normalizedRisk)),
    riskViolations: riskFilter === 'all' ? [] : sample(visible.filter(candidate => candidate.normalizedRisk !== riskFilter)),
    visibleCandidateCount: visible.length,
    visibleSample: sample(visible),
    candidateSample: sample(normalized)
  };
}

// Injected by Vite from package.json (see vite.config.js).
const APP_VERSION = __APP_VERSION__;
const ONBOARDING_STORAGE_KEY = 'sunburst-disk.onboarding-version';

// Content of the onboarding "Recent improvements" list: one entry per release,
// newest first. Add a new entry for each version — the running version's entry
// is shown on the "What's new" page after an update.
const RELEASE_HIGHLIGHTS = {
  '0.3.3': [
    '“Check for Updates…” now lives in the app menu, directly under “About Sunburst Disk”.',
    'It reports the result in a native dialog — with a Download button when a newer version is available — instead of the old footer button.'
  ],
  '0.3.2': [
    'The startup disk now shows your real disk name; the app no longer ships any developer-machine disk data.',
    'New “Check for Updates…” in the home footer compares your version with the newest release and links to the download — it never installs anything on its own.',
    'The “What’s new” list is now written per release, so every update describes its own changes.'
  ],
  '0.3.1': [
    'The locked “hidden space…” slice is a neutral outline and pulses to fully transparent on hover; the pale-red fill is reserved for the unlocked session.',
    'The content-tree title scrolls automatically while a slice is hovered, Sort & Filter is a compact icon, and the preview badges are gone.',
    'Smart Clean rows show each candidate’s age and flag safe caches unused for 60+ days, ordered largest first.',
    'The startup disk now shows your real disk name instead of a hard-coded one.'
  ]
};

const CORE_FEATURES = [
  'Interactive sunburst and stable content-tree selection, including held ArrowUp/ArrowDown movement.',
  'Live Finder change reconciliation through the macOS FSEvents watcher and explicit Refresh.',
  'Review-first Collector and System Smart Clean preview with Safe, Moderate and High-risk tiers; protected roots remain blocked.',
  'Archive/package contents, Quick Look, Finder Reveal, Get Info, Open With, Terminal helpers and Classic/Matrix themes.'
];

export default function App() {
  const [viewState, setViewState]           = useState('drives');
  const [drives, setDrives]                 = useState([]);
  const [currentDrive, setCurrentDrive]     = useState(null);
  const [scannedTree, setScannedTree]       = useState(null);
  const [scanCache, setScanCache]           = useState({});
  const [driveMenuKey, setDriveMenuKey]     = useState(null);
  const [navStack, setNavStack]             = useState([]);
  const [historyBack, setHistoryBack]       = useState([]);
  const [historyForward, setHistoryForward] = useState([]);
  const [detailsOpen, setDetailsOpen]       = useState(true);
  const [matrixTheme, setMatrixTheme]       = useState(() => {
    try { return window.localStorage.getItem('sunburst-disk.theme') === 'matrix'; } catch { return false; }
  });
  const [focusedNode, setFocusedNode]       = useState(null);
  const [pointerNode, setPointerNode]       = useState(null);
  const [itemDetails, setItemDetails]       = useState(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [hoveredNode, setHoveredNode]       = useState(null);
  const [highlightedPath, setHighlightedPath] = useState(null);
  const [keyboardNavigationActive, setKeyboardNavigationActive] = useState(false);
  const [treeSelectionPath, setTreeSelectionPath] = useState(null);
  const [loading, setLoading]               = useState(false);
    const [scanError, setScanError]       = useState(null);
  const [scanNotice, setScanNotice]     = useState(null);
  const [updateActivity, setUpdateActivity] = useState(null);

  const [scanProgress, setScanProgress]     = useState({ percent: 0, currentDir: '', itemsScanned: 0 });
  const pendingScanCompletionRef = useRef(null);
  const activeScanRequestRef = useRef(null);
  const scanRequestSequenceRef = useRef(0);
  const [collector, setCollector]           = useState([]);
  const [isDragOver, setIsDragOver]         = useState(false);
  const [collectorExpanded, setCollectorExpanded] = useState(false);
  const [countdown, setCountdown]           = useState(null);
  const [contextMenu, setContextMenu]       = useState(null);
  const contextMenuRef = useRef(null);
  const [contextOpenWith, setContextOpenWith] = useState(null);
  const [viewOptions, setViewOptions]       = useState(DEFAULT_VIEW_OPTIONS);
  const [metadataByPath, setMetadataByPath] = useState({});
  const [breadcrumbsCompact, setBreadcrumbsCompact] = useState(false);
  const [breadcrumbsMenuOpen, setBreadcrumbsMenuOpen] = useState(false);
  const [viewOptionsOpen, setViewOptionsOpen] = useState(false);
  const [themesOpen, setThemesOpen] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [terminalCommand, setTerminalCommand] = useState('df -h');
  const [terminalHelpKey, setTerminalHelpKey] = useState('df -h');
  const [terminalHelperHoverKey, setTerminalHelperHoverKey] = useState(null);
  const [terminalOutput, setTerminalOutput] = useState(null);
  const [terminalBusy, setTerminalBusy] = useState(false);
  const [terminalHistory, setTerminalHistory] = useState([]);
  const [terminalHistoryIndex, setTerminalHistoryIndex] = useState(-1);
  const [terminalAdminMode, setTerminalAdminMode] = useState(false);
  const [terminalAdminPassword, setTerminalAdminPassword] = useState('');
  const [terminalAdminPromptOpen, setTerminalAdminPromptOpen] = useState(false);
  const [terminalAdminError, setTerminalAdminError] = useState(null);
  const [ejectingDriveKey, setEjectingDriveKey] = useState(null);
  const [terminalFrame, setTerminalFrame] = useState({ left: 20, top: 20 });
  const [smartCleanOpen, setSmartCleanOpen] = useState(false);
  const [smartCleanLoading, setSmartCleanLoading] = useState(false);
  const [smartCleanData, setSmartCleanData] = useState(null);
  const [smartCleanSelected, setSmartCleanSelected] = useState(() => new Set());
  const [smartCleanMenuOpen, setSmartCleanMenuOpen] = useState(false);
  const [smartCleanScope, setSmartCleanScope] = useState('storage');
  const [smartCleanRiskFilter, setSmartCleanRiskFilter] = useState('all');
  const [smartCleanCategoryFilters, setSmartCleanCategoryFilters] = useState(() => new Set());
  const [hiddenSpaceAdminPromptOpen, setHiddenSpaceAdminPromptOpen] = useState(false);
  const [hiddenSpaceAdminPassword, setHiddenSpaceAdminPassword] = useState('');
  const [hiddenSpaceAdminError, setHiddenSpaceAdminError] = useState(null);
  const [hiddenSpaceAdminAuthorized, setHiddenSpaceAdminAuthorized] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [assistantLoading, setAssistantLoading] = useState(false);
  const [assistantItem, setAssistantItem] = useState(null);
  const [assistantResult, setAssistantResult] = useState(null);
  const [assistantCopied, setAssistantCopied] = useState(false);
  const [assistantTransformMode, setAssistantTransformMode] = useState(null);
  const [assistantTransformError, setAssistantTransformError] = useState(null);
  const [folderWatchState, setFolderWatchState] = useState({ active: false, rootPath: null, updating: false, error: null, lastChangedAt: null });
  const [onboardingOpen, setOnboardingOpen] = useState(() => {
    try { return window.localStorage.getItem(ONBOARDING_STORAGE_KEY) !== APP_VERSION; } catch { return true; }
  });
  const [onboardingIsUpdate] = useState(() => {
    try {
      const previousVersion = window.localStorage.getItem(ONBOARDING_STORAGE_KEY);
      return Boolean(previousVersion) && previousVersion !== APP_VERSION;
    } catch { return false; }
  });
  const [askSiriSetupStatus, setAskSiriSetupStatus] = useState(null);

  const contextOpenWithRequestRef = useRef(0);
  const quickLookPathRef = useRef(null);
  const quickLookNodeRef = useRef(null);
  const quickLookKeyboardPriorityRef = useRef(false);
  const keyboardNavigationRef = useRef(false);
  const quickLookFollowRequestRef = useRef(0);
  const terminalDragRef = useRef(null);
  const terminalDrawerRef = useRef(null);
  const hiddenSpacePendingNodeRef = useRef(null);
  const terminalHelperPreviousHeightRef = useRef(null);
  const folderWatchTreeRef = useRef(null);
  const folderWatchTargetRef = useRef(null);
  const folderWatchBusyRef = useRef(false);
  const folderWatchQueuedRef = useRef(null);
  const folderWatchGenerationRef = useRef(0);
  const folderWatchUpdatingTimerRef = useRef(null);
  const arrowStateRef = useRef({ currentViewPath: null, visibleChildren: [], treeSelectionPath: null, pointerNode: null, focusedNode: null, hoveredNode: null, highlightedPath: null, keyboardNavigationActive: false });
  const arrowEventSequenceRef = useRef(0);
  const breadcrumbRef = useRef(null);
  const breadcrumbMeasureRef = useRef(null);
  const countdownTimerRef = useRef(null);
  const [nodeLoading, setNodeLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [packageContentsShown, setPackageContentsShown] = useState({});
  const [packageContentsStatus, setPackageContentsStatus] = useState({});
  const [archiveContentsByPath, setArchiveContentsByPath] = useState({});

  useEffect(() => {
    try { window.localStorage.setItem('sunburst-disk.theme', matrixTheme ? 'matrix' : 'classic'); } catch {}
  }, [matrixTheme]);

  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.setWindowLayout) return;
    const layout = viewState === 'drives' ? 'drives' : 'scan';
    void api.setWindowLayout(layout, layout === 'drives' ? drives.length : 0).catch(() => {});
  }, [drives.length, viewState]);

  useEffect(() => {
    const drawer = terminalDrawerRef.current;
    if (!drawer || !terminalOpen) return undefined;
    if (terminalHelperHoverKey) {
      if (terminalHelperPreviousHeightRef.current === null) {
        terminalHelperPreviousHeightRef.current = drawer.getBoundingClientRect().height;
      }
      const area = drawer.parentElement;
      const availableHeight = area ? Math.max(210, area.clientHeight - drawer.offsetTop - 16) : 420;
      const expandedHeight = Math.min(Math.max(terminalHelperPreviousHeightRef.current, 350), availableHeight);
      drawer.style.height = `${expandedHeight}px`;
    } else if (terminalHelperPreviousHeightRef.current !== null) {
      drawer.style.height = `${terminalHelperPreviousHeightRef.current}px`;
      terminalHelperPreviousHeightRef.current = null;
    }
    return undefined;
  }, [terminalHelperHoverKey, terminalOpen]);

  // Keep the Set identity stable; Sunburst uses it as a draw dependency.
  // Recreating it on every App render forced a full canvas redraw on unrelated UI updates.
  const collectedPaths = useMemo(() => new Set(collector.map(i => i.path)), [collector]);

  const addToCollector = useCallback((item) => {
    if (!item || !item.path || item.path.startsWith('__') || !getRiskInfo(item).canDelete) return;
    setCollector(current => current.some(existing => existing.path === item.path)
      ? current
      : [...current, item]);
  }, []);

  const collectItem = useCallback(async (item) => {
    if (!item || !item.path || item.path.startsWith('__') || !getRiskInfo(item).canDelete) return;
    if (!isAppBundleNode(item) || !window.electronAPI?.inspectAppRelated) {
      addToCollector(item);
      return;
    }
    try {
      const result = await window.electronAPI.inspectAppRelated(item.path);
      addToCollector({
        ...item,
        relatedResources: Array.isArray(result?.resources) ? result.resources : [],
        relatedResourcesLoaded: true
      });
    } catch {
      addToCollector({ ...item, relatedResources: [], relatedResourcesLoaded: true });
    }
  }, [addToCollector]);

  // ── Debug instrumentation (enable in DevTools console: __DISK_DEBUG = true) ──
  const dbg = (...args) => { if (window.__DISK_DEBUG) console.log('[disk-analyzer]', ...args); };

  // Resolve a node BY PATH from the master tree — the single source of truth.
  // navStack may hold stale object copies after enrichment; resolving by path
  // guarantees chart, sidebar, and breadcrumbs always see identical data.
  function resolveByPath(tree, targetPath) {
    if (!tree || !targetPath) return null;
    if (tree.path === targetPath) return tree;
    if (targetPath.startsWith('__')
      && targetPath !== '__hidden__'
      && !targetPath.startsWith('__hidden__:')) return null;
    for (const c of tree.children || []) {
      const found = resolveByPath(c, targetPath);
      if (found) return found;
    }
    return null;
  }


  // Current node for navigation — resolved by path against the LIVE master
  // tree so enrichment updates propagate to chart + sidebar simultaneously.
  const rawCurrent = navStack.length > 0 ? navStack[navStack.length - 1] : scannedTree;
  const currentViewNode = useMemo(() => {
    if (rawCurrent && scannedTree && rawCurrent !== scannedTree) {
      return resolveByPath(scannedTree, rawCurrent.path) || rawCurrent;
    }
    return scannedTree || rawCurrent;
  }, [rawCurrent, scannedTree]);

  // Apply the same filtered/sorted view to the legend and sunburst. The master
  // tree remains untouched so navigation, sizes, and deletion stay authoritative.
  // The chart must stay anchored to the navigated folder. Using the hovered
  // subtree as canvas data made pointer movement change the hit-test geometry
  // under the pointer, which caused flicker, wrong previews and empty hubs.
  const liveHoveredNode = useMemo(() => {
    if (!hoveredNode?.path || !scannedTree) return hoveredNode;
    return resolveByPath(scannedTree, hoveredNode.path) || hoveredNode;
  }, [hoveredNode, scannedTree]);
  const currentArchiveChildren = currentViewNode?.path ? archiveContentsByPath[currentViewNode.path] : null;
  const currentViewDisplayNode = useMemo(() => {
    if (!currentViewNode || !Array.isArray(currentArchiveChildren)) return currentViewNode;
    return {
      ...currentViewNode,
      children: currentArchiveChildren,
      archiveContainer: true,
      itemCount: currentArchiveChildren.reduce((sum, child) => sum + 1 + (child.itemCount || 0), 0)
    };
  }, [currentViewNode, currentArchiveChildren]);
  const isCollapsedAppHover = Boolean(
    liveHoveredNode?.path?.toLowerCase?.().endsWith('.app')
      && !packageContentsShown[liveHoveredNode.path]
  );
  const previewSource = isCollapsedAppHover
    ? liveHoveredNode
    : liveHoveredNode && liveHoveredNode.children && liveHoveredNode.children.length > 0
      ? liveHoveredNode
      : currentViewDisplayNode;
  const needsDisplayMetadata = viewOptions.sortBy === 'date' || viewOptions.dateFilter !== 'all';
  const displayMetadata = needsDisplayMetadata ? metadataByPath : EMPTY_METADATA;
  const displayCacheRef = useRef(new WeakMap());
  const packageContentsKey = Object.keys(packageContentsShown)
    .filter(path => packageContentsShown[path])
    .sort()
    .join('\u001f');
  const displayOptionsKey = `${viewOptions.sortBy}|${viewOptions.sortDirection}|${viewOptions.typeFilter}|${viewOptions.sizeFilter}|${viewOptions.dateFilter}|${viewOptions.nameQuery}|packages:${packageContentsKey}`;
  const previewNode = useMemo(() => {
    const startedAt = performance.now();
    const isHoverPreview = previewSource?.path !== currentViewNode?.path;
    const result = isHoverPreview
      ? buildShallowDisplayNode(
        previewSource,
        viewOptions,
        displayMetadata,
        packageContentsShown,
        displayCacheRef.current,
        displayOptionsKey,
        needsDisplayMetadata
      )
      : buildDisplayNode(
        previewSource,
        viewOptions,
        displayMetadata,
        packageContentsShown,
        displayCacheRef.current,
        displayOptionsKey,
        needsDisplayMetadata
      );
    recordPerfEvent('display-tree.build', performance.now() - startedAt, {
      path: previewSource?.path || null,
      children: previewSource?.children?.length || 0,
      previewChildren: result?.children?.length || 0,
      previewTotalChildren: result?.previewTotalChildren || result?.children?.length || 0,
      role: 'content-preview',
      mode: isHoverPreview ? 'shallow' : 'recursive'
    });
    return result;
  }, [previewSource, currentViewNode, viewOptions, displayMetadata, packageContentsShown, displayOptionsKey, needsDisplayMetadata]);
  const chartNode = useMemo(() => {
    const startedAt = performance.now();
    const result = buildDisplayNode(
      currentViewDisplayNode,
      viewOptions,
      displayMetadata,
      packageContentsShown,
      displayCacheRef.current,
      displayOptionsKey,
      needsDisplayMetadata
    );
    recordPerfEvent('display-tree.build', performance.now() - startedAt, {
      path: currentViewDisplayNode?.path || null,
      children: currentViewDisplayNode?.children?.length || 0,
      role: 'chart'
    });
    return result;
  }, [currentViewDisplayNode, viewOptions, displayMetadata, packageContentsShown, displayOptionsKey, needsDisplayMetadata]);
  const colorAssignments = useMemo(() => Object.fromEntries((previewNode?.children || []).map((item, index) => [
    item.path,
    getNodeColor(item, index, matrixTheme)
  ])), [previewNode, matrixTheme]);
  const chartColorAssignments = useMemo(() => ({}), []);
  const focusedLiveNode = useMemo(() => {
    if (focusedNode && scannedTree) return resolveByPath(scannedTree, focusedNode.path) || focusedNode;
    return focusedNode;
  }, [focusedNode, scannedTree]);
  const focusedPath = focusedLiveNode?.path || null;

  const hoverPathRef = useRef(null);
  const handleHoverNode = useCallback((node) => {
    keyboardNavigationRef.current = false;
    quickLookKeyboardPriorityRef.current = false;
    setKeyboardNavigationActive(false);
    const nextPath = node?.path || null;
    if (hoverPathRef.current === nextPath) return;
    hoverPathRef.current = nextPath;
    recordPerfInstant('ui.hover-change', { path: nextPath, type: node?.type || null });
    setHoveredNode(node);
    setPointerNode(node);
    setFocusedNode(current => current?.path === nextPath ? current : node);
  }, []);

  dbg('render', {
    view: currentViewNode?.path,
    viewChildren: currentViewNode?.children?.length,
    hover: hoveredNode ? { p: hoveredNode.path, kids: hoveredNode.children?.length } : null,
    preview: previewNode?.path,
    previewChildren: previewNode?.children?.length,
    sort: viewOptions,
    stack: navStack.map(n => n.path)
  });

  useEffect(() => { fetchDrives(); }, []);

  useEffect(() => {
    if (!window.electronAPI?.inspectItems || !previewSource?.children?.length) return undefined;
    if (viewOptions.sortBy !== 'date' && viewOptions.dateFilter === 'all') return undefined;
    let cancelled = false;
    const paths = previewSource.children
      .filter(node => node.path && !node.path.startsWith('__'))
      .slice(0, 300)
      .map(node => node.path);
    if (!paths.length) return undefined;
    const startedAt = performance.now();
    window.electronAPI.inspectItems(paths)
      .then(result => {
        recordPerfEvent('ipc.inspect-items', performance.now() - startedAt, { count: paths.length });
        if (cancelled) return;
        setMetadataByPath(current => ({ ...current, ...(result || {}) }));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [previewSource?.path, previewSource?.children, viewOptions.sortBy, viewOptions.dateFilter]);

  useEffect(() => {
    let cancelled = false;
    if (!focusedPath || !window.electronAPI?.inspectItem || focusedPath.startsWith('__')) {
      setItemDetails(null);
      setDetailsLoading(false);
      return undefined;
    }

    setDetailsLoading(true);
    const startedAt = performance.now();
    const detailTimer = window.setTimeout(() => {
      window.electronAPI.inspectItem(focusedPath)
      .then(result => {
        recordPerfEvent('ipc.inspect-item', performance.now() - startedAt, { path: focusedPath });
        if (!cancelled) setItemDetails(result?.metadata || null);
      })
      .catch(() => {
        if (!cancelled) setItemDetails(null);
      })
        .finally(() => {
          if (!cancelled) setDetailsLoading(false);
        });
    }, 90);

    return () => {
      cancelled = true;
      window.clearTimeout(detailTimer);
    };
  }, [focusedPath]);

  useEffect(() => {
    const breadcrumb = breadcrumbRef.current;
    const measure = breadcrumbMeasureRef.current;
    if (!breadcrumb || !measure) return undefined;
    const update = () => {
      const overflowing = measure.getBoundingClientRect().width > breadcrumb.clientWidth;
      const shouldCompact = overflowing && navStack.length > 3;
      setBreadcrumbsCompact(previous => previous === shouldCompact ? previous : shouldCompact);
      if (!overflowing) setBreadcrumbsMenuOpen(false);
    };
    const observer = new ResizeObserver(update);
    observer.observe(breadcrumb);
    update();
    return () => observer.disconnect();
  }, [navStack.length, detailsOpen]);

  useEffect(() => {
    const move = event => {
      const drag = terminalDragRef.current;
      if (!drag) return;
      const nextLeft = drag.left + event.clientX - drag.startX;
      const nextTop = drag.top + event.clientY - drag.startY;
      const maxLeft = Math.max(0, drag.bounds.width - drag.drawerWidth);
      const maxTop = Math.max(0, drag.bounds.height - drag.drawerHeight);
      setTerminalFrame({
        left: Math.max(0, Math.min(maxLeft, nextLeft)),
        top: Math.max(0, Math.min(maxTop, nextTop))
      });
    };
    const stop = () => { terminalDragRef.current = null; };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
    };
  }, []);

  useEffect(() => {
    folderWatchTreeRef.current = scannedTree;
    folderWatchTargetRef.current = currentViewNode;
  }, [currentViewNode, scannedTree]);

  const reconcileFolderWatchChange = useCallback(async payload => {
    const targetNode = folderWatchTargetRef.current;
    const tree = folderWatchTreeRef.current;
    if (!payload || !targetNode?.path || targetNode.type !== 'directory' || !tree) return;
    if (payload.rootPath !== targetNode.path || folderWatchGenerationRef.current === 0) return;
    if (folderWatchBusyRef.current) {
      folderWatchQueuedRef.current = payload;
      return;
    }

    const rootPath = targetNode.path;
    if (payload.rootRenamedTo && payload.rootMissing) {
      const renamedRoot = pathResolveForRenderer(payload.rootRenamedTo);
      if (renamedRoot && renamedRoot !== rootPath && !renamedRoot.startsWith('__')) {
        const renamedTree = remapTreePathPrefix(tree, rootPath, renamedRoot);
        folderWatchTreeRef.current = renamedTree;
        setScannedTree(renamedTree);
        setNavStack(previous => previous.map(node => {
          const remappedPath = node?.path === rootPath
            ? renamedRoot
            : node?.path?.startsWith(`${rootPath}/`)
              ? `${renamedRoot}${node.path.slice(rootPath.length)}`
              : node?.path;
          return remappedPath ? (resolveByPath(renamedTree, remappedPath) || { ...node, path: remappedPath }) : node;
        }));
        setFocusedNode(previous => {
          if (!previous?.path) return previous;
          const remappedPath = previous.path === rootPath
            ? renamedRoot
            : previous.path.startsWith(`${rootPath}/`) ? `${renamedRoot}${previous.path.slice(rootPath.length)}` : previous.path;
          return resolveByPath(renamedTree, remappedPath) || { ...previous, path: remappedPath };
        });
        setHoveredNode(previous => previous?.path ? resolveByPath(renamedTree, previous.path === rootPath ? renamedRoot : previous.path.startsWith(`${rootPath}/`) ? `${renamedRoot}${previous.path.slice(rootPath.length)}` : previous.path) || null : previous);
        setPointerNode(previous => previous?.path ? resolveByPath(renamedTree, previous.path === rootPath ? renamedRoot : previous.path.startsWith(`${rootPath}/`) ? `${renamedRoot}${previous.path.slice(rootPath.length)}` : previous.path) || null : previous);
        setHighlightedPath(previous => previous === rootPath ? renamedRoot : previous?.startsWith(`${rootPath}/`) ? `${renamedRoot}${previous.slice(rootPath.length)}` : previous);
        setTreeSelectionPath(previous => previous === rootPath ? renamedRoot : previous?.startsWith(`${rootPath}/`) ? `${renamedRoot}${previous.slice(rootPath.length)}` : previous);
        setFolderWatchState(previous => ({ ...previous, active: true, updating: false, rootPath: renamedRoot, error: null, lastChangedAt: payload.observedAt || Date.now() }));
        recordPerfInstant('folder-watch.rename-recovered', { from: rootPath, to: renamedRoot });
        return;
      }
    }
    const knownDirectoryForPath = changedPath => {
      // Always reconcile from the event's parent. A renamed/deleted directory
      // may still exist in the old tree, but its former filesystem path no
      // longer exists and cannot be passed to scanSubdir.
      let candidatePath = changedPath === rootPath ? rootPath : pathDirname(changedPath);
      while (candidatePath && isWithinPath(candidatePath, rootPath)) {
        const knownNode = resolveByPath(tree, candidatePath);
        if (knownNode?.type === 'directory') return candidatePath;
        if (candidatePath === rootPath) break;
        const parentPath = pathDirname(candidatePath);
        if (parentPath === candidatePath) break;
        candidatePath = parentPath;
      }
      return rootPath;
    };
    const targetPaths = payload.fullScan
      ? [rootPath]
      : [...new Set((payload.changedPaths || [])
        .filter(changedPath => typeof changedPath === 'string' && isWithinPath(changedPath, rootPath))
        .map(knownDirectoryForPath))].slice(0, 4);
    if (!targetPaths.length) return;

    folderWatchBusyRef.current = true;
    if (folderWatchUpdatingTimerRef.current) window.clearTimeout(folderWatchUpdatingTimerRef.current);
    folderWatchUpdatingTimerRef.current = window.setTimeout(() => {
      folderWatchUpdatingTimerRef.current = null;
      if (folderWatchBusyRef.current && folderWatchTargetRef.current?.path === rootPath) {
        setFolderWatchState(previous => ({ ...previous, updating: true }));
      }
    }, 160);
    recordPerfInstant('folder-watch.reconcile-start', {
      rootPath,
      targetCount: targetPaths.length,
      fullScan: Boolean(payload.fullScan),
      changedCount: Array.isArray(payload.changedPaths) ? payload.changedPaths.length : 0,
      truncated: Boolean(payload.truncated),
      rootMissing: Boolean(payload.rootMissing)
    });
    setFolderWatchState(previous => ({ ...previous, lastChangedAt: payload.observedAt || Date.now() }));
    try {
      let nextTree = folderWatchTreeRef.current;
      for (const targetPath of targetPaths) {
        const result = await window.electronAPI.scanSubdir(targetPath);
        if (!result?.tree) throw new Error(result?.error || 'Folder reconciliation returned no tree');
        const updated = replaceNodeWithDelta(nextTree, targetPath, result.tree);
        if (updated) nextTree = updated;
      }
      if (folderWatchGenerationRef.current === 0
        || folderWatchTargetRef.current?.path !== rootPath
        || folderWatchTreeRef.current !== tree) return;
      folderWatchTreeRef.current = nextTree;
      setScannedTree(nextTree);
      setNavStack(previous => previous.map(node => {
        const updated = resolveByPath(nextTree, node.path);
        return updated || node;
      }));
      setFocusedNode(previous => previous?.path
        ? resolveByPath(nextTree, previous.path) || (isWithinPath(previous.path, rootPath) ? null : previous)
        : previous);
      setHoveredNode(previous => previous?.path ? resolveByPath(nextTree, previous.path) || null : previous);
      setPointerNode(previous => previous?.path ? resolveByPath(nextTree, previous.path) || null : previous);
      setHighlightedPath(previous => previous && isWithinPath(previous, rootPath) && !resolveByPath(nextTree, previous) ? null : previous);
      recordPerfInstant('folder-watch.reconcile-complete', { rootPath, targetCount: targetPaths.length });
      setFolderWatchState(previous => ({ ...previous, updating: false, error: null }));
    } catch (error) {
      recordPerfInstant('folder-watch.reconcile-error', { rootPath, message: error.message || 'Folder update failed' });
      if (folderWatchTargetRef.current?.path === rootPath && folderWatchTreeRef.current === tree) {
        setFolderWatchState(previous => ({ ...previous, updating: false, error: error.message || 'Folder update failed' }));
      }
    } finally {
      if (folderWatchUpdatingTimerRef.current) {
        window.clearTimeout(folderWatchUpdatingTimerRef.current);
        folderWatchUpdatingTimerRef.current = null;
      }
      if (folderWatchTargetRef.current?.path === rootPath) {
        setFolderWatchState(previous => ({ ...previous, updating: false }));
      }
      folderWatchBusyRef.current = false;
      const queued = folderWatchQueuedRef.current;
      folderWatchQueuedRef.current = null;
      if (queued && folderWatchGenerationRef.current !== 0
        && folderWatchTargetRef.current?.path === rootPath) {
        window.setTimeout(() => { void reconcileFolderWatchChange(queued); }, 0);
      }
    }
  }, []);

  useEffect(() => {
    const api = window.electronAPI;
    const watchPath = viewState === 'scan'
      && !loading
      && currentViewNode?.type === 'directory'
      && currentViewNode.path
      && !currentViewNode.path.startsWith('__')
      ? currentViewNode.path
      : null;
    const generation = folderWatchGenerationRef.current + 1;
    folderWatchGenerationRef.current = generation;
    folderWatchQueuedRef.current = null;
    folderWatchBusyRef.current = false;
    if (folderWatchUpdatingTimerRef.current) {
      window.clearTimeout(folderWatchUpdatingTimerRef.current);
      folderWatchUpdatingTimerRef.current = null;
    }

    if (!api?.watchCurrentFolder || !api?.onFolderWatchChange || !watchPath) {
      setFolderWatchState(previous => ({ ...previous, active: false, updating: false, rootPath: null, error: null }));
      if (api?.stopCurrentFolderWatcher) void api.stopCurrentFolderWatcher();
      return undefined;
    }

    const isCurrentGeneration = () => folderWatchGenerationRef.current === generation;
    const removeStatus = api.onFolderWatchStatus?.(status => {
      if (!isCurrentGeneration()) return;
      recordPerfInstant('folder-watch.status', {
        active: Boolean(status?.active),
        rootPath: status?.rootPath || watchPath,
        reason: status?.reason || null,
        error: status?.error || null
      });
      setFolderWatchState(previous => ({
        ...previous,
        active: Boolean(status?.active),
        rootPath: status?.rootPath || watchPath,
        error: status?.error || (status?.disabled ? 'Watcher disabled for protected or storage root' : null)
      }));
    });
    const removeChange = api.onFolderWatchChange(payload => {
      if (!isCurrentGeneration()) return;
      recordPerfInstant('folder-watch.event', {
        rootPath: payload?.rootPath || watchPath,
        changedCount: Array.isArray(payload?.changedPaths) ? payload.changedPaths.length : 0,
        fullScan: Boolean(payload?.fullScan),
        truncated: Boolean(payload?.truncated),
        rootMissing: Boolean(payload?.rootMissing),
        rootChanged: Boolean(payload?.rootChanged)
      });
      void reconcileFolderWatchChange(payload);
    });
    setFolderWatchState(previous => ({ ...previous, rootPath: watchPath, error: null }));
    void api.watchCurrentFolder(watchPath).then(result => {
      if (!isCurrentGeneration()) return;
      setFolderWatchState(previous => ({
        ...previous,
        active: Boolean(result?.active),
        rootPath: result?.rootPath || watchPath,
        error: result?.error || null
      }));
    }).catch(error => {
      if (isCurrentGeneration()) setFolderWatchState(previous => ({ ...previous, active: false, error: error.message || 'Watcher could not start' }));
    });

    return () => {
      folderWatchGenerationRef.current += 1;
      folderWatchQueuedRef.current = null;
      folderWatchBusyRef.current = false;
      if (folderWatchUpdatingTimerRef.current) {
        window.clearTimeout(folderWatchUpdatingTimerRef.current);
        folderWatchUpdatingTimerRef.current = null;
      }
      removeStatus?.();
      removeChange?.();
      if (api.stopCurrentFolderWatcher) void api.stopCurrentFolderWatcher();
    };
  }, [currentViewNode?.path, currentViewNode?.type, loading, reconcileFolderWatchChange, viewState]);

  // Close context menu on outside click
  useEffect(() => {
    const handler = () => {
      setContextMenu(null);
      setContextOpenWith(null);
      setDriveMenuKey(null);
      setBreadcrumbsMenuOpen(false);
      setViewOptionsOpen(false);
      setThemesOpen(false);
      setSmartCleanMenuOpen(false);
    };
    window.addEventListener('click', handler);
    return () => window.removeEventListener('click', handler);
  }, []);

  // Keep the latest in-memory tree in the per-drive cache. The cache lives for
  // the current app session, so returning to the drive can show it immediately.
  useEffect(() => {
    const driveKey = getDriveKey(currentDrive);
    if (!driveKey || !scannedTree) return;
    setScanCache(current => current[driveKey]?.tree === scannedTree
      ? current
      : { ...current, [driveKey]: { tree: scannedTree, scannedAt: Date.now() } });
  }, [currentDrive, scannedTree]);

  // Listen for main process messages
  useEffect(() => {
    if (!window.electronAPI) return;
    window.electronAPI.onAddToCollectorRequest?.(item => {
      void collectItem(item);
    });
    window.electronAPI.onScanProgress?.(prog => {
      setScanProgress(prev => ({ ...prev, ...prog }));
    });
    const removeAskSiriStart = window.electronAPI.onAskSiriStart?.(({ item } = {}) => {
      setAssistantItem(item || null);
      setAssistantResult(null);
      setAssistantTransformMode(null);
      setAssistantTransformError(null);
      setAssistantLoading(true);
      setAssistantOpen(true);
    });
    const removeAskSiriResult = window.electronAPI.onAskSiriResult?.(payload => {
      setAssistantLoading(false);
      setAssistantTransformMode(null);
      setAssistantTransformError(null);
      setAssistantResult(payload || { ok: false, error: 'No result returned.' });
      setAssistantOpen(true);
    });
    const removeQuickLookKey = window.electronAPI.onQuickLookKey?.(payload => {
      const key = payload?.key;
      recordPerfInstant('quick-look.helper-key', {
        key: key || null,
        path: payload?.path || quickLookPathRef.current || null,
        quickLookPath: quickLookPathRef.current || null,
        focusedPath: arrowStateRef.current.focusedNode?.path || null,
        pointerPath: arrowStateRef.current.pointerNode?.path || null,
        keyboardPriority: Boolean(keyboardNavigationRef.current || quickLookKeyboardPriorityRef.current)
      });
      if (key === 'closed') {
        if (!payload?.path || quickLookPathRef.current === payload.path) {
          quickLookPathRef.current = null;
          quickLookNodeRef.current = null;
          quickLookKeyboardPriorityRef.current = false;
        }
        return;
      }
      if (key !== ' ' && !ARROW_KEYS.has(key)) return;
      window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    });
    window.electronAPI.onScanComplete?.(payload => {
      setScanNotice(payload);
      window.setTimeout(() => setScanNotice(null), 5200);
      try {
        const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
        if (AudioContextCtor) {
          const audioContext = new AudioContextCtor();
          const oscillator = audioContext.createOscillator();
          const gain = audioContext.createGain();
          oscillator.type = 'sine';
          oscillator.frequency.value = 880;
          gain.gain.setValueAtTime(0.0001, audioContext.currentTime);
          gain.gain.exponentialRampToValueAtTime(0.08, audioContext.currentTime + 0.015);
          gain.gain.exponentialRampToValueAtTime(0.0001, audioContext.currentTime + 0.22);
          oscillator.connect(gain).connect(audioContext.destination);
          oscillator.start();
          oscillator.stop(audioContext.currentTime + 0.24);
          oscillator.addEventListener('ended', () => { void audioContext.close(); }, { once: true });
        }
      } catch {}
    });
    const removeUpdateProgress = window.electronAPI.onUpdateProgress?.(payload => {
      setUpdateActivity(payload);
      if (payload?.phase === 'done' || payload?.phase === 'error') {
        window.setTimeout(() => setUpdateActivity(current => (current === payload ? null : current)), 9000);
      }
    });
    return () => {
      removeAskSiriStart?.();
      removeAskSiriResult?.();
      removeQuickLookKey?.();
      removeUpdateProgress?.();
    };
  }, [collectItem]);
  // The main process reports filesystem-walk completion before the renderer has
  // committed the returned tree. Defer the native notification until the final
  // tree is visible, so its sound cannot precede the actual 100% UI state.
  useEffect(() => {
    if (loading || !scannedTree || !pendingScanCompletionRef.current || !window.electronAPI?.notifyScanComplete) return undefined;
    const payload = pendingScanCompletionRef.current;
    pendingScanCompletionRef.current = null;
    const timer = window.setTimeout(() => {
      void window.electronAPI.notifyScanComplete(payload.scanPath, payload.itemCount).catch(() => {});
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loading, scannedTree]);

  const completeOnboarding = () => {
    setOnboardingOpen(false);
    try { window.localStorage.setItem(ONBOARDING_STORAGE_KEY, APP_VERSION); } catch {}
  };



  const handleSetupAskSiri = useCallback(async () => {
    try {
      const result = await window.electronAPI?.setupAskSiri?.();
      if (result?.exists) setAskSiriSetupStatus('Already set up — “Sunburst Disk — Ask Siri” is available.');
      else if (result?.opened) setAskSiriSetupStatus('Shortcuts opened — create or import “Sunburst Disk — Ask Siri”, then return here.');
      else setAskSiriSetupStatus(result?.error || 'Ask Siri setup could not be opened.');
    } catch (error) {
      setAskSiriSetupStatus(error?.message || 'Ask Siri setup could not be opened.');
    }
  }, []);

  const handleSaveShortcutGuide = useCallback(async () => {
    try {
      const result = await window.electronAPI?.saveTextFile?.('Sunburst-Disk-Ask-Siri-Shortcut-Guide.txt', shortcutGuideText);
      if (result?.ok) setAskSiriSetupStatus(`TXT guide saved to ${result.filePath || 'your selected location'}.`);
      else if (result?.canceled) setAskSiriSetupStatus('TXT guide save canceled.');
      else setAskSiriSetupStatus(result?.error || 'TXT guide could not be saved.');
    } catch (error) {
      setAskSiriSetupStatus(error?.message || 'TXT guide could not be saved.');
    }
  }, []);
  const fetchDrives = async () => {
    try {
      if (window.electronAPI) {
        const data = await window.electronAPI.getDrives();
        if (data?.drives?.length > 0) {
          const startupDrive = data.drives.find(item => item.isStartup) || data.drives[0];
          const snapshotPath = startupDrive?.scanPath || startupDrive?.mount;
          if (snapshotPath && window.electronAPI.getCapacitySnapshot) {
            void window.electronAPI.getCapacitySnapshot(snapshotPath).then(snapshot => {
              const syncedDrive = syncDriveCapacityFromSnapshot(startupDrive, snapshot);
              setDrives(current => current.map(item => getDriveKey(item) === getDriveKey(startupDrive) ? syncedDrive : item));
              setCurrentDrive(current => current && getDriveKey(current) === getDriveKey(startupDrive) ? syncedDrive : current);
              recordCapacitySnapshot('home-load', snapshot, {
                currentDriveFreeBytes: syncedDrive.free,
                currentDriveUsedBytes: syncedDrive.used,
                currentDriveTotalBytes: syncedDrive.total,
                displayedFreeBytes: syncedDrive.free,
                displayedUsedBytes: syncedDrive.used,
                displayedTotalBytes: syncedDrive.total
              });
            }).catch(() => {});
          }
          setDrives(current => {
            const nativeKeys = new Set(data.drives.map(item => getDriveKey(item)));
            const savedFolders = current.filter(item => item.isCustomFolder && !nativeKeys.has(getDriveKey(item)));
            return [...data.drives, ...savedFolders];
          });
        }
      }
    } catch (e) { console.error('Drive fetch error:', e); }
  };

  const handleCapacityCaptureStart = useCallback(() => {
    const drive = currentDrive || drives.find(item => item.isStartup) || drives[0];
    const targetPath = drive?.scanPath || drive?.mount;
    if (!targetPath || !window.electronAPI?.getCapacitySnapshot) return;
    void window.electronAPI.getCapacitySnapshot(targetPath).then(snapshot => {
      const syncedDrive = syncDriveCapacityFromSnapshot(drive, snapshot);
      recordCapacitySnapshot('capture-start', snapshot, {
        currentDriveFreeBytes: syncedDrive.free,
        currentDriveUsedBytes: syncedDrive.used,
        currentDriveTotalBytes: syncedDrive.total,
        currentTotalSizeBytes: scannedTree?.size,
        displayedFreeBytes: syncedDrive.free,
        displayedUsedBytes: syncedDrive.used,
        displayedTotalBytes: syncedDrive.total
      }, {
        rootPath: targetPath,
        indexedTreeBytes: scannedTree?.size,
        indexedObjectCount: scannedTree?.itemCount,
        source: scannedTree ? 'cache-or-current' : 'fresh'
      });
    }).catch(() => {});
  }, [currentDrive, drives, scannedTree]);

  const handleScanDrive = async (drive) => {
    const requestId = `scan-${Date.now()}-${++scanRequestSequenceRef.current}`;
    activeScanRequestRef.current = requestId;
    setDriveMenuKey(null);
    setScanError(null);
    setScanNotice(null);
    pendingScanCompletionRef.current = null;
    setHistoryBack([]);
    setHistoryForward([]);
    setCurrentDrive(drive);
    setScannedTree(null);
    setNavStack([]);
    setFocusedNode(null);
    setTreeSelectionPath(null);
    setItemDetails(null);
    setMetadataByPath({});
    setPackageContentsShown({});
    setHoveredNode(null);
    setPointerNode(null);
    setHighlightedPath(null);
    setNodeLoading(false);
    setLoading(true);
    setViewState('scan');
    setScanProgress({ percent: -1, currentDir: 'Preparing…', itemsScanned: 0 });
    const scanPath = drive.scanPath || drive.mount;
    if (window.electronAPI?.getCapacitySnapshot) {
      void window.electronAPI.getCapacitySnapshot(scanPath).then(snapshot => {
        const syncedDrive = syncDriveCapacityFromSnapshot(drive, snapshot);
        setDrives(current => current.map(item => getDriveKey(item) === getDriveKey(drive) ? syncedDrive : item));
        setCurrentDrive(current => current && getDriveKey(current) === getDriveKey(drive) ? syncedDrive : current);
        recordCapacitySnapshot('scan-start', snapshot, {
          currentDriveFreeBytes: syncedDrive.free,
          currentDriveUsedBytes: syncedDrive.used,
          currentDriveTotalBytes: syncedDrive.total,
          displayedFreeBytes: syncedDrive.free,
          displayedUsedBytes: syncedDrive.used,
          displayedTotalBytes: syncedDrive.total
        }, { rootPath: scanPath, source: 'fresh' });
      }).catch(() => {});
    }

    try {
      if (window.electronAPI) {
        // Accurate full scan — sizes are always fully computed by the main
        // process; detail (children) is returned for the first 10 levels and
        // lazy-loaded beyond that. No timeout, no mock fallback.
        const scanStartedAt = performance.now();
        const data = await window.electronAPI.scanDirectory(scanPath, 10, requestId);
        if (activeScanRequestRef.current !== requestId) return;
        recordPerfEvent('ipc.scan-directory', performance.now() - scanStartedAt, { path: scanPath, requestId });
        if (data?.canceled) {
          setLoading(false);
          setViewState('drives');
          return;
        }
        if (data?.tree) {
          data.tree.name = drive.name;
          if (window.electronAPI?.getCapacitySnapshot) {
      void window.electronAPI.getCapacitySnapshot(scanPath).then(snapshot => {
        const syncedDrive = syncDriveCapacityFromSnapshot(drive, snapshot);
        setDrives(current => current.map(item => getDriveKey(item) === getDriveKey(drive) ? syncedDrive : item));
        setCurrentDrive(current => current && getDriveKey(current) === getDriveKey(drive) ? syncedDrive : current);
        recordCapacitySnapshot('scan-complete', snapshot, {
          currentDriveFreeBytes: syncedDrive.free,
          currentDriveUsedBytes: syncedDrive.used,
          currentDriveTotalBytes: syncedDrive.total,
          currentTotalSizeBytes: data.tree.size,
          displayedFreeBytes: syncedDrive.free,
          displayedUsedBytes: syncedDrive.used,
          displayedTotalBytes: syncedDrive.total
        }, {
                rootPath: scanPath,
                indexedTreeBytes: data.tree.size,
                indexedObjectCount: data.tree.itemCount,
                source: 'fresh'
              });
            }).catch(() => {});
          }

          if (drive.isCustomFolder) {
            setScanCache(current => ({ ...current, [getDriveKey(drive)]: { tree: data.tree, scannedAt: Date.now() } }));
            setDrives(current => {
              const nextDrive = { ...drive, filesystem: scanPath, mount: scanPath, scanPath, isCustomFolder: true, scannedAt: Date.now() };
              const existingIndex = current.findIndex(item => getDriveKey(item) === getDriveKey(nextDrive));
              if (existingIndex < 0) return [...current, nextDrive];
              const next = [...current];
              next[existingIndex] = { ...next[existingIndex], ...nextDrive };
              return next;
            });
          }
          setScannedTree(data.tree);
          setNavStack([data.tree]);
          setFocusedNode(data.tree);
          setItemDetails(null);
          setScanProgress({
            percent: 100,
            currentDir: 'Complete',
            itemsScanned: data.tree.itemCount || 0
          });
          pendingScanCompletionRef.current = {
            scanPath,
            itemCount: data.tree.itemCount || 0
          };
          setLoading(false);
          return;
        }
        throw new Error(data?.error || 'Scan returned no tree');
      }
      // No Electron API (browser dev mode): nothing truthful to show.
      setLoading(false);
      setViewState('drives');
    } catch (e) {
      if (activeScanRequestRef.current !== requestId) return;
      console.error('Scan error:', e);
      setLoading(false);
      setScanError(e.message || 'The scan could not be completed');
    } finally {
      if (activeScanRequestRef.current === requestId) activeScanRequestRef.current = null;
    }
  };

  const cancelActiveScan = async () => {
    const requestId = activeScanRequestRef.current;
    if (!requestId) return;
    activeScanRequestRef.current = null;
    pendingScanCompletionRef.current = null;
    try {
      await window.electronAPI?.cancelScan?.(requestId);
    } catch {}
    setLoading(false);
    setNodeLoading(false);
    setScanError(null);
    setScanNotice(null);
    setScannedTree(null);
    setNavStack([]);
    setCurrentDrive(null);
    setFocusedNode(null);
    setTreeSelectionPath(null);
    setItemDetails(null);
    setMetadataByPath({});
    setHoveredNode(null);
    setPointerNode(null);
    setHighlightedPath(null);
    setViewState('drives');
  };

  const closeSavedFolder = drive => {
    if (!drive?.isCustomFolder) return;
    const driveKey = getDriveKey(drive);
    setDriveMenuKey(null);
    setDrives(current => current.filter(item => getDriveKey(item) !== driveKey));
    setScanCache(current => {
      const next = { ...current };
      delete next[driveKey];
      return next;
    });
  };

  const openSmartClean = async (scope = 'storage') => {
    if (!window.electronAPI?.smartCleanPreview) {
      alert('Smart Clean preview is available in the Electron app only.');
      return;
    }
    const folderPath = currentViewNode?.type === 'directory' && currentViewNode.path && !currentViewNode.path.startsWith('__')
      ? currentViewNode.path
      : null;
    const storagePath = currentDrive?.scanPath || currentDrive?.mount || null;
    if (scope === 'folder' && !folderPath) {
      alert('Current Folder Smart Clean requires an analyzed folder.');
      return;
    }
    setSmartCleanMenuOpen(false);
    setViewOptionsOpen(false);
    setThemesOpen(false);
    setSmartCleanScope(scope);
    setSmartCleanRiskFilter('all');
    setSmartCleanCategoryFilters(new Set());
    setSmartCleanOpen(true);
    setSmartCleanLoading(true);
    setSmartCleanData(null);
    setSmartCleanSelected(new Set());
    try {
      const result = await window.electronAPI.smartCleanPreview(
        scope,
        scope === 'folder' ? { folderPath } : { storagePath }
      );
      if (!result?.ok) throw new Error(result?.error || 'Smart Clean preview could not be created');
      const normalizedCandidates = (result.candidates || []).map(candidate => ({
        ...candidate,
        risk: normalizeSmartCleanRiskValue(candidate.risk)
      }));
      recordPerfInstant('smart-clean.preview-response', {
        scope,
        scopePath: result.scopePath || null,
        rawCandidateCount: (result.candidates || []).length,
        ...buildSmartCleanTelemetry(result.candidates || [], 'all', new Set())
      });
      setSmartCleanData({ ...result, candidates: normalizedCandidates });
    } catch (error) {
      setSmartCleanData({ ok: false, error: error.message, candidates: [], roots: [] });
    } finally {
      setSmartCleanLoading(false);
    }
  };

  const toggleSmartCleanCandidate = (candidatePath) => {
    setSmartCleanSelected(previous => {
      const next = new Set(previous);
      if (next.has(candidatePath)) next.delete(candidatePath);
      else next.add(candidatePath);
      return next;
    });
  };

  const exportSmartCleanSelection = async () => {
    if (!smartCleanData?.candidates?.length || smartCleanSelected.size === 0) return;
    const selected = smartCleanData.candidates.filter(candidate => smartCleanSelected.has(candidate.path));
    for (const candidate of selected) await collectItem(candidate);
    setSmartCleanSelected(new Set());
    setSmartCleanOpen(false);
    setCollectorExpanded(true);
  };

  const smartCleanCandidates = useMemo(() => smartCleanData?.candidates || [], [smartCleanData]);
  const smartCleanRiskCounts = smartCleanCandidates.reduce((counts, candidate) => {
    const risk = normalizeSmartCleanRiskValue(candidate.risk);
    return { ...counts, [risk]: (counts[risk] || 0) + 1 };
  }, { safe: 0, review: 0, high: 0 });
  const smartCleanVisibleCandidates = smartCleanCandidates
    .filter(candidate => {
      const riskMatches = smartCleanRiskFilter === 'all' || normalizeSmartCleanRiskValue(candidate.risk) === smartCleanRiskFilter;
      const categoryMatches = smartCleanCategoryFilters.size === 0 || smartCleanCategoryFilters.has(candidate.categoryId);
      return riskMatches && categoryMatches;
    })
    .sort((a, b) => (Number(b.size) || 0) - (Number(a.size) || 0));
  const smartCleanSelectedItems = smartCleanCandidates.filter(candidate => smartCleanSelected.has(candidate.path));
  const smartCleanSelectedSize = smartCleanSelectedItems.reduce((sum, candidate) => sum + (Number(candidate.size) || 0), 0);

  useEffect(() => {
    if (!smartCleanOpen || smartCleanLoading || !smartCleanData) return;
    recordPerfInstant('smart-clean.render-snapshot', buildSmartCleanTelemetry(smartCleanCandidates, smartCleanRiskFilter, smartCleanCategoryFilters));
  }, [smartCleanCategoryFilters, smartCleanCandidates, smartCleanData, smartCleanLoading, smartCleanOpen, smartCleanRiskFilter, smartCleanVisibleCandidates.length]);

  const handleScanFolder = async () => {
    if (!window.electronAPI?.chooseFolder) {
      alert('Folder selection is available in the Electron app only.');
      return;
    }
    const result = await window.electronAPI.chooseFolder();
    if (result?.cancelled) return;
    if (!result?.folder) {
      alert(result?.error || 'A folder could not be selected.');
      return;
    }
    await handleScanDrive(result.folder);
  };

  const handleViewDrive = (drive) => {
    const cached = scanCache[getDriveKey(drive)]?.tree;
    if (!cached) {
      handleScanDrive(drive);
      return;
    }

    setDriveMenuKey(null);
    setScanError(null);
    setHistoryBack([]);
    setHistoryForward([]);
    setCurrentDrive(drive);
    setScannedTree(cached);
    setNavStack([cached]);
    setFocusedNode(cached);
    setTreeSelectionPath(null);
    setItemDetails(null);
    setHoveredNode(null);
    setHighlightedPath(null);
    setLoading(false);
    setViewState('scan');
  };

  // Deep-update a node in the tree by path, replacing it with updatedNode
  function updateNodeInTree(tree, targetPath, updatedNode) {
    if (tree.path === targetPath) return updatedNode;
    if (!tree.children || tree.children.length === 0) return tree;
    return {
      ...tree,
      children: tree.children.map(child => updateNodeInTree(child, targetPath, updatedNode))
    };
  }

  // Lazy-enrich a node with its real children (triggered by the chart when an
  // empty frontier directory becomes visible). Updates the master tree so
  // hover previews and the sidebar have live contents to broadcast.
  const enrichNode = useCallback(async (node) => {
    if (!window.electronAPI?.scanSubdir || !node?.path || node.path.startsWith('__')) return;
    if (isPackageContainerNode(node) && !packageContentsShown[node.path]) return;
    try {
      const scanStartedAt = performance.now();
      const result = await window.electronAPI.scanSubdir(node.path);
      recordPerfEvent('ipc.scan-subdir', performance.now() - scanStartedAt, { path: node.path });
      if (!result?.tree?.children || result.tree.children.length === 0) return;
      const enriched = {
        ...node,
        children: result.tree.children,
        size: result.tree.size ?? node.size,
        itemCount: Number.isFinite(result.tree.itemCount) ? result.tree.itemCount : result.tree.children.length
      };
      dbg('enriched', {
        path: node.path,
        gotChildren: result.tree.children.length,
        gotSize: result.tree.size,
        prevSize: node.size,
        prevChildren: node.children?.length ?? 0
      });
      setScannedTree(prev => prev ? updateNodeInTree(prev, node.path, enriched) : prev);
      setNavStack(prev => prev.map(n => {
        if (n.path === node.path) return enriched;
        if (n.children?.some(c => c.path === node.path)) {
          return { ...n, children: n.children.map(c => c.path === node.path ? enriched : c) };
        }
        return n;
      }));
    } catch (e) { console.error('Enrich error:', e); }
  }, [packageContentsShown]);

  const commitNavigation = (nextStack, { recordHistory = true } = {}) => {
    if (!nextStack.length) return;
    const currentPath = navStack[navStack.length - 1]?.path;
    const nextPath = nextStack[nextStack.length - 1]?.path;
    if (currentPath === nextPath) return;
    recordPerfInstant('navigation.change', { from: currentPath || null, to: nextPath || null });

    if (recordHistory && navStack.length > 0) {
      setHistoryBack(previous => [...previous, navStack]);
      setHistoryForward([]);
    }
    setNavStack(nextStack);
    setFocusedNode(nextStack[nextStack.length - 1]);
    setTreeSelectionPath(null);
    setHoveredNode(null);
    setHighlightedPath(null);
  };

  const navigateHistory = (direction) => {
    const source = direction === 'back' ? historyBack : historyForward;
    if (!source.length || !navStack.length || !scannedTree) return;

    const targetStack = source[source.length - 1]
      .map(node => resolveByPath(scannedTree, node.path))
      .filter(Boolean);
    if (!targetStack.length) return;

    if (direction === 'back') {
      setHistoryBack(previous => previous.slice(0, -1));
      setHistoryForward(previous => [...previous, navStack]);
    } else {
      setHistoryForward(previous => previous.slice(0, -1));
      setHistoryBack(previous => [...previous, navStack]);
    }
    commitNavigation(targetStack, { recordHistory: false });
  };

  const openHiddenSpace = useCallback(async (node, { bypassAuth = false } = {}) => {
    if (!window.electronAPI?.scanHiddenSpace) {
      alert('Hidden Space access is available in the Electron app only.');
      return;
    }
    if (!hiddenSpaceAdminAuthorized && !bypassAuth) {
      hiddenSpacePendingNodeRef.current = node;
      setHiddenSpaceAdminError(null);
      setHiddenSpaceAdminPassword('');
      setHiddenSpaceAdminPromptOpen(true);
      return;
    }
    setNodeLoading(true);
    try {
      const result = await window.electronAPI.scanHiddenSpace(node?.hiddenSpaceAggregateSize || node?.size || 0);
      if (result?.tree) {
        setScannedTree(previous => previous ? updateNodeInTree(previous, '__hidden__', result.tree) : previous);
        setNavStack(previous => {
          const hiddenIndex = previous.findIndex(current => current.path === '__hidden__');
          const prefix = hiddenIndex >= 0 ? previous.slice(0, hiddenIndex) : previous;
          return [...prefix, result.tree];
        });
        setFocusedNode(result.tree);
        setTreeSelectionPath(null);
      } else if (result?.needsAdmin) {
        setHiddenSpaceAdminAuthorized(false);
        hiddenSpacePendingNodeRef.current = node;
        setHiddenSpaceAdminError(result.error || 'Administrator authorization is required.');
        setHiddenSpaceAdminPassword('');
        setHiddenSpaceAdminPromptOpen(true);
      } else if (result?.error && !result.settingsOpened) {
        alert(result.error);
      }
    } finally {
      setNodeLoading(false);
    }
  }, [hiddenSpaceAdminAuthorized]);

  const authorizeHiddenSpace = useCallback(async () => {
    if (!window.electronAPI?.authorizeHiddenSpace || !hiddenSpaceAdminPassword) return;
    setHiddenSpaceAdminError(null);
    try {
      const result = await window.electronAPI.authorizeHiddenSpace(hiddenSpaceAdminPassword);
      setHiddenSpaceAdminPassword('');
      if (!result?.ok) {
        setHiddenSpaceAdminError(result?.error || 'Administrator authentication failed.');
        return;
      }
      setHiddenSpaceAdminAuthorized(true);
      setHiddenSpaceAdminPromptOpen(false);
      const pendingNode = hiddenSpacePendingNodeRef.current;
      hiddenSpacePendingNodeRef.current = null;
      if (pendingNode) await openHiddenSpace(pendingNode, { bypassAuth: true });
    } catch (error) {
      setHiddenSpaceAdminPassword('');
      setHiddenSpaceAdminError(error?.message || 'Administrator authentication failed.');
    }
  }, [hiddenSpaceAdminPassword, openHiddenSpace]);

  const lockHiddenSpace = useCallback(async (node) => {
    try { await window.electronAPI?.revokeHiddenSpace?.(); } catch { /* best-effort revoke */ }
    setHiddenSpaceAdminAuthorized(false);
    setHiddenSpaceAdminPromptOpen(false);
    setHiddenSpaceAdminPassword('');
    setHiddenSpaceAdminError(null);
    const rootSource = navStack.find(current => current.path === '__hidden__') || node;
    const lockedRoot = rootSource ? {
      ...rootSource,
      path: '__hidden__',
      name: 'hidden space...',
      type: 'directory',
      children: [],
      hiddenSpaceAdminUnlocked: false,
      hiddenSpaceUnlocked: false,
      hiddenSpaceUnavailable: true
    } : null;
    setScannedTree(previous => previous && lockedRoot ? updateNodeInTree(previous, '__hidden__', lockedRoot) : previous);
    setNavStack(previous => {
      const hiddenIndex = previous.findIndex(current => current.path === '__hidden__');
      if (hiddenIndex < 0) return previous;
      return [...previous.slice(0, hiddenIndex), lockedRoot];
    });
    if (lockedRoot) setFocusedNode(lockedRoot);
    setTreeSelectionPath(null);
  }, [navStack]);

  const showPackageContents = useCallback(async (node) => {
    if (!isPackageContainerNode(node)) return;
    const archive = isArchiveNode(node);
    if (archive) {
      recordPerfInstant('archive.show-start', {
        path: node.path,
        name: node.name,
        cachedChildren: archiveContentsByPath[node.path]?.length || 0,
        nodeChildren: node.children?.length || 0,
        size: Number(node.size) || 0
      });
    }
    if (archive && !window.electronAPI?.scanArchive) {
      const message = 'Archive Viewer is unavailable in this build.';
      setPackageContentsStatus(previous => ({ ...previous, [node.path]: { status: 'error', message } }));
      alert(message);
      return;
    }
    if (!archive && !window.electronAPI?.scanSubdir) return;
    setNodeLoading(true);
    setPackageContentsStatus(previous => ({ ...previous, [node.path]: { status: 'loading', message: archive ? 'Listing archive without extraction…' : 'Reading package contents…' } }));
    try {
      const result = archive
        ? await window.electronAPI.scanArchive(node.path)
        : await window.electronAPI.scanSubdir(node.path, true);
      if (!result?.tree) throw new Error(result?.error || 'Package contents could not be read');
      const archiveTree = archive ? normalizeArchiveTree(result.tree) : result.tree;
      const children = archiveTree.children || [];
      if (archive) {
        recordPerfInstant('archive.show-response', {
          path: node.path,
          rootSize: Number(archiveTree.size) || 0,
          rootItemCount: Number(archiveTree.itemCount) || 0,
          childCount: children.length,
          children: children.slice(0, 20).map(child => ({ name: child.name, path: child.path, type: child.type, size: Number(child.size) || 0, archiveVirtual: Boolean(child.archiveVirtual) }))
        });
      }
      const enriched = {
        ...node,
        children,
        size: Number.isFinite(Number(archiveTree.size)) ? Number(archiveTree.size) : node.size,
        itemCount: Number.isFinite(archiveTree.itemCount) ? archiveTree.itemCount : children.length,
        archiveContainer: archive ? true : node.archiveContainer
      };
      const nextTree = scannedTree ? updateNodeInTree(scannedTree, node.path, enriched) : enriched;
      if (archive) {
        setArchiveContentsByPath(previous => ({ ...previous, [node.path]: children }));
        recordPerfInstant('archive.cache-write', {
          path: node.path,
          childCount: children.length,
          childSizes: children.slice(0, 20).map(child => Number(child.size) || 0)
        });
      }
      setScannedTree(nextTree);
      if (archive && nextTree) {
        const archiveChain = getNodeChain(nextTree, node.path);
        if (archiveChain.length) setNavStack(archiveChain);
        else setNavStack(previous => previous.map(current => current.path === node.path ? enriched : current));
      } else {
        setNavStack(previous => previous.map(current => current.path === node.path ? enriched : current));
      }
      setFocusedNode(enriched);
      setPackageContentsShown(previous => ({ ...previous, [node.path]: true }));
      setPackageContentsStatus(previous => ({ ...previous, [node.path]: { status: 'ready', message: `${children.length.toLocaleString()} top-level entries loaded` } }));
      if (archive) recordPerfInstant('archive.show-complete', { path: node.path, childCount: children.length, firstChildSizes: children.slice(0, 20).map(child => Number(child.size) || 0) });
    } catch (error) {
      const message = error.message || 'Package contents could not be read';
      if (archive) recordPerfInstant('archive.show-error', { path: node.path, message });
      setPackageContentsStatus(previous => ({ ...previous, [node.path]: { status: 'error', message } }));
      alert(message);
    } finally {
      setNodeLoading(false);
    }
  }, [scannedTree, archiveContentsByPath]);

  const hidePackageContents = useCallback((node) => {
    if (!isPackageContainerNode(node)) return;
    if (isArchiveNode(node)) {
      setArchiveContentsByPath(previous => {
        const next = { ...previous };
        delete next[node.path];
        return next;
      });
    }
    setScannedTree(previous => {
      const liveNode = resolveByPath(previous, node.path) || node;
      return previous ? updateNodeInTree(previous, node.path, { ...liveNode, children: [], itemCount: 0 }) : previous;
    });
    setNavStack(previous => {
      const packageIndex = previous.findIndex(current => current.path === node.path);
      if (packageIndex < 0) return previous;
      return previous.slice(0, packageIndex + 1).map(current => current.path === node.path ? { ...current, children: [], itemCount: 0 } : current);
    });
    setFocusedNode(current => current?.path === node.path ? { ...current, children: [], itemCount: 0 } : current);
    setHoveredNode(current => current?.path === node.path ? null : current);
    setPackageContentsShown(previous => ({ ...previous, [node.path]: false }));
    setPackageContentsStatus(previous => ({ ...previous, [node.path]: { status: 'idle', message: 'Package contents hidden' } }));
    if (isArchiveNode(node)) recordPerfInstant('archive.hide', { path: node.path });
  }, []);

  const togglePackageContents = useCallback((node) => {
    if (!isPackageContainerNode(node)) return;
    if (packageContentsShown[node.path]) hidePackageContents(node);
    else void showPackageContents(node);
  }, [hidePackageContents, packageContentsShown, showPackageContents]);

  useEffect(() => {
    if (!window.electronAPI?.onTogglePackageContentsRequest) return undefined;
    const unsubscribe = window.electronAPI.onTogglePackageContentsRequest(item => {
      const liveNode = resolveByPath(scannedTree, item?.path) || item;
      togglePackageContents(liveNode);
    });
    return () => unsubscribe?.();
  }, [scannedTree, togglePackageContents]);

  const navigateTo = async (node, stackIndex) => {
    if (stackIndex !== undefined) {
      commitNavigation(navStack.slice(0, stackIndex + 1));
      return;
    }

    if (!node) return;
    if (node.isHiddenSpaceRemainder) {
      setFocusedNode(node);
      setTreeSelectionPath(node.path);
      return;
    }
    if (node.isHiddenSpaceChild) {
      if (node.hiddenSpaceDepth === 1 && navStack.some(current => current.path === '__hidden__')) {
        commitNavigation([...navStack, node]);
      } else {
        setFocusedNode(node);
        setTreeSelectionPath(node.path);
      }
      return;
    }
    if (node.type === 'special' || node.path === '__hidden__') {
      setFocusedNode(node);
      await openHiddenSpace(node);
      return;
    }
    const archiveChildren = isArchiveNode(node)
      ? (archiveContentsByPath[node.path] || node.children || [])
      : [];
    const canNavigateArchive = isArchiveNode(node) && packageContentsShown[node.path] && archiveChildren.length > 0;
    if (isArchiveNode(node)) {
      recordPerfInstant('archive.navigate-attempt', {
        path: node.path,
        type: node.type,
        shown: Boolean(packageContentsShown[node.path]),
        cachedChildren: archiveContentsByPath[node.path]?.length || 0,
        nodeChildren: node.children?.length || 0,
        canNavigate: canNavigateArchive
      });
    }
    if (node.type !== 'directory' && !node.archiveVirtual && !canNavigateArchive) {
      setFocusedNode(node);
      return;
    }

    if (canNavigateArchive && node.type !== 'directory') {
      const archiveNode = { ...node, children: archiveChildren, archiveContainer: true };
      const archiveChain = getNodeChain(scannedTree, node.path);
      const targetStack = archiveChain.length
        ? [...archiveChain.slice(0, -1), archiveNode]
        : [...navStack, archiveNode];
      setScannedTree(previous => previous ? updateNodeInTree(previous, node.path, archiveNode) : previous);
      if (isArchiveNode(node)) recordPerfInstant('archive.navigate-commit', { path: node.path, targetDepth: targetStack.length, childCount: archiveChildren.length, childSizes: archiveChildren.slice(0, 20).map(child => Number(child.size) || 0) });
      commitNavigation(targetStack);
      return;
    }

    // A clicked slice can be several rings below the current view. Resolve the
    // full path so center-click always has the real parent available.
    let updatedTree = scannedTree;
    let targetStack = getNodeChain(updatedTree, node.path);
    const needsLazyScan = (
      window.electronAPI?.scanSubdir &&
      node.children &&
      node.children.length === 0 &&
      node.path &&
      !node.path.startsWith('__') &&
      !node.archiveVirtual
    );

    if (needsLazyScan) {
      setNodeLoading(true);
      try {
        const result = await window.electronAPI.scanSubdir(node.path);
        if (result?.tree?.children?.length > 0) {
          const enrichedNode = {
            ...node,
            children: result.tree.children,
            size: result.tree.size ?? node.size
          };
          updatedTree = updateNodeInTree(scannedTree, node.path, enrichedNode);
          setScannedTree(updatedTree);
          targetStack = getNodeChain(updatedTree, node.path);
        }
      } catch (error) {
        console.error('Navigation scan error:', error);
      } finally {
        setNodeLoading(false);
      }
    }

    if (!targetStack.length) targetStack = [...navStack, node];
    commitNavigation(targetStack);
  };

  const navigateUp = () => {
    if (navStack.length > 1) {
      commitNavigation(navStack.slice(0, -1));
    } else {
      setViewState('drives');
    }
  };

  // ── Drag & Drop for Collector ────────────────────────────────────────────────
  const removeFromCollector = (itemPath) => {
    setCollector(c => c.filter(i => i.path !== itemPath));
  };

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    setIsDragOver(false);
    const raw = e.dataTransfer.getData('application/json');
    if (!raw) return;
    try { void collectItem(JSON.parse(raw)); } catch {}
  }, [collectItem]);

  const handleDragOver = (e) => { e.preventDefault(); setIsDragOver(true); };
  const handleDragLeave = () => setIsDragOver(false);

  const handleTerminalPathDrop = useCallback(event => {
    event.preventDefault();
    const droppedPath = pathFromDataTransfer(event.dataTransfer);
    if (!droppedPath || !droppedPath.startsWith('/') || droppedPath.startsWith('__')) return;
    setTerminalCommand(current => {
      const base = current.trim() || 'ls -lah';
      return `${base} ${quoteTerminalPath(droppedPath)}`;
    });
    setTerminalHistoryIndex(-1);
  }, []);

  const handleTerminalPathDragOver = useCallback(event => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }, []);

  const runTerminalCommand = useCallback(async () => {
    if (terminalBusy) return;
    const enteredCommand = terminalCommand.trim();
    if (!enteredCommand) return;
    if (terminalAdminMode && /^(?:rm|mv|cp -R|ln -s)\s/.test(enteredCommand)) {
      const confirmed = window.confirm(`Run this admin filesystem command?\n\n${enteredCommand}`);
      if (!confirmed) return;
    }
    setTerminalCommand('');
    setTerminalHistoryIndex(-1);
    setTerminalHistory(previous => [...previous, enteredCommand].slice(-100));
    if (enteredCommand === 'clear') {
      setTerminalOutput('');
      return;
    }
    if (!window.electronAPI?.terminalRunSafe) return;
    setTerminalBusy(true);
    const cwd = currentViewNode?.type === 'directory' && !currentViewNode.path?.startsWith('__')
      ? currentViewNode.path
      : undefined;
    try {
      const result = await window.electronAPI.terminalRunSafe(enteredCommand, cwd, terminalAdminMode);
      const header = `$ ${result?.command || terminalCommand}${result?.cwd ? `  [${result.cwd}]` : ''}`;
      const output = [result?.stdout, result?.stderr ? `stderr:\n${result.stderr}` : '', result?.error ? `error: ${result.error}` : '']
        .filter(Boolean)
        .join('\n');
      setTerminalOutput(`${header}\n${output || '(no output)'}`);
    } catch (error) {
      setTerminalOutput(`error: ${error.message}`);
    } finally {
      setTerminalBusy(false);
    }
  }, [currentViewNode, terminalAdminMode, terminalBusy, terminalCommand]);

  const handleTerminalCommandKeyDown = useCallback((event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void runTerminalCommand();
      return;
    }
    if (event.key === 'ArrowUp' && terminalHistory.length > 0) {
      event.preventDefault();
      const nextIndex = terminalHistoryIndex < 0
        ? terminalHistory.length - 1
        : Math.max(0, terminalHistoryIndex - 1);
      setTerminalHistoryIndex(nextIndex);
      setTerminalCommand(terminalHistory[nextIndex] || '');
      return;
    }
    if (event.key === 'ArrowDown' && terminalHistoryIndex >= 0) {
      event.preventDefault();
      const nextIndex = terminalHistoryIndex + 1;
      if (nextIndex >= terminalHistory.length) {
        setTerminalHistoryIndex(-1);
        setTerminalCommand('');
      } else {
        setTerminalHistoryIndex(nextIndex);
        setTerminalCommand(terminalHistory[nextIndex] || '');
      }
    }
  }, [runTerminalCommand, terminalHistory, terminalHistoryIndex]);

  const authorizeTerminalAdmin = useCallback(async () => {
    if (!window.electronAPI?.terminalAuthorizeAdmin || !terminalAdminPassword) return;
    setTerminalAdminError(null);
    const result = await window.electronAPI.terminalAuthorizeAdmin(terminalAdminPassword);
    setTerminalAdminPassword('');
    if (result?.ok) {
      setTerminalAdminMode(true);
      setTerminalAdminPromptOpen(false);
      setTerminalOutput('Administrator mode enabled for this app session.\nOnly allowlisted commands are available.');
    } else {
      setTerminalAdminError(result?.error || 'Administrator authentication failed.');
    }
  }, [terminalAdminPassword]);

  const revokeTerminalAdmin = useCallback(async () => {
    await window.electronAPI?.terminalRevokeAdmin?.();
    setTerminalAdminMode(false);
    setTerminalAdminPromptOpen(false);
    setTerminalAdminPassword('');
    setTerminalAdminError(null);
  }, []);

  const handleEjectDrive = useCallback(async drive => {
    if (!drive?.isEjectable || !window.electronAPI?.ejectDrive || ejectingDriveKey) return;
    const confirmed = window.confirm(`Eject “${drive.name}”? Make sure no files are in use.`);
    if (!confirmed) return;
    const driveKey = getDriveKey(drive);
    setEjectingDriveKey(driveKey);
    setDriveMenuKey(null);
    try {
      const result = await window.electronAPI.ejectDrive(drive.mount);
      if (result?.ok) {
        setDrives(current => current.filter(item => getDriveKey(item) !== driveKey));
        setScanNotice({ title: 'Volume ejected', body: `${drive.name} was safely ejected.` });
      } else {
        window.alert(result?.error || 'The volume could not be ejected.');
      }
    } catch (error) {
      window.alert(error.message || 'The volume could not be ejected.');
    } finally {
      setEjectingDriveKey(null);
    }
  }, [ejectingDriveKey]);

  const refreshCurrentFolder = useCallback(async () => {
    if (!window.electronAPI || !currentViewNode?.path || currentViewNode.path.startsWith('__') || refreshing) return false;
    const currentPath = currentViewNode.path;
    const scanPath = currentPath === '/System' ? (currentDrive?.scanPath || currentDrive?.mount) : currentPath;
    if (!scanPath) return false;

    setRefreshing(true);
    setNodeLoading(true);
    setScanError(null);
    try {
      const isFullDriveRefresh = scanPath === (currentDrive?.scanPath || currentDrive?.mount);
      const includePackageContents = Boolean(packageContentsShown[currentPath]);
      const refreshStartedAt = performance.now();
      const result = isFullDriveRefresh
        ? await window.electronAPI.scanDirectory(scanPath, 10)
        : await window.electronAPI.scanSubdir(scanPath, includePackageContents);
      recordPerfEvent('ipc.refresh', performance.now() - refreshStartedAt, { path: scanPath, fullDrive: isFullDriveRefresh });
      if (!result?.tree) throw new Error(result?.error || 'Refresh returned no tree');

      const refreshedTree = result.tree;
      if (isFullDriveRefresh) {
        refreshedTree.name = currentDrive?.name || refreshedTree.name;
      } else {
        refreshedTree.name = currentViewNode.name || refreshedTree.name;
      }
      const nextMasterTree = isFullDriveRefresh
        ? refreshedTree
        : updateNodeInTree(scannedTree, currentPath, refreshedTree);
      setScannedTree(nextMasterTree);
      const refreshedChain = getNodeChain(nextMasterTree, currentPath);
      setNavStack(refreshedChain.length ? refreshedChain : [nextMasterTree]);
      setFocusedNode(resolveByPath(nextMasterTree, currentPath) || refreshedTree);
      setTreeSelectionPath(null);
      setHoveredNode(null);
      setHighlightedPath(null);
      setScanError(null);
      return true;
    } catch (error) {
      setScanError(`Refresh could not be completed: ${error.message}`);
      return false;
    } finally {
      setNodeLoading(false);
      setRefreshing(false);
    }
  }, [currentDrive, currentViewNode, packageContentsShown, refreshing, scannedTree]);

  const applyOptimisticTrashRemoval = useCallback(paths => {
    const sourceTree = folderWatchTreeRef.current || scannedTree;
    const result = removePathsFromTree(sourceTree, paths);
    if (!result.changed) return result;

    const nextTree = result.tree;
    folderWatchTreeRef.current = nextTree;
    setScannedTree(nextTree);
    setNavStack(previous => previous.map(node => resolveByPath(nextTree, node.path) || node));
    setFocusedNode(previous => previous?.path ? resolveByPath(nextTree, previous.path) || null : previous);
    setHoveredNode(previous => previous?.path ? resolveByPath(nextTree, previous.path) || null : previous);
    setPointerNode(previous => previous?.path ? resolveByPath(nextTree, previous.path) || null : previous);
    setHighlightedPath(previous => previous && resolveByPath(nextTree, previous) ? previous : null);
    setTreeSelectionPath(previous => previous && resolveByPath(nextTree, previous) ? previous : null);
    recordPerfInstant('collector.optimistic-removal', {
      removedCount: result.removedCount,
      removedBytes: result.removedBytes,
      paths: paths.slice(0, 40)
    });
    return result;
  }, [scannedTree]);

  // ── Countdown & Move to Trash ───────────────────────────────────────────────
  const startPurgeCountdown = () => {
    if (!collector.length || countdown !== null) return;
    setCountdown(6);
  };

  const cancelPurge = () => {
    if (countdownTimerRef.current) {
      clearTimeout(countdownTimerRef.current);
      countdownTimerRef.current = null;
    }
    setCountdown(null);
  };

  const executePurgeAndRefresh = useCallback(async () => {
    setCountdown(null);
    const itemsToTrash = [...collector];
    if (!itemsToTrash.length) return;

    const paths = itemsToTrash.map(c => c.path);
  
    try {
      if (!window.electronAPI) {
        throw new Error('File operations require the Electron app');
      }

      const deleteResult = await window.electronAPI.deleteItems(paths);
      const results = Array.isArray(deleteResult?.results) ? deleteResult.results : [];
      if (results.length === 0) {
        throw new Error('No deletion result was returned by the Electron process');
      }
      const deletedPaths = new Set(results.filter(result => result.success).map(result => result.path));
      const failedResults = results.filter(result => !result.success);

      // Keep failed items visible and actionable; update the UI only for confirmed moves.
      setCollector(current => current.filter(item => !deletedPaths.has(item.path)));
      if (failedResults.length > 0) {
        const failedNames = failedResults.map(result => result.path).join(', ');
        alert(`Could not move ${failedResults.length} item(s) to Trash:\n${failedNames}`);
      } else {
        setCollectorExpanded(false);
      }

      // Update the cached tree immediately. The old implementation called
      // refreshCurrentFolder here; for a startup volume that is a full
      // scanDirectory walk over millions of entries, which caused the visible
      // "Loading folder…" pause. FSEvents will still reconcile later where a
      // watcher is active, while this optimistic delta keeps the UI responsive.
      if (deletedPaths.size > 0) applyOptimisticTrashRemoval([...deletedPaths]);

    } catch (e) {
      alert('Error moving items to Trash: ' + e.message);
    }
  }, [applyOptimisticTrashRemoval, collector]);

  useEffect(() => {
    if (countdown === null) return;

    if (countdown > 0) {
      countdownTimerRef.current = setTimeout(() => {
        setCountdown(current => current - 1);
      }, 1000);
      return () => clearTimeout(countdownTimerRef.current);
    }

    if (countdown === 0) executePurgeAndRefresh();
  }, [countdown, executePurgeAndRefresh]);

  // ── Context Menu ─────────────────────────────────────────────────────────────
  const handleQuickLook = useCallback(async (item, options = {}) => {
    if (!item?.path) return;
    if (!options.keyboardNavigation) {
      keyboardNavigationRef.current = false;
      quickLookKeyboardPriorityRef.current = false;
      setKeyboardNavigationActive(false);
    }
    if (item.type === 'special' || item.path === '__hidden__') {
      await openHiddenSpace(item);
      return;
    }
    if (item.archiveVirtual || item.path.startsWith('__') || !['file', 'directory', 'symlink'].includes(item.type)) return;
    if (!window.electronAPI?.quickLook) {
      alert('Quick Look is available in the Electron app only.');
      return;
    }
    if (quickLookPathRef.current === item.path) {
      const closed = await window.electronAPI.quickLookClose?.();
      if (closed?.closed) {
        quickLookPathRef.current = null;
        quickLookNodeRef.current = null;
        quickLookKeyboardPriorityRef.current = false;
        return;
      }
    }
    quickLookNodeRef.current = item;
    quickLookPathRef.current = item.path;
    const result = await window.electronAPI.quickLook(item.path);
    if (result?.closed || !result?.ok) {
      quickLookPathRef.current = null;
      quickLookNodeRef.current = null;
    }
    if (!result?.ok) alert(result?.error || 'Quick Look could not open this file');
  }, [openHiddenSpace]);

  useEffect(() => {
    const onPointerMove = event => {
      if (event.pointerType && event.pointerType !== 'mouse') return;
      if (!keyboardNavigationRef.current && !quickLookKeyboardPriorityRef.current) return;
      keyboardNavigationRef.current = false;
      quickLookKeyboardPriorityRef.current = false;
      setKeyboardNavigationActive(false);
    };
    window.addEventListener('pointermove', onPointerMove, true);
    return () => window.removeEventListener('pointermove', onPointerMove, true);
  }, []);

  useEffect(() => {
    const onKeyDown = event => {
      if (event.key !== ' ' || event.repeat || viewState !== 'scan' || loading || nodeLoading) return;
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target?.isContentEditable) return;
      if (target instanceof HTMLButtonElement && !target.closest('.legend-row, .sunburst-stage, .content-tree-row')) return;
      event.preventDefault();
      if (quickLookPathRef.current) {
        recordPerfInstant('quick-look.space-close', {
          path: quickLookPathRef.current,
          focusedPath: arrowStateRef.current.focusedNode?.path || null,
          pointerPath: arrowStateRef.current.pointerNode?.path || null,
          keyboardPriority: Boolean(keyboardNavigationRef.current || quickLookKeyboardPriorityRef.current)
        });
        void window.electronAPI?.quickLookClose?.();
        quickLookPathRef.current = null;
        quickLookNodeRef.current = null;
        quickLookKeyboardPriorityRef.current = false;
        return;
      }
      const arrowState = arrowStateRef.current;
      const keyboardOwnsSelection = keyboardNavigationRef.current || quickLookKeyboardPriorityRef.current || keyboardNavigationActive;
      const candidate = keyboardOwnsSelection
        ? (quickLookNodeRef.current || arrowState.focusedNode || arrowState.pointerNode || pointerNode)
        : (arrowState.pointerNode || pointerNode || arrowState.focusedNode);
      recordPerfInstant('quick-look.space-open-target', {
        path: candidate?.path || null,
        source: keyboardOwnsSelection ? 'keyboard-selection' : 'pointer-or-focus-selection',
        focusedPath: arrowState.focusedNode?.path || null,
        pointerPath: arrowState.pointerNode?.path || null,
        highlightedPath: arrowState.highlightedPath || null
      });
      if (!candidate || candidate.archiveVirtual || !['file', 'directory', 'symlink'].includes(candidate.type)) return;
      void handleQuickLook(candidate, { keyboardNavigation: keyboardOwnsSelection });
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleQuickLook, keyboardNavigationActive, loading, nodeLoading, pointerNode, viewState]);

  useEffect(() => {
    const activePath = quickLookPathRef.current;
    const candidate = pointerNode;
    if (keyboardNavigationRef.current || quickLookKeyboardPriorityRef.current) return undefined;
    if (!activePath || !candidate?.path || candidate.path === activePath || candidate.archiveVirtual || candidate.path.startsWith('__')) return undefined;
    if (!['file', 'directory', 'symlink'].includes(candidate.type) || !window.electronAPI?.quickLook) return undefined;
    const requestId = ++quickLookFollowRequestRef.current;
    const timer = window.setTimeout(async () => {
      if (requestId !== quickLookFollowRequestRef.current || quickLookPathRef.current !== activePath) return;
      const result = await window.electronAPI.quickLook(candidate.path);
      if (requestId !== quickLookFollowRequestRef.current) return;
      if (result?.ok && quickLookPathRef.current === activePath) quickLookPathRef.current = candidate.path;
    }, 120);
    return () => window.clearTimeout(timer);
  }, [pointerNode]);

  const transformAssistantResult = useCallback(async mode => {
    if (!window.electronAPI?.askSiriTransform || !assistantResult?.output || assistantTransformMode) return;
    setAssistantTransformMode(mode);
    setAssistantTransformError(null);
    setAssistantCopied(false);
    try {
      const result = await window.electronAPI.askSiriTransform(mode, assistantResult.output, assistantItem?.name);
      if (!result?.ok || !result.output) throw new Error(result?.error || 'The Shortcut returned no formatted text.');
      const output = normalizeAssistantOutput(result.output, mode);
      setAssistantResult(previous => ({ ...previous, ...result, output, ok: true }));
    } catch (error) {
      setAssistantTransformError(error.message || 'Ask Siri could not reformat this answer.');
    } finally {
      setAssistantTransformMode(null);
    }
  }, [assistantItem?.name, assistantResult?.output, assistantTransformMode]);

  const copyAssistantResult = useCallback(async () => {
    const text = assistantResult?.output;
    if (!text) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        textarea.remove();
      }
      setAssistantCopied(true);
      window.setTimeout(() => setAssistantCopied(false), 1800);
    } catch {
      setAssistantCopied(false);
    }
  }, [assistantResult?.output]);

  const handleChartNeedChildren = useCallback((node) => {
    const liveNode = resolveByPath(scannedTree, node.path) || node;
    if (liveNode.children?.length) return;
    return enrichNode(liveNode);
  }, [enrichNode, scannedTree]);

  const handleContextMenu = (e, item) => {
    e.preventDefault();
    e.stopPropagation();
    if (!item || !item.path || item.path.startsWith('__') || item.archiveVirtual) return;
    setContextOpenWith(null);
    setContextMenu({
      x: Math.min(e.clientX, Math.max(8, window.innerWidth - 310)),
      y: e.clientY,
      anchorX: e.clientX,
      anchorY: e.clientY,
      item
    });
  };

  useLayoutEffect(() => {
    if (!contextMenu || !contextMenuRef.current) return;
    const rect = contextMenuRef.current.getBoundingClientRect();
    const margin = 8;
    const anchorX = Number.isFinite(contextMenu.anchorX) ? contextMenu.anchorX : contextMenu.x;
    const anchorY = Number.isFinite(contextMenu.anchorY) ? contextMenu.anchorY : contextMenu.y;
    const nextX = Math.min(Math.max(margin, anchorX), Math.max(margin, window.innerWidth - rect.width - margin));
    const fitsBelow = anchorY + rect.height <= window.innerHeight - margin;
    const nextY = fitsBelow
      ? Math.max(margin, anchorY)
      : Math.max(margin, anchorY - rect.height);
    if (Math.abs(nextX - contextMenu.x) < 1 && Math.abs(nextY - contextMenu.y) < 1) return;
    setContextMenu(previous => previous ? { ...previous, x: nextX, y: nextY } : previous);
  }, [contextMenu, contextOpenWith?.loading, contextOpenWith?.apps?.length]);

  const handleContextGetInfo = async item => {
    const result = await window.electronAPI?.finderGetInfo?.(item.path);
    if (!result?.ok) alert(result?.error || 'Finder Get Info could not open. Check Finder Automation permission in System Settings.');
    setContextMenu(null);
    setContextOpenWith(null);
  };

  const handleContextOpenWith = async item => {
    const requestId = ++contextOpenWithRequestRef.current;
    if (contextOpenWith?.path === item.path) {
      setContextOpenWith(null);
      return;
    }
    setContextOpenWith({ path: item.path, loading: true, apps: [] });
    const result = await window.electronAPI?.getOpenWithApps?.(item.path);
    if (requestId !== contextOpenWithRequestRef.current) return;
    setContextOpenWith({ path: item.path, loading: false, apps: result?.apps || [] });
  };

  useEffect(() => {
    const onEscape = event => {
      if (event.key !== 'Escape') return;
      const resetFocus = () => window.requestAnimationFrame(() => {
        const active = document.activeElement;
        if (active instanceof HTMLElement) active.blur();
      });
      const closeAndStop = () => {
        event.preventDefault();
        event.stopPropagation();
        resetFocus();
      };

      if (onboardingOpen) {
        completeOnboarding();
        closeAndStop();
        return;
      }
      if (loading && activeScanRequestRef.current) {
        void cancelActiveScan();
        closeAndStop();
        return;
      }
      if (terminalAdminPromptOpen) {
        setTerminalAdminPromptOpen(false);
        setTerminalAdminPassword('');
        setTerminalAdminError(null);
        closeAndStop();
        return;
      }
      if (hiddenSpaceAdminPromptOpen) {
        setHiddenSpaceAdminPromptOpen(false);
        setHiddenSpaceAdminPassword('');
        setHiddenSpaceAdminError(null);
        hiddenSpacePendingNodeRef.current = null;
        closeAndStop();
        return;
      }
      if (contextMenu) {
        setContextMenu(null);
        setContextOpenWith(null);
        closeAndStop();
        return;
      }
      if (smartCleanOpen) {
        setSmartCleanOpen(false);
        closeAndStop();
        return;
      }
      if (assistantOpen) {
        setAssistantOpen(false);
        closeAndStop();
        return;
      }
      if (quickLookPathRef.current) {
        void window.electronAPI?.quickLookClose?.();
        quickLookPathRef.current = null;
        closeAndStop();
        return;
      }
      if (terminalOpen) {
        void revokeTerminalAdmin();
        setTerminalHelperHoverKey(null);
        setTerminalOpen(false);
        closeAndStop();
        return;
      }
      if (viewOptionsOpen || themesOpen || smartCleanMenuOpen || breadcrumbsMenuOpen || driveMenuKey) {
        setViewOptionsOpen(false);
        setThemesOpen(false);
        setSmartCleanMenuOpen(false);
        setBreadcrumbsMenuOpen(false);
        setDriveMenuKey(null);
        closeAndStop();
        return;
      }
      resetFocus();
    };
    window.addEventListener('keydown', onEscape, true);
    return () => window.removeEventListener('keydown', onEscape, true);
  }, [assistantOpen, breadcrumbsMenuOpen, contextMenu, driveMenuKey, hiddenSpaceAdminPromptOpen, loading, onboardingOpen, revokeTerminalAdmin, smartCleanMenuOpen, smartCleanOpen, terminalAdminPromptOpen, terminalOpen, themesOpen, viewOptionsOpen]);

  const totalCollectorSize = collector.reduce((s, i) => s + (i.size || 0), 0);
  const selectedTypeFilters = Array.isArray(viewOptions.typeFilter)
    ? viewOptions.typeFilter
    : (viewOptions.typeFilter && viewOptions.typeFilter !== 'all' ? [viewOptions.typeFilter] : []);
  const filtersActive = selectedTypeFilters.length > 0
    || viewOptions.sizeFilter !== 'all'
    || viewOptions.dateFilter !== 'all'
    || Boolean(viewOptions.nameQuery.trim());
  const toggleTypeFilter = value => setViewOptions(options => {
    const current = Array.isArray(options.typeFilter)
      ? options.typeFilter
      : (options.typeFilter && options.typeFilter !== 'all' ? [options.typeFilter] : []);
    const next = current.includes(value) ? current.filter(item => item !== value) : [...current, value];
    return { ...options, typeFilter: next };
  });

  // Filter out items already collected from the TOC list. A real file hover
  // has no relevant child list, so keep only its header and size visible.
  const expandedArchivePaths = new Set(Object.keys(packageContentsShown).filter(path => packageContentsShown[path]));
  const hoveredArchiveChildren = liveHoveredNode ? (archiveContentsByPath[liveHoveredNode.path] || liveHoveredNode.children || []) : [];
  const hoveredExpandedArchive = Boolean(
    liveHoveredNode &&
    isArchiveNode(liveHoveredNode) &&
    expandedArchivePaths.has(liveHoveredNode.path) &&
    hoveredArchiveChildren.length
  );
  const currentExpandedArchive = Boolean(
    previewNode &&
    isArchiveNode(previewNode) &&
    expandedArchivePaths.has(previewNode.path) &&
    ((archiveContentsByPath[previewNode.path]?.length || 0) > 0 || (previewNode.children?.length || 0) > 0)
  );
  // A locked hidden-space slice behaves like a leaf: show only its title + size.
  const isLockedHiddenHover = Boolean(
    liveHoveredNode
      && (liveHoveredNode.path === '__hidden__'
        || liveHoveredNode.name === 'hidden space...'
        || liveHoveredNode.isHiddenSpaceRemainder)
      && liveHoveredNode.hiddenSpaceAdminUnlocked !== true
  );
  const isFileHover = (liveHoveredNode?.type === 'file' && !hoveredExpandedArchive && !currentExpandedArchive) || isCollapsedAppHover || isLockedHiddenHover;
  // Let the chart suppress its static locked-hidden outline while that slice is
  // hovered, so the pulse overlay's transparent phase is genuinely transparent.
  const lockedHiddenHoverPath = isLockedHiddenHover ? (liveHoveredNode?.path || null) : null;
  const archiveDisplaySource = hoveredExpandedArchive
    ? liveHoveredNode
    : currentExpandedArchive
      ? currentViewNode
      : null;
  const archiveDisplayChildren = archiveDisplaySource
    ? sortNodes(
      (archiveContentsByPath[archiveDisplaySource.path] || archiveDisplaySource.children || []).filter(item => matchesViewFilters(item, viewOptions, displayMetadata)),
      viewOptions,
      displayMetadata
    )
    : null;
  const visibleChildren = isFileHover
    ? []
    : (archiveDisplayChildren || previewNode?.children || []).filter(item => !collectedPaths.has(item.path));
  const currentArchivePath = currentViewDisplayNode && isArchiveNode(currentViewDisplayNode) ? currentViewDisplayNode.path : null;
  const currentArchiveStatus = currentArchivePath ? packageContentsStatus[currentArchivePath] : null;
  const treeSelectionChildren = (chartNode?.children || []).filter(item => !collectedPaths.has(item.path));
  const visibleChildrenRef = useRef(visibleChildren);
  const treeSelectionChildrenRef = useRef(treeSelectionChildren);
  visibleChildrenRef.current = visibleChildren;
  treeSelectionChildrenRef.current = treeSelectionChildren;
  arrowStateRef.current = {
    currentViewPath: currentViewNode?.path || null,
    visibleChildren,
    treeSelectionChildren,
    treeSelectionPath,
    pointerNode,
    focusedNode: focusedLiveNode,
    hoveredNode: liveHoveredNode,
        highlightedPath,
    keyboardNavigationActive
      };
  useEffect(() => {
    const getStateSnapshot = () => {
      const state = arrowStateRef.current;
      const children = state.treeSelectionChildren || state.visibleChildren || [];
      const renderedChildren = state.visibleChildren || [];
      const activePath = state.treeSelectionPath || state.pointerNode?.path || state.focusedNode?.path || state.highlightedPath || null;
      return {
        currentViewPath: state.currentViewPath,
        pointerPath: state.pointerNode?.path || null,
        focusedPath: state.focusedNode?.path || null,
        hoveredPath: state.hoveredNode?.path || null,
        highlightedPath: state.highlightedPath || null,
        visibleList: {
          count: children.length,
          paths: children.map(item => item.path).filter(Boolean),
          activeIndex: children.findIndex(item => item.path === activePath)
        },
        renderedList: {
          count: renderedChildren.length,
          paths: renderedChildren.map(item => item.path).filter(Boolean)
        },
        treeSelectionPath: state.treeSelectionPath || null
      };
    };

    const onArrowKey = event => {
      if (!ARROW_KEYS.has(event.key)) return;

      const target = event.target;
      const activeElement = document.activeElement;
      const targetInfo = describeArrowElement(target);
      const activeElementInfo = describeArrowElement(activeElement);
      const moduleOwner = targetInfo.closestModule || activeElementInfo.closestModule;
      const isEditableOrNative = Boolean(
        target instanceof HTMLInputElement
        || target instanceof HTMLTextAreaElement
        || target instanceof HTMLSelectElement
        || target?.isContentEditable
        || activeElement instanceof HTMLInputElement
        || activeElement instanceof HTMLTextAreaElement
        || activeElement instanceof HTMLSelectElement
        || activeElement?.isContentEditable
      );
      const buttonOutsideTree = target instanceof HTMLButtonElement
        && !target.closest('.legend-row, .sunburst-stage, .content-tree-row');
      const before = getStateSnapshot();
      const arrowId = ++arrowEventSequenceRef.current;
      const children = treeSelectionChildrenRef.current;
      const baseDetails = {
        arrowId,
        key: event.key,
        repeat: Boolean(event.repeat),
        modifiers: {
          alt: Boolean(event.altKey),
          ctrl: Boolean(event.ctrlKey),
          meta: Boolean(event.metaKey),
          shift: Boolean(event.shiftKey)
        },
        target: targetInfo,
        activeElement: activeElementInfo,
        currentViewPath: before.currentViewPath,
        visibleList: before.visibleList,
        renderedList: before.renderedList,
        before: {
          pointerPath: before.pointerPath,
          focusedPath: before.focusedPath,
          hoveredPath: before.hoveredPath,
          highlightedPath: before.highlightedPath,
          treeSelectionPath: before.treeSelectionPath || null
        },
        preventedBefore: Boolean(event.defaultPrevented)
      };

      let ownership = moduleOwner || null;
      let reason = moduleOwner ? 'existing-module-focus' : null;
      let selectedTarget = null;
      let handledByGlobalTree = false;

      if (!ownership && isEditableOrNative) {
        ownership = 'editable/native-control';
        reason = 'native-or-editable-focus';
      } else if (!ownership && (viewState !== 'scan' || loading || nodeLoading)) {
        ownership = 'ignored';
        reason = viewState !== 'scan' ? 'not-in-scan-view' : loading ? 'scan-loading' : 'node-loading';
      } else if (!ownership && buttonOutsideTree) {
        ownership = 'ignored';
        reason = 'button-outside-tree-or-chart';
      } else if (!ownership && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
        if (!children.length) {
          ownership = 'ignored';
          reason = 'empty-visible-list';
        } else {
          ownership = 'tree-global';
          const currentPath = (children.some(item => item.path === before.treeSelectionPath) ? before.treeSelectionPath : null)
            || (children.some(item => item.path === before.focusedPath) ? before.focusedPath : null)
            || (children.some(item => item.path === before.highlightedPath) ? before.highlightedPath : null);
          let currentIndex = children.findIndex(item => item.path === currentPath);
          if (currentIndex < 0) currentIndex = event.key === 'ArrowDown' ? -1 : children.length;
          const nextIndex = Math.max(0, Math.min(children.length - 1, currentIndex + (event.key === 'ArrowDown' ? 1 : -1)));
          const nextNode = children[nextIndex];
          if (nextNode) {
            selectedTarget = { path: nextNode.path, index: nextIndex };
            handledByGlobalTree = true;
            keyboardNavigationRef.current = true;
            quickLookKeyboardPriorityRef.current = true;
            quickLookNodeRef.current = nextNode;
            setKeyboardNavigationActive(true);
            event.preventDefault();
            setTreeSelectionPath(nextNode.path);
            setFocusedNode(nextNode);
            setHighlightedPath(nextNode.path);
            if (quickLookPathRef.current) {
              quickLookNodeRef.current = nextNode;
              void handleQuickLook(nextNode, { keyboardNavigation: true });
            }
            const row = document.querySelector(`[data-tree-path="${CSS.escape(nextNode.path)}"]`);
            row?.scrollIntoView({ block: 'nearest' });
            reason = event.repeat ? 'current-global-tree-handler-repeat' : 'current-global-tree-handler';
          } else {
            ownership = 'ignored';
            reason = 'no-selectable-target';
          }
        }
      } else if (!ownership) {
        ownership = 'tree-global';
        reason = 'direction-not-handled-by-current-global-handler';
      }

      const predictedAfter = handledByGlobalTree && selectedTarget
        ? {
          ...before,
          pointerPath: before.pointerPath,
          focusedPath: selectedTarget.path,
          hoveredPath: before.hoveredPath,
          highlightedPath: selectedTarget.path,
          treeSelectionPath: selectedTarget.path,
          visibleList: { ...before.visibleList, activeIndex: selectedTarget.index },
          renderedList: before.renderedList
        }
        : before;
      recordPerfInstant('keyboard.arrow-keydown', {
        ...baseDetails,
        ownership: ownership || 'ignored',
        reason,
        selectedTarget,
        handled: handledByGlobalTree,
        prevented: Boolean(event.defaultPrevented),
        after: {
            pointerPath: predictedAfter.pointerPath,
            focusedPath: predictedAfter.focusedPath,
            hoveredPath: predictedAfter.hoveredPath,
            highlightedPath: predictedAfter.highlightedPath,
            treeSelectionPath: predictedAfter.treeSelectionPath || null
          }

      });

      window.setTimeout(() => {
        const after = getStateSnapshot();
        recordPerfInstant('keyboard.arrow-state-after', {
          arrowId,
          key: event.key,
          ownership: ownership || 'ignored',
          currentViewPath: after.currentViewPath,
          visibleList: after.visibleList,
          renderedList: after.renderedList,
          after: {
            pointerPath: after.pointerPath,
            focusedPath: after.focusedPath,
            hoveredPath: after.hoveredPath,
            highlightedPath: after.highlightedPath,
            treeSelectionPath: after.treeSelectionPath || null
          },
          prevented: Boolean(event.defaultPrevented)
        });
      }, 0);
    };
    window.addEventListener('keydown', onArrowKey);
    return () => window.removeEventListener('keydown', onArrowKey);
  }, [treeSelectionPath, focusedLiveNode, highlightedPath, viewState, loading, nodeLoading, handleQuickLook]);
  const visibleChildCount = visibleChildren.length;
  const visibleSizesKey = visibleChildren.slice(0, 20).map(child => Number(child.size) || 0).join(',');
  useEffect(() => {
    if (!currentArchivePath) return;
    const cachedChildren = archiveContentsByPath[currentArchivePath] || [];
    recordPerfInstant('archive.render-state', {
      path: currentArchivePath,
      shown: Boolean(packageContentsShown[currentArchivePath]),
      cacheChildren: cachedChildren.length,
      cacheSizes: cachedChildren.slice(0, 20).map(child => Number(child.size) || 0),
      currentNodeChildren: currentViewDisplayNode?.children?.length || 0,
      chartChildren: chartNode?.children?.length || 0,
      previewChildren: previewNode?.children?.length || 0,
      visibleChildren: visibleChildCount,
      visibleSizes: visibleSizesKey ? visibleSizesKey.split(',').map(Number) : []
    });
  }, [currentArchivePath, archiveContentsByPath, packageContentsShown, currentViewDisplayNode, chartNode, previewNode, visibleChildCount, visibleSizesKey]);
  // The node size is authoritative; summing children can differ because du
  // reports allocated directory blocks and hidden/excluded entries separately.
  const currentTotalSize = previewNode?.size || 0;
  const liveHeaderNode = isFileHover ? liveHoveredNode : previewNode;
  // Drive-root only: leave a proportional gap for free space in the root ring.
  // Disabled for folder scans and any drilled-in / virtual view (path differs).
  const driveRootPath = currentDrive?.scanPath || currentDrive?.mount || null;
  const chartFreeFraction = (currentDrive
    && !currentDrive.isCustomFolder
    && Number(currentDrive.total) > 0
    && chartNode?.path
    && driveRootPath
    && chartNode.path === driveRootPath)
    ? Math.max(0, Math.min(1, (Number(currentDrive.free) || 0) / Number(currentDrive.total)))
    : 0;
  const chartFreeLabel = chartFreeFraction > 0 ? formatBytes(Number(currentDrive?.free) || 0) : '';
  const chartFreeValue = chartFreeLabel ? chartFreeLabel.split(' ')[0] : '';
  const chartFreeUnit = chartFreeLabel ? chartFreeLabel.split(' ')[1] : '';

  return (
    <div className={`mac-window ${matrixTheme ? 'theme-matrix' : ''}`} onClick={() => { setContextMenu(null); }}>
      {assistantOpen && (
        <div className="assistant-backdrop">
          <section
            className="assistant-drawer"
            role="dialog"
            aria-modal="true"
            aria-labelledby="assistant-title"
            onClick={event => event.stopPropagation()}
          >
            <div className="assistant-header">
              <div>
                <div className="assistant-kicker">ASK SIRI / SHORTCUT</div>
                <h2 id="assistant-title">Object information</h2>
                {assistantItem?.name && <div className="assistant-subject" title={assistantItem.path}>{assistantItem.name}</div>}
              </div>
              <button className="assistant-close" aria-label="Close Ask Siri result" title="Close" onClick={() => setAssistantOpen(false)}>
                <X size={15} />
              </button>
            </div>
            {assistantLoading ? (
              <div className="assistant-loading" role="status" aria-live="polite">
                <span>Researching with Shortcuts…</span>
                <span className="assistant-loading-subtitle">The result will return here when the background shortcut finishes.</span>
              </div>
            ) : assistantResult?.ok ? (
              <>
                <div className="assistant-result-toolbar">
                  <div className="assistant-result-meta">
                    {assistantTransformMode ? `Formatting ${assistantTransformMode}…` : `Returned by ${assistantResult.shortcutName || 'Sunburst Disk — Ask Siri'}`}
                  </div>
                  <div className="assistant-result-actions">
                    <button className="assistant-format-btn" type="button" disabled={Boolean(assistantTransformMode)} onClick={() => void transformAssistantResult('expand')} title="Expand" aria-label="Expand">
                      <Maximize2 size={13} />
                    </button>
                    <button className="assistant-format-btn" type="button" disabled={Boolean(assistantTransformMode)} onClick={() => void transformAssistantResult('shorten')} title="Shorten" aria-label="Shorten">
                      <Minimize2 size={13} />
                    </button>
                    <button className="assistant-format-btn" type="button" disabled={Boolean(assistantTransformMode)} onClick={() => void transformAssistantResult('simplify')} title="Simplify" aria-label="Simplify">
                      <Sparkles size={13} />
                    </button>
                    <button className="assistant-format-btn" type="button" disabled={Boolean(assistantTransformMode)} onClick={() => void transformAssistantResult('bullets')} title="Bullet List" aria-label="Bullet List">
                      <List size={13} />
                    </button>
                    <button className="assistant-copy-btn" type="button" disabled={Boolean(assistantTransformMode)} onClick={() => void copyAssistantResult()} title="Copy" aria-label="Copy" data-copied={assistantCopied ? 'true' : 'false'}>
                      <Copy size={13} />
                    </button>
                  </div>
                </div>
                {assistantTransformError && <div className="assistant-transform-error" role="alert">{assistantTransformError}</div>}
                <div className="assistant-output">{assistantResult.output}</div>
                <div className="assistant-note">Informational result only. Sunburst Disk does not delete, move or modify anything from this panel.</div>
              </>
            ) : (
              <div className="assistant-error" role="alert">
                <strong>Ask Siri could not return a result.</strong>
                <span>{assistantResult?.error || 'The Shortcut returned no usable output.'}</span>
                {assistantResult?.setupRequired && <span>Create or enable the named Shortcut, then try again.</span>}
                {assistantResult?.diagnostics && (
                  <details className="assistant-diagnostics">
                    <summary>Technical diagnostics</summary>
                    <code>{JSON.stringify(assistantResult.diagnostics, null, 2)}</code>
                  </details>
                )}
              </div>
            )}
          </section>
        </div>
      )}

      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <header className="mac-header" data-tauri-drag-region="deep">
        {viewState === 'scan' ? (
          <div className="mac-toolbar">
            <div className="nav-history-controls" aria-label="Navigation history">
              <button
                className="nav-icon-btn"
                title="Back"
                aria-label="Back"
                disabled={historyBack.length === 0}
                onClick={() => navigateHistory('back')}
              >
                <ChevronLeft size={13} />
              </button>
              <button
                className="nav-icon-btn"
                title="Forward"
                aria-label="Forward"
                disabled={historyForward.length === 0}
                onClick={() => navigateHistory('forward')}
              >
                <ChevronRight size={13} />
              </button>
            </div>
            <div className={`breadcrumb-shell ${breadcrumbsCompact ? 'compact' : ''}`} ref={breadcrumbRef}>
              <div className="mac-breadcrumbs">
                <span className="mac-pill" data-tauri-drag-region="false" title="Disks and Folders" onClick={() => setViewState('drives')}>
                  {compactBreadcrumbLabel('Disks and Folders')}
                </span>
                {breadcrumbsCompact ? (
                  <>
                    <ChevronRight size={10} color="#656c7a" />
                    <div className="breadcrumb-overflow">
                      <button
                        className="mac-pill breadcrumb-ellipsis"
                        title="Show intermediate levels"
                        aria-label="Show intermediate breadcrumb levels"
                        aria-expanded={breadcrumbsMenuOpen}
                        onClick={event => {
                          event.stopPropagation();
                          setBreadcrumbsMenuOpen(open => !open);
                        }}
                      >…</button>
                      {breadcrumbsMenuOpen && (
                        <div className="breadcrumb-overflow-menu" data-tauri-drag-region="false" onClick={event => event.stopPropagation()}>
                          {navStack.slice(1, -2).map((node, offset) => {
                            const idx = offset + 1;
                            return (
                              <button key={node.path || idx} className="breadcrumb-menu-item" title={node.name} onClick={() => {
                                setBreadcrumbsMenuOpen(false);
                                navigateTo(node, idx);
                              }}>
                                {compactBreadcrumbLabel(node.name)}
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                    {navStack.slice(-2).map((node, offset) => {
                      const idx = navStack.length - 2 + offset;
                      return (
                        <React.Fragment key={node.path || idx}>
                          <ChevronRight size={10} color="#656c7a" />
                          <span className={`mac-pill ${idx === navStack.length - 1 ? 'active' : ''}`} data-tauri-drag-region="false" title={node.name} onClick={() => navigateTo(node, idx)}>
                            {compactBreadcrumbLabel(node.name)}
                          </span>
                        </React.Fragment>
                      );
                    })}
                  </>
                ) : navStack.map((node, idx) => (
                  <React.Fragment key={node.path || idx}>
                    <ChevronRight size={10} color="#656c7a" />
                    <span className={`mac-pill ${idx === navStack.length - 1 ? 'active' : ''}`} data-tauri-drag-region="false" title={node.name} onClick={() => navigateTo(node, idx)}>
                      {compactBreadcrumbLabel(node.name)}
                    </span>
                  </React.Fragment>
                ))}
              </div>
              <div className="breadcrumbs-measure" ref={breadcrumbMeasureRef} aria-hidden="true">
                <span className="mac-pill">Disks and Folders</span>
                {navStack.map((node, idx) => (
                  <React.Fragment key={node.path || idx}>
                    <ChevronRight size={10} />
                    <span className="mac-pill">{compactBreadcrumbLabel(node.name)}</span>
                  </React.Fragment>
                ))}
              </div>
            </div>
            <button
              className={`nav-icon-btn refresh-btn ${refreshing ? 'is-refreshing' : ''}`}
              title="Refresh current folder"
              aria-label="Refresh current folder"
              disabled={refreshing || loading || !currentViewNode}
              onClick={() => { void refreshCurrentFolder(); }}
            >
              <RefreshCw size={13} />
            </button>
            <div className="smart-clean-menu-wrap">
              <button
                className={`smart-clean-toolbar-btn ${smartCleanMenuOpen ? 'active' : ''}`}
                title="Review Smart Clean candidates"
                aria-label="Review Smart Clean candidates"
                aria-expanded={smartCleanMenuOpen}
                onClick={event => {
                  event.stopPropagation();
                  setViewOptionsOpen(false);
                  setThemesOpen(false);
                  setSmartCleanMenuOpen(open => !open);
                }}
              >
                Smart Clean <ChevronDown size={10} />
              </button>
              {smartCleanMenuOpen && (
                <div className="smart-clean-menu" onClick={event => event.stopPropagation()}>
                  {!currentDrive?.isCustomFolder && (
                    <button className="smart-clean-menu-item" onClick={() => { void openSmartClean('storage'); }}>
                      <span>Current Storage</span><span className="smart-clean-menu-hint">approved user-level locations</span>
                    </button>
                  )}
                  <button
                    className="smart-clean-menu-item"
                    disabled={!currentViewNode || currentViewNode.type !== 'directory' || currentViewNode.path?.startsWith('__')}
                    onClick={() => { void openSmartClean('folder'); }}
                  >
                    <span>Current Folder</span><span className="smart-clean-menu-hint">{currentViewNode?.type === 'directory' ? compactBreadcrumbLabel(currentViewNode.name) : 'analyzed folder required'}</span>
                  </button>
                </div>
              )}
            </div>
            <div className="themes-menu-wrap">
              <button
                className={`themes-toggle ${themesOpen ? 'active' : ''}`}
                title="Choose theme"
                aria-label="Choose theme"
                aria-expanded={themesOpen}
                onClick={event => {
                  event.stopPropagation();
                  setViewOptionsOpen(false);
                  setSmartCleanMenuOpen(false);
                  setThemesOpen(open => !open);
                }}
              >
                Themes <ChevronDown size={11} />
              </button>
              {themesOpen && (
                <div className="themes-menu" onClick={event => event.stopPropagation()}>
                  <button
                    className={`theme-menu-item ${!matrixTheme ? 'selected' : ''}`}
                    onClick={() => { setMatrixTheme(false); setThemesOpen(false); }}
                  >
                    <span>Classic</span>
                    {!matrixTheme && <span className="theme-check">✓</span>}
                  </button>
                  <button
                    className={`theme-menu-item ${matrixTheme ? 'selected' : ''}`}
                    onClick={() => { setMatrixTheme(true); setThemesOpen(false); }}
                  >
                    <span>Matrix</span>
                    {matrixTheme && <span className="theme-check">✓</span>}
                  </button>
                </div>
              )}
            </div>
            <button
              className={`details-toggle ${detailsOpen ? 'active' : ''}`}
              title={detailsOpen ? 'Hide Details' : 'Show Details'}
              aria-label={detailsOpen ? 'Hide Details sidebar' : 'Show Details sidebar'}
              aria-pressed={detailsOpen}
              onClick={() => setDetailsOpen(open => !open)}
            >
              {detailsOpen ? <PanelRightClose size={13} /> : <PanelRight size={13} />}
              <span>Details</span>
            </button>
          </div>
        ) : (
          <>
            <div className="mac-title">Sunburst Disk</div>
            <button
              type="button"
              className="home-info-btn"
              title="Open Welcome"
              aria-label="Open Welcome"
              onClick={() => {
                setAskSiriSetupStatus(null);
                setOnboardingOpen(true);
              }}
            >
              i
            </button>
          </>
        )}
      </header>

      {updateActivity && (
        <div className={`update-toast ${updateActivity.phase || ''}`} role="status" aria-live="polite">
          <strong>
            {updateActivity.phase === 'downloading'
              ? `Downloading Sunburst Disk ${updateActivity.version || ''}…`
              : updateActivity.phase === 'mounting'
                ? 'Opening the installer…'
                : updateActivity.phase === 'done'
                  ? 'Update downloaded'
                  : 'Update download failed'}
          </strong>
          <span>
            {updateActivity.phase === 'downloading'
              ? `${formatBytes(updateActivity.received || 0)}${updateActivity.total ? ` of ${formatBytes(updateActivity.total)}` : ''}`
              : updateActivity.phase === 'mounting'
                ? 'The disk image will open in Finder.'
                : updateActivity.phase === 'done'
                  ? 'Drag Sunburst Disk into Applications, then quit and reopen it.'
                  : (updateActivity.error || 'Please try again from the app menu.')}
          </span>
          {updateActivity.phase === 'downloading' && (
            <div className="update-toast-bar">
              <div
                className="update-toast-fill"
                style={{
                  width: `${updateActivity.total
                    ? Math.min(100, Math.round(((updateActivity.received || 0) / updateActivity.total) * 100))
                    : 100}%`
                }}
              />
            </div>
          )}
        </div>
      )}

      {onboardingOpen && (
        <div className="onboarding-backdrop" role="presentation" onClick={completeOnboarding}>
          <section className="onboarding-modal" role="dialog" aria-modal="true" aria-labelledby="onboarding-title" onClick={event => event.stopPropagation()}>
            <button
              type="button"
              className="onboarding-close"
              title="Close Welcome"
              aria-label="Close Welcome"
              onClick={completeOnboarding}
            >
              <X size={14} strokeWidth={2} aria-hidden="true" />
            </button>
            <div className="onboarding-kicker">SUNBURST DISK · {onboardingIsUpdate ? `UPDATED ${APP_VERSION}` : 'WELCOME'}</div>
            <h1 id="onboarding-title">{onboardingIsUpdate ? `What’s new in Sunburst Disk ${APP_VERSION}` : 'Understand your storage at a glance'}</h1>
            <p className="onboarding-intro">Sunburst Disk lets you understand storage before you act: scan a disk or one folder, move through the same hierarchy in the sunburst and content tree, inspect real file details, follow live Finder changes and send reviewed candidates to Collector. Nothing is removed automatically.</p>

            <div className="onboarding-columns">
              <div className="onboarding-section">
                <div className="onboarding-section-title">{onboardingIsUpdate ? 'Recent improvements' : 'Core features'}</div>
                <ul className="onboarding-list">
                  {(onboardingIsUpdate
                    ? (RELEASE_HIGHLIGHTS[APP_VERSION] || ['Maintenance release: bug fixes and internal improvements.'])
                    : CORE_FEATURES).map(item => <li key={item}>{item}</li>)}
                </ul>
              </div>
              <div className="onboarding-section">
                <div className="onboarding-section-title">Before first scan</div>
                <div className="onboarding-permission">
                  <div>
                    <strong>Notifications <em className="onboarding-permission-status optional">Optional</em></strong>
                    <span>Allows a native notification and sound when a long disk scan finishes.</span>
                  </div>
                  <button type="button" className="onboarding-settings-btn" onClick={() => { void window.electronAPI?.openSystemSettings?.('notifications'); }}>Open Settings</button>
                </div>
                <div className="onboarding-permission">
                  <div>
                    <strong>Ask Siri Shortcut <em className="onboarding-permission-status optional">Optional</em></strong>
                    <span>One-time setup in Apple Shortcuts enables in-app object explanations. The shortcut receives text and returns plain text.</span>
                  </div>
                  <div className="onboarding-permission-actions">
                    <button type="button" className="onboarding-settings-btn" onClick={() => { void handleSetupAskSiri(); }}>Set up</button>
                    {askSiriSetupStatus && <span className="onboarding-setup-status" role="status">{askSiriSetupStatus}</span>}
                  </div>
                </div>
                <div className="onboarding-guide-downloads" aria-label="Save Ask Siri Shortcut guide">
                  <span>Need the full setup recipe?</span>
                  <button type="button" className="onboarding-settings-btn" onClick={() => { void handleSaveShortcutGuide(); }}>Save TXT guide</button>
                  {askSiriSetupStatus && <span className="onboarding-setup-status" role="status">{askSiriSetupStatus}</span>}
                </div>
                <div className="onboarding-note">The TXT guide contains the complete setup recipe and troubleshooting marker. Setup guidance never unlocks deletion.</div>
              </div>
            </div>
            <div className="onboarding-footer">
              <span>This guide appears once on first launch and once after an app update.</span>
              <button type="button" className="onboarding-continue" onClick={completeOnboarding}>Continue to Sunburst Disk</button>
            </div>
          </section>
        </div>
      )}

      {/* ── Screen 1: Drives ────────────────────────────────────────────────── */}
      {viewState === 'drives' && (
        <div className="drives-screen">
          <div className="drives-list">
            {drives.map((drive, idx) => {
              const driveKey = getDriveKey(drive);
              const cachedTree = scanCache[driveKey]?.tree;
              const hasCachedScan = Boolean(cachedTree);
              const scannedFolderSize = Number(cachedTree?.size || drive.used || 0);
              return (
              <div key={driveKey || idx} className={`drive-row ${drive.isCustomFolder ? 'custom-folder-row' : ''}`}>
                <div className="drive-icon-meta">
                  {drive.isCustomFolder ? (
                    <Folder className="drive-folder-icon" size={34} strokeWidth={1.35} aria-hidden="true" />
                  ) : (
                    <svg className="drive-icon" viewBox="0 0 40 40">
                      <rect x="4" y="6" width="32" height="28" rx="4" fill={drive.isStartup ? '#b5b5b5' : '#e5a100'} />
                      <circle cx="20" cy="20" r="4" fill="#333" />
                    </svg>
                  )}
                  <div>
                    <div className="drive-name">{drive.name}</div>
                    <div className="drive-desc">{drive.isCustomFolder ? `${formatBytes(scannedFolderSize)} scanned folder` : `${formatBytes(drive.total)} ${drive.isStartup ? 'startup disk' : 'external disk'}`}</div>
                  </div>
                </div>
                <div className="drive-bar-section">
                  <div className="drive-progress-bg">
                    <div className="drive-progress-fill" style={{
                      width: drive.isCustomFolder ? '100%' : drive.usePercent,
                      background: drive.isCustomFolder ? 'linear-gradient(90deg,#60a5fa,#93c5fd)' : drive.isStartup ? 'linear-gradient(90deg,#ff7e5f,#feb47b)' : '#2bd980'
                    }} />
                  </div>
                  <div className="drive-free-text">{drive.isCustomFolder ? formatBytes(scannedFolderSize) : formatBytes(drive.free)}</div>
                </div>
                <div className="drive-scan-control">
                  <button
                    className="mac-action-btn drive-primary-action"
                    onClick={() => hasCachedScan ? handleViewDrive(drive) : handleScanDrive(drive)}
                  >
                    {hasCachedScan ? 'View' : 'Scan'}
                  </button>
                  <button
                    className="mac-action-btn drive-menu-trigger"
                    aria-label={`${hasCachedScan ? 'View' : 'Scan'} options for ${drive.name}`}
                    aria-expanded={driveMenuKey === driveKey}
                    onClick={event => {
                      event.stopPropagation();
                      setDriveMenuKey(current => current === driveKey ? null : driveKey);
                    }}
                  >
                    <ChevronDown size={12} />
                  </button>
                  {driveMenuKey === driveKey && (hasCachedScan || drive.isEjectable || drive.isCustomFolder) && (
                    <div className="drive-menu" onClick={event => event.stopPropagation()}>
                      {hasCachedScan && (
                        <button className="drive-menu-item" onClick={() => handleViewDrive(drive)}>
                          View saved scan
                        </button>
                      )}
                      {hasCachedScan && (
                        <button className="drive-menu-item" onClick={() => handleScanDrive(drive)}>
                          Scan again
                        </button>
                      )}
                      {drive.isEjectable && (
                        <button
                          className="drive-menu-item drive-eject-item"
                          onClick={() => { void handleEjectDrive(drive); }}
                          disabled={ejectingDriveKey === driveKey}
                        >
                          {ejectingDriveKey === driveKey ? 'Ejecting…' : `Eject “${drive.name}”`}
                        </button>
                      )}
                      {drive.isCustomFolder && (
                        <button className="drive-menu-item drive-close-item" onClick={() => closeSavedFolder(drive)}>
                          Close
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
              );
            })}
          </div>
          <div className="drives-bottom-bar">
            <div className="drives-bottom-actions">
              <button className="mac-action-btn" onClick={() => { void handleScanFolder(); }}>Scan Folder...</button>
              <button className="mac-action-btn smart-clean-launch" onClick={() => { void openSmartClean('storage'); }}>System Smart Clean</button>
            </div>
          </div>
        </div>
      )}

      {smartCleanOpen && (
        <div className="smart-clean-backdrop">
          <section className="smart-clean-drawer" role="dialog" aria-modal="true" aria-labelledby="smart-clean-title" onClick={event => event.stopPropagation()}>
            <div className="smart-clean-header">
              <div>
                <div id="smart-clean-title" className="smart-clean-title">Smart Clean</div>
                <div className="smart-clean-subtitle">{smartCleanScope === 'folder' ? 'Current Folder' : 'Current Storage'} · review only — nothing is removed automatically</div>
              </div>
              <button className="smart-clean-close" title="Close Smart Clean" onClick={() => setSmartCleanOpen(false)}>×</button>
            </div>
            {smartCleanLoading ? (
              <div className="smart-clean-status">Inspecting approved user cache, log and candidate locations…</div>
            ) : smartCleanData?.error ? (
              <div className="smart-clean-status smart-clean-error">{smartCleanData.error}</div>
            ) : (
              <>
                <div className="smart-clean-scope-path" title={smartCleanData?.scopePath}>{smartCleanData?.scopePath || 'Current scope'}</div>
                <div className="smart-clean-summary">
                  <div><strong>{smartCleanCandidates.length}</strong><span>candidates</span></div>
                  <div><strong>{formatBytes(smartCleanSelectedSize)}</strong><span>selected</span></div>
                  <div className="smart-clean-summary-actions">
                    <button onClick={() =>     setSmartCleanSelected(new Set(smartCleanVisibleCandidates.map(candidate => candidate.path)))
} disabled={!smartCleanVisibleCandidates.length}>Select visible</button>
                    <button onClick={() => setSmartCleanSelected(new Set())} disabled={!smartCleanSelected.size}>Clear</button>
                  </div>
                </div>
                <div className="smart-clean-risk-tabs" role="tablist" aria-label="Smart Clean deletion safety">
                  {[
                    ['safe', 'Safe', smartCleanRiskCounts.safe],
                    ['review', 'Moderate', smartCleanRiskCounts.review],
                    ['high', 'High risk', smartCleanRiskCounts.high],
                    ['all', 'Everything', smartCleanCandidates.length]
                  ].map(([key, label, count]) => (
                    <button key={key} className={smartCleanRiskFilter === key ? 'active' : ''} role="tab" aria-selected={smartCleanRiskFilter === key} onClick={() => {
                      recordPerfInstant('smart-clean.filter-change', { filterKind: 'risk', ...buildSmartCleanTelemetry(smartCleanCandidates, key, smartCleanCategoryFilters) });
                      setSmartCleanRiskFilter(key);
                    }}>{label} <span>{count}</span></button>
                  ))}
                </div>
                <div className="smart-clean-safety-note">Safe = regenerable caches, logs and developer data. Moderate = saved state, incomplete downloads, old installers, Trash and screenshot-like personal files. High risk = duplicate fingerprints requiring manual verification. Mail attachments, Messages, Photos, Containers, Group Containers and Application Support remain excluded.</div>
                <div className="smart-clean-root-summary" aria-label="Filter Smart Clean locations">
                  <button type="button" className={smartCleanCategoryFilters.size === 0 ? 'active' : ''} onClick={() => {
                    recordPerfInstant('smart-clean.filter-change', { filterKind: 'category-reset', ...buildSmartCleanTelemetry(smartCleanCandidates, smartCleanRiskFilter, new Set()) });
                    setSmartCleanCategoryFilters(new Set());
                  }}>All locations</button>
                  {(smartCleanData?.roots || []).map(root => (
                    <button
                      type="button"
                      key={root.id}
                      className={smartCleanCategoryFilters.has(root.id) ? 'active' : ''}
                      aria-pressed={smartCleanCategoryFilters.has(root.id)}
                      title={root.path || root.label}
                      onClick={() => setSmartCleanCategoryFilters(previous => {
                        const next = new Set(previous);
                        if (next.has(root.id)) next.delete(root.id);
                        else next.add(root.id);
                        recordPerfInstant('smart-clean.filter-change', { filterKind: 'category', changedCategoryId: root.id, changedCategoryLabel: root.label, ...buildSmartCleanTelemetry(smartCleanCandidates, smartCleanRiskFilter, next) });
                        return next;
                      })}
                    >{root.label}: {root.unavailable ? 'unavailable' : root.candidates}</button>
                  ))}
                </div>
                <div className="smart-clean-list">
                  {smartCleanVisibleCandidates.map(candidate => {
                    const risk = normalizeSmartCleanRiskValue(candidate.risk);
                    const ageDays = smartCleanAgeDays(candidate);
                    const ageLabel = formatSmartCleanAge(ageDays);
                    return (
                      <label key={candidate.path} className="smart-clean-row">
                        <input
                          type="checkbox"
                          checked={smartCleanSelected.has(candidate.path)}
                          onChange={() => toggleSmartCleanCandidate(candidate.path)}
                        />
                        <span className="smart-clean-candidate-main">
                          <span className="smart-clean-candidate-name">
                            <span className="smart-clean-candidate-label" title={candidate.name}>{candidate.name}</span>
                            {ageLabel && <span className="smart-clean-age">{ageLabel}</span>}
                          </span>
                          <span className="smart-clean-candidate-meta">{candidate.category} · {candidate.reason}</span>
                          <span className="smart-clean-candidate-path" title={candidate.path}>{candidate.path}</span>
                          {candidate.verification && <span className="smart-clean-candidate-verification">Verification: {candidate.verification}</span>}
                          {risk === 'safe' && ageDays >= 60 && (
                            <span className="smart-clean-candidate-hint">Unused for {ageDays} days — consider cleaning</span>
                          )}
                        </span>
                        <span className={`smart-clean-risk risk-${risk}`}>{risk === 'safe' ? 'Safe' : risk === 'high' ? 'High' : 'Moderate'}</span>
                        <span className="smart-clean-candidate-size">{formatBytes(candidate.size)}</span>
                      </label>
                    );
                  })}
                  {!smartCleanVisibleCandidates.length && <div className="smart-clean-empty">No candidates in this safety tier. Inspected {smartCleanData?.roots?.length || 0} approved location{smartCleanData?.roots?.length === 1 ? '' : 's'}; a root with no matching items is not a deletion error.</div>}
                </div>
                <div className="smart-clean-footer">
                  <span>{smartCleanData?.excludedCount ? `${smartCleanData.excludedCount} excluded by safety policy` : ''}{smartCleanData?.generatedAt ? ` · Updated ${new Date(smartCleanData.generatedAt).toLocaleTimeString()}` : ''}</span>
                  <button className="smart-clean-export" onClick={() => { void exportSmartCleanSelection(); }} disabled={!smartCleanSelected.size}>Add selected to Collector</button>
                </div>
              </>
            )}
          </section>
        </div>
      )}

      {/* ── Screen 2: Scan View ─────────────────────────────────────────────── */}
      {viewState === 'scan' && (
        <div className="scan-screen">
          {scanNotice && (
            <div className="scan-complete-toast" role="status" aria-live="polite">
              <strong>{scanNotice.title || 'Disk scan complete'}</strong>
              <span>{scanNotice.body}</span>
            </div>
          )}

          {/* Chart Area */}
          <div className="chart-area">
            {loading ? (
              <div className="scan-loading-status" role="status" aria-live="polite">
                <div className="scan-loading-header">
                  <div className="scan-loading-text">Scanning disk…</div>
                  <button className="scan-cancel-btn" type="button" title="Cancel scan and return Home" aria-label="Cancel scan and return Home" onClick={() => { void cancelActiveScan(); }}>
                    <X size={15} />
                  </button>
                </div>
                <div className="scan-progress-bar-bg">
                  <div
                    className="scan-progress-bar-fill"
                    style={{ width: scanProgress.percent < 0 ? '4%' : `${Math.max(4, scanProgress.percent)}%` }}
                  />
                </div>
                <div className="scan-progress-status">
                  <span className="scan-current-file">
                    {scanProgress.currentDir || 'Indexing folders…'}
                  </span>
                  <span className="scan-percent-text">
                    {scanProgress.percent >= 0 ? `${Math.round(scanProgress.percent)}%` : 'Preparing…'}
                  </span>
                </div>
              </div>
            ) : nodeLoading ? (
              <div className="scan-loading-status" role="status" aria-live="polite">
                <div className="scan-loading-text">Loading folder…</div>
              </div>
            ) : scanError ? (
              <div className="scan-error-status" role="alert">
                <div className="scan-error-title">Scan could not be completed</div>
                <div className="scan-error-message">{scanError}</div>
                <div className="scan-error-actions">
                  <button className="mac-action-btn" onClick={() => setViewState('drives')}>Back to Disks</button>
                  <button className="mac-action-btn" onClick={() => handleScanDrive(currentDrive)}>Try Again</button>
                </div>
              </div>
            ) : currentViewNode ? (
              <>
                <SunburstChart
                  data={chartNode}
                  onSelectNode={node => navigateTo(resolveByPath(scannedTree, node.path) || node)}
                  onCenterClick={navigateUp}
                  onNeedChildren={handleChartNeedChildren}
                  setHoveredNode={handleHoverNode}
                  onContextMenu={handleContextMenu}
                  highlightedPath={highlightedPath}
                  keyboardNavigationActive={keyboardNavigationActive}
                  colorAssignments={chartColorAssignments}
                  theme={matrixTheme ? 'matrix' : 'classic'}
                  collectedPaths={collectedPaths}
                  centerValue={formatBytes(liveHoveredNode ? liveHoveredNode.size : currentTotalSize).split(' ')[0]}
                  centerUnit={formatBytes(liveHoveredNode ? liveHoveredNode.size : currentTotalSize).split(' ')[1]}
                  freeFraction={chartFreeFraction}
                  freeValue={chartFreeValue}
                  freeUnit={chartFreeUnit}
                  lockedHiddenHoverPath={lockedHiddenHoverPath}
                />
              </>
            ) : null}

            {/* Collector Container */}
            <div className="collector-wrapper">
              {/* Expanded Collector Items List */}
              {collectorExpanded && collector.length > 0 && (
                <div className="collector-drawer">
                  <div className="collector-drawer-header">
                    <span>Collected Items ({collector.length})</span>
                    <button className="collector-drawer-clear" onClick={() => setCollector([])}>Clear all</button>
                  </div>
                  <div className="collector-items-list">
                    {collector.map((item, idx) => (
                      <div key={idx} className="collector-item-group">
                        <div className="collector-item-row">
                          <div className="collector-item-info">
                            {item.type === 'directory' ? <Folder size={12} color="#3b82f6" /> : <FileText size={12} color="#71717a" />}
                            <CrawlLabel name={item.name} className="collector-item-name" />
                          </div>
                          <div className="collector-item-right">
                            <span className="collector-item-size">{formatBytes(item.size)}</span>
                            <button
                              className="collector-quicklook-btn"
                              title="Quick Look"
                              aria-label={`Quick Look ${item.name}`}
                              onClick={event => { event.stopPropagation(); void handleQuickLook(item); }}
                            >
                              <Eye size={12} />
                            </button>
                            <button
                              className="collector-remove-btn"
                              title="Remove from collector"
                              onClick={(e) => {
                                e.stopPropagation();
                                removeFromCollector(item.path);
                              }}
                            >
                              <X size={12} />
                            </button>
                          </div>
                        </div>
                        {item.relatedResources?.length > 0 && (
                          <div className="collector-related-list">
                            <div className="collector-related-header">
                              <div className="collector-related-heading">Related app resources — review individually</div>
                              <button
                                className="collector-related-add-all"
                                title="Add all related resources separately"
                                onClick={async event => {
                                  event.stopPropagation();
                                  for (const resource of item.relatedResources) await collectItem(resource);
                                }}
                              >Add All</button>
                            </div>
                            {item.relatedResources.map(resource => (
                              <div key={resource.path} className="collector-related-row" title={resource.path}>
                                <span className="collector-related-branch">↳</span>
                                {resource.type === 'directory' ? <Folder size={11} /> : <FileText size={11} />}
                                <span className="collector-related-name">{resource.name}</span>
                                <span className="collector-related-relation">{resource.relation}</span>
                                <span className="collector-related-size">{formatBytes(resource.size)}</span>
                                <button
                                  className="collector-related-add"
                                  title="Add this related resource separately"
                                  onClick={event => { event.stopPropagation(); void collectItem(resource); }}
                                >+</button>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Collector Drop Target Bar */}
              <div
                className={`collector-target ${isDragOver ? 'drag-over' : ''}`}
                onDrop={handleDrop}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onClick={() => {
                  if (collector.length > 0) setCollectorExpanded(prev => !prev);
                }}
              >
                <div className="collector-ring-icon">
                  <div className="collector-ring-inner" />
                </div>
                <span className={`collector-text ${collector.length > 0 ? 'collector-has-items' : ''}`}>
                  {collector.length > 0
                    ? `${collector.length} item${collector.length > 1 ? 's' : ''} (${formatBytes(totalCollectorSize)}) ${collectorExpanded ? '▲' : '▼'}`
                    : 'Drag and drop files here to collect them'}
                </span>

                {/* Purge / Countdown Action */}
                {collector.length > 0 && (
                  <div className="collector-actions" onClick={e => e.stopPropagation()}>
                    {countdown === null ? (
                      <button className="collector-purge-btn" onClick={startPurgeCountdown}>
                        <Trash2 size={12} /> Move to Trash
                      </button>
                    ) : (
                      <div className="countdown-bar">
                        <span>Deleting in <span className="countdown-sec">{countdown}</span>s</span>
                        <button className="countdown-cancel-btn" onClick={cancelPurge} title="Cancel deletion">
                          <RotateCcw size={11} /> Undo
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>

            {terminalOpen && (
              <div
                className="terminal-drawer"
                ref={terminalDrawerRef}
                style={{ left: `${terminalFrame.left}px`, top: `${terminalFrame.top}px` }}
                onClick={event => event.stopPropagation()}
              >
                <div
                  className="terminal-drawer-header"
                  onPointerDown={event => {
                    if (event.target.closest('button')) return;
                    const drawer = event.currentTarget.parentElement;
                    const area = drawer?.parentElement;
                    if (!drawer || !area) return;
                    const areaRect = area.getBoundingClientRect();
                    const drawerRect = drawer.getBoundingClientRect();
                    terminalDragRef.current = {
                      startX: event.clientX,
                      startY: event.clientY,
                      left: drawerRect.left - areaRect.left,
                      top: drawerRect.top - areaRect.top,
                      drawerWidth: drawerRect.width,
                      drawerHeight: drawerRect.height,
                      bounds: { width: areaRect.width, height: areaRect.height }
                    };
                    event.currentTarget.setPointerCapture?.(event.pointerId);
                  }}
                >
                  <span>Terminal</span>
                  <span className={`terminal-readonly-badge ${terminalAdminMode ? 'terminal-readwrite-badge' : ''}`}>{terminalAdminMode ? 'READ & WRITE' : 'READ ONLY'}</span>
                  <button className="terminal-close" title="Hide Terminal" onClick={() => { void revokeTerminalAdmin(); setTerminalHelperHoverKey(null); setTerminalOpen(false); }}>×</button>
                </div>
                <div className="terminal-command-presets" aria-label={terminalAdminMode ? 'Read and write terminal command helpers' : 'Safe terminal command helpers'}>
                  {(terminalAdminMode ? [...TERMINAL_COMMAND_PRESETS, ...TERMINAL_ADMIN_COMMAND_PRESETS] : TERMINAL_COMMAND_PRESETS).map(preset => (
                    <button
                      key={preset.command}
                      className="terminal-command-preset"
                      title={preset.help}
                      aria-label={preset.help}
                      onMouseEnter={() => setTerminalHelperHoverKey(preset.command)}
                      onMouseLeave={() => setTerminalHelperHoverKey(null)}
                      onFocus={() => setTerminalHelperHoverKey(preset.command)}
                      onBlur={() => setTerminalHelperHoverKey(null)}
                      onClick={() => { setTerminalCommand(preset.command); setTerminalHistoryIndex(-1); setTerminalHelpKey(preset.command); }}
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
                {terminalHelperHoverKey && (() => {
                  const allTerminalPresets = [...TERMINAL_COMMAND_PRESETS, ...TERMINAL_ADMIN_COMMAND_PRESETS];
                  const preset = allTerminalPresets.find(item => item.command === terminalHelperHoverKey)
                    || allTerminalPresets.find(item => item.command === terminalHelpKey)
                    || allTerminalPresets[0];
                  const isAdminHelper = TERMINAL_ADMIN_COMMAND_PRESETS.some(item => item.command === preset.command);
                  return (
                    <div className="terminal-command-help" role="tooltip">
                      <div className="terminal-help-title"><code>{preset.syntax}</code><span>{isAdminHelper ? 'Read & write helper' : 'Read-only helper'}</span></div>
                      <div><strong>Purpose:</strong> {preset.purpose}</div>
                      <div><strong>Options:</strong> {preset.options}</div>
                      <div><strong>Examples:</strong><pre>{preset.examples}</pre></div>
                    </div>
                  );
                })()}
                <pre
                  className="terminal-output"
                  onDragOver={handleTerminalPathDragOver}
                  onDrop={handleTerminalPathDrop}
                >{terminalOutput === null ? 'Safe commands: pwd · ls -la · du -sh · df -h · clear' : terminalOutput}</pre>
                <div className="terminal-drawer-note">
                  Filesystem changes, deletion, sudo and arbitrary shell commands are blocked unless you have an{' '}
                  <button className="terminal-admin-link" type="button" onClick={() => { if (!terminalAdminMode) { setTerminalAdminError(null); setTerminalAdminPromptOpen(true); } }} disabled={terminalAdminMode}>admin</button>{' '}
                  accessing. clear is handled locally.
                  {terminalAdminMode && <button className="terminal-lock-btn" type="button" onClick={() => { void revokeTerminalAdmin(); }}>Lock</button>}
                </div>
                {terminalAdminPromptOpen && !terminalAdminMode && (
                  <div className="terminal-admin-prompt">
                    <label htmlFor="terminal-admin-password">Administrator password</label>
                    <input
                      id="terminal-admin-password"
                      type="password"
                      value={terminalAdminPassword}
                      onChange={event => setTerminalAdminPassword(event.target.value)}
                      onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void authorizeTerminalAdmin(); } }}
                      autoComplete="current-password"
                      autoFocus
                    />
                    <button type="button" onClick={() => { void authorizeTerminalAdmin(); }} disabled={!terminalAdminPassword}>Unlock</button>
                    <button type="button" onClick={() => { setTerminalAdminPromptOpen(false); setTerminalAdminPassword(''); setTerminalAdminError(null); }}>Cancel</button>
                    {terminalAdminError && <span className="terminal-admin-error">{terminalAdminError}</span>}
                  </div>
                )}
                <div
                  className="terminal-command-row"
                  onDragOver={handleTerminalPathDragOver}
                  onDrop={handleTerminalPathDrop}
                >
                  <span className="terminal-prompt">›</span>
                  <input
                    className="terminal-command-input"
                    value={terminalCommand}
                    onChange={event => { setTerminalCommand(event.target.value); setTerminalHistoryIndex(-1); }}
                    onKeyDown={handleTerminalCommandKeyDown}
                    aria-label={terminalAdminMode ? 'Read and write terminal command' : 'Read-only terminal command'}
                    spellCheck="false"
                    autoCapitalize="off"
                    autoCorrect="off"
                  />
                  <button className="terminal-run-btn" onClick={() => { void runTerminalCommand(); }} disabled={terminalBusy}>
                    {terminalBusy ? 'Running…' : 'Run'}
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Legend / File List */}
          <div className="legend-area">
            <div className="legend-header">
              <div className="legend-title">
                <CrawlLabel
                  name={liveHeaderNode?.name || (loading ? currentDrive?.name || 'Scanning…' : '')}
                  className="legend-title-crawl"
                  active={Boolean(hoveredNode)}
                />
                {currentArchiveStatus?.status === 'loading' && (
                  <span className="legend-preview-badge archive-status-loading"> {currentArchiveStatus.message}</span>
                )}
                {currentArchiveStatus?.status === 'ready' && (
                  <span className="legend-preview-badge archive-status-ready"> {currentArchiveStatus.message}</span>
                )}
                {currentArchiveStatus?.status === 'error' && (
                  <span className="legend-preview-badge archive-status-error" title={currentArchiveStatus.message}> Archive Viewer error</span>
                )}
                {folderWatchState.updating && (
                  <span className="folder-watch-badge updating" title="The open folder is being reconciled with the filesystem"> Updating…</span>
                )}
                {!folderWatchState.updating && folderWatchState.error && (
                  <span className="folder-watch-badge error" title={folderWatchState.error}> Watch error</span>
                )}
                {!folderWatchState.updating && !folderWatchState.error && folderWatchState.active && (
                  <span className="folder-watch-badge" title="Changes in this open folder are monitored and reconciled"> Live</span>
                )}
              </div>
              <div className="legend-header-actions">
                <div className="legend-total">
                                        {loading ? '' : formatBytes(isFileHover ? liveHoveredNode.size : currentTotalSize)}

                </div>
                <button
                  className={`view-options-trigger ${viewOptionsOpen ? 'active' : ''} ${filtersActive ? 'filters-active' : ''}`}
                  title="Sort and filter"
                  aria-label="Sort and filter"
                  aria-expanded={viewOptionsOpen}
                  onClick={event => {
                    event.stopPropagation();
                    setSmartCleanMenuOpen(false);
                    setThemesOpen(false);
                    setViewOptionsOpen(open => !open);
                  }}
                >
                  <ListFilter size={14} />
                </button>
              </div>
            </div>

            {viewOptionsOpen && (
              <div className="view-options-panel" onClick={event => event.stopPropagation()}>
                <div className="view-options-heading">Display options</div>
                <div className="view-options-grid">
                  <label>Sort by
                    <ThemedSelect
                      value={viewOptions.sortBy}
                      ariaLabel="Sort by"
                      options={[
                        { value: 'size', label: 'Size' },
                        { value: 'name', label: 'Name' },
                        { value: 'type', label: 'Type' },
                        { value: 'date', label: 'Date modified' }
                      ]}
                      onChange={value => setViewOptions(options => ({ ...options, sortBy: value }))}
                    />
                  </label>
                  <button className="sort-direction-btn" onClick={() => setViewOptions(options => ({ ...options, sortDirection: options.sortDirection === 'asc' ? 'desc' : 'asc' }))}>
                    {viewOptions.sortDirection === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />}
                    {viewOptions.sortDirection === 'asc' ? 'Ascending' : 'Descending'}
                  </button>
                  <div className="view-options-type-field">
                    <div className="view-options-field-label">Type <span>{selectedTypeFilters.length ? `${selectedTypeFilters.length} selected` : 'All types'}</span></div>
                    <div className="view-type-multiselect" role="group" aria-label="Filter by one or more object types">
                      {TYPE_FILTER_OPTIONS.map(([value, label]) => (
                        <label key={value} className="view-type-option">
                          <input
                            type="checkbox"
                            checked={selectedTypeFilters.includes(value)}
                            onChange={() => toggleTypeFilter(value)}
                          />
                          <span>{label}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                  <label>Minimum size
                    <ThemedSelect
                      value={viewOptions.sizeFilter}
                      ariaLabel="Minimum size"
                      options={[
                        { value: 'all', label: 'Any size' },
                        { value: '1mb', label: '1 MB+' },
                        { value: '100mb', label: '100 MB+' },
                        { value: '1gb', label: '1 GB+' }
                      ]}
                      onChange={value => setViewOptions(options => ({ ...options, sizeFilter: value }))}
                    />
                  </label>
                  <label>Modified
                    <ThemedSelect
                      value={viewOptions.dateFilter}
                      ariaLabel="Modified"
                      options={[
                        { value: 'all', label: 'Any date' },
                        { value: '1', label: 'Last 24 hours' },
                        { value: '7', label: 'Last 7 days' },
                        { value: '30', label: 'Last 30 days' },
                        { value: '365', label: 'Last year' }
                      ]}
                      onChange={value => setViewOptions(options => ({ ...options, dateFilter: value }))}
                    />
                  </label>
                  <label className="view-options-search">Name contains
                    <input value={viewOptions.nameQuery} onChange={event => setViewOptions(options => ({ ...options, nameQuery: event.target.value }))} placeholder="Search names" />
                  </label>
                </div>
                <button className="view-options-reset" onClick={() => setViewOptions(DEFAULT_VIEW_OPTIONS)}>Reset filters</button>
              </div>
            )}

            <div className="legend-list">
              {visibleChildren.map((item, idx) => {
                const color = colorAssignments[item.path] || getNodeColor(item, idx, matrixTheme);
                const isHigh = highlightedPath === item.path;
                return (
                  <div
                    key={idx}
                    className={`legend-row ${isHigh ? 'highlighted' : ''}`}
                    data-tree-path={item.path || undefined}
                    title={item.name}
                    draggable={item.path && !item.path.startsWith('__')}
                    onDragStart={e => {
                      if (!item.path || item.path.startsWith('__')) { e.preventDefault(); return; }
                      e.dataTransfer.setData('application/json', JSON.stringify(item));
                      e.dataTransfer.setData('text/plain', item.path);
                      e.dataTransfer.effectAllowed = 'copy';
                    }}
                    onClick={() => {
                      setTreeSelectionPath(item.path);
                      setFocusedNode(item);
                      const archiveIsOpen = isArchiveNode(item) && packageContentsShown[item.path]
                        && Boolean(archiveContentsByPath[item.path]?.length || item.children?.length);
                      if (item.type === 'directory' || item.type === 'special' || archiveIsOpen) navigateTo(item);
                    }}
                    onMouseEnter={() => {
                      keyboardNavigationRef.current = false;
                      quickLookKeyboardPriorityRef.current = false;
                      setKeyboardNavigationActive(false);
                      setTreeSelectionPath(item.path);
                      setHighlightedPath(item.path);
                      setFocusedNode(item);
                      setPointerNode(item);
                    }}
                    onMouseLeave={() => {
                      setHighlightedPath(null);
                      setPointerNode(null);
                    }}
                    onContextMenu={e => handleContextMenu(e, item)}
                  >
                    <div className="legend-left">
                      <div className="dot" style={{ backgroundColor: color }} />
                      {item.type === 'directory'
                        ? <Folder size={13} color={color} style={{ opacity: 0.8 }} />
                        : <FileText size={13} color={matrixTheme ? color : '#71717a'} style={{ opacity: 0.7 }} />}
                      <CrawlLabel
                        name={item.name}
                        active={isHigh}
                        className={item.name === 'hidden space...' ? 'special' : item.type === 'file' ? 'dim' : ''}
                      />
                    </div>
                    <div className="legend-right">
                      <span className="legend-val">{formatBytes(item.size)}</span>
                      <button
                        className="legend-add-btn"
                        title="Add to collector"
                        disabled={!getRiskInfo(item).canDelete}
                        onClick={e => { e.stopPropagation(); void collectItem(item); }}
                      >+</button>
                    </div>
                  </div>
                );
              })}

              <div className="legend-divider" />
              {currentDrive && (
                <>
                  <div className="legend-row static">
                    <div className="legend-left">
                      <div className="dot" style={{ backgroundColor: '#52525b' }} />
                      <span className="legend-label dim">free space</span>
                    </div>
                    <span className="legend-val">{formatBytes(currentDrive.free)}</span>
                  </div>
                  <div className="legend-row static">
                    <div className="legend-left">
                      <span className="legend-tilde">~</span>
                      <span className="legend-label dim">total capacity</span>
                    </div>
                    <span className="legend-val">{formatBytes(currentDrive.total)}</span>
                  </div>
                </>
              )}
            </div>
          </div>

          {detailsOpen && (
            <DetailsSidebar
              node={focusedLiveNode}
              metadata={itemDetails}
              loading={detailsLoading}
              risk={getRiskInfo(focusedLiveNode)}
              categoryDescription={getCategoryDescription(focusedLiveNode)}
              onAddToCollector={collectItem}
              onQuickLook={handleQuickLook}
              onRevealInFinder={itemPath => window.electronAPI?.revealInFinder(itemPath)}
              onTogglePackageContents={togglePackageContents}
              packageContentsShown={Boolean(packageContentsShown[focusedLiveNode?.path])}
              packageContentsStatus={packageContentsStatus[focusedLiveNode?.path]}
              onOpenFullDiskAccessSettings={() => { void window.electronAPI?.openFullDiskAccessSettings?.(); }}
              onRequestHiddenSpaceAccess={node => hiddenSpaceAdminAuthorized ? lockHiddenSpace(node) : openHiddenSpace(node)}
              hiddenSpaceUnlocked={hiddenSpaceAdminAuthorized}
            />
          )}
          <DebugDownbar
            terminalOpen={terminalOpen}
            onToggleTerminal={() => setTerminalOpen(open => !open)}
            onLoggingEnabled={handleCapacityCaptureStart}
          />
        </div>
      )}

      {hiddenSpaceAdminPromptOpen && (
        <div className="hidden-space-admin-backdrop" role="presentation" onClick={event => event.stopPropagation()}>
          <section className="hidden-space-admin-dialog" role="dialog" aria-modal="true" aria-labelledby="hidden-space-admin-title">
            <div className="onboarding-kicker">PROTECTED SYSTEM DATA</div>
            <h2 id="hidden-space-admin-title">Unlock Hidden Space</h2>
            <p>Administrator authorization is required to inspect one level of system-managed hidden space. This does not unlock deletion or Terminal write commands.</p>
            <form onSubmit={event => { event.preventDefault(); void authorizeHiddenSpace(); }}>
              <label htmlFor="hidden-space-admin-password">Administrator password</label>
              <input
                id="hidden-space-admin-password"
                type="password"
                value={hiddenSpaceAdminPassword}
                onChange={event => setHiddenSpaceAdminPassword(event.target.value)}
                autoComplete="current-password"
                autoFocus
              />
              <div className="hidden-space-admin-actions">
                <button type="submit" disabled={!hiddenSpaceAdminPassword}>Unlock</button>
                <button type="button" onClick={() => { setHiddenSpaceAdminPromptOpen(false); setHiddenSpaceAdminPassword(''); setHiddenSpaceAdminError(null); hiddenSpacePendingNodeRef.current = null; }}>Cancel</button>
              </div>
              {hiddenSpaceAdminError && <div className="terminal-admin-error" role="alert">{hiddenSpaceAdminError}</div>}
            </form>
          </section>
        </div>
      )}

      {/* ── Styled context menu: also used in Matrix because native menus cannot inherit CSS ── */}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className={`ctx-menu ${matrixTheme ? 'ctx-menu-matrix' : ''}`}
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onClick={e => e.stopPropagation()}
        >
          <div className="ctx-item ctx-title">{contextMenu.item.name}</div>
          <div className="ctx-separator" />
          <div className={`ctx-item ${['file', 'directory', 'symlink'].includes(contextMenu.item.type) ? '' : 'disabled'}`} onClick={() => {
            if (!['file', 'directory', 'symlink'].includes(contextMenu.item.type)) return;
            void handleQuickLook(contextMenu.item);
            setContextMenu(null);
          }}>◉ Quick Look</div>
          <div
            className={`ctx-item ${window.electronAPI?.askSiri ? '' : 'disabled'}`}
            onClick={() => {
              if (window.electronAPI?.askSiri) void window.electronAPI.askSiri(contextMenu.item);
              setContextMenu(null);
            }}
          >◌ Ask Siri…</div>
          <div className="ctx-item" onClick={() => {
            if (window.electronAPI?.revealInFinder) void window.electronAPI.revealInFinder(contextMenu.item.path);
            setContextMenu(null);
          }}>⌕ Reveal in Finder</div>
          <div className="ctx-item" onClick={() => { void handleContextGetInfo(contextMenu.item); }}>ⓘ Get Info</div>
          <div className="ctx-item" onClick={() => { void handleContextOpenWith(contextMenu.item); }}>{contextOpenWith?.path === contextMenu.item.path ? '▾ Open with…' : '▸ Open with…'}</div>
          {contextOpenWith?.path === contextMenu.item.path && (
            <div className="ctx-submenu">
              {contextOpenWith.loading && <div className="ctx-item disabled">Loading compatible apps…</div>}
              {!contextOpenWith.loading && contextOpenWith.apps.length === 0 && <div className="ctx-item disabled">No compatible apps found</div>}
              {!contextOpenWith.loading && contextOpenWith.apps.map(application => (
                <div key={application.appPath} className="ctx-item ctx-subitem" onClick={() => {
                  void window.electronAPI?.openWithApplication?.(application.appPath, contextMenu.item.path);
                  setContextMenu(null);
                  setContextOpenWith(null);
                }}>{application.label}</div>
              ))}
              {!contextOpenWith.loading && <div className="ctx-item ctx-subitem" onClick={() => {
                void window.electronAPI?.chooseOtherApplication?.(contextMenu.item.path);
                setContextMenu(null);
                setContextOpenWith(null);
              }}>Other…</div>}
            </div>
          )}
          {isPackageContainerNode(contextMenu.item) && (
            <div className="ctx-item" onClick={() => {
              void togglePackageContents(contextMenu.item);
              setContextMenu(null);
            }}>
              {packageContentsShown[contextMenu.item.path] ? '▤ Hide Package Contents' : '▤ Show Package Contents'}
            </div>
          )}
          <div
            className={`ctx-item danger ${getRiskInfo(contextMenu.item).canDelete ? '' : 'disabled'}`}
            onClick={() => {
              if (getRiskInfo(contextMenu.item).canDelete) void collectItem(contextMenu.item);
              setContextMenu(null);
            }}
          >
            {getRiskInfo(contextMenu.item).canDelete ? '+ Add to Collector' : '⊘ Deletion disabled'}
          </div>
        </div>
      )}
    </div>
  );
}
