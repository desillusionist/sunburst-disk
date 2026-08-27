import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, ChevronDown, PanelRight, PanelRightClose, RefreshCw, ShieldCheck, ShieldAlert, LockKeyhole, AlertTriangle, Folder, FileText, Trash2, X, RotateCcw, Copy } from 'lucide-react';
import SunburstChart from './components/SunburstChart';
import DetailsSidebar from './components/DetailsSidebar';
import DebugDownbar from './components/DebugDownbar';
import { recordPerfEvent, recordPerfInstant } from './debug/perfTelemetry';

// macOS Finder uses decimal gigabytes (1000^3) for disk and application display:
function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1000;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(Math.max(1, bytes)) / Math.log(k));
  const val = (bytes / Math.pow(k, i));
  return (val >= 100 ? val.toFixed(0) : val.toFixed(1)) + ' ' + sizes[i];
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
  if (matrixTheme) return '#39ff66';
  if (node?.name === 'smaller objects...') return COLOR_MAP['smaller objects...'];
  if (node?.name === 'hidden space...' || node?.type === 'special') return COLOR_MAP['hidden space...'];
  if (node?.type === 'file') return '#64748b';
  return COLOR_MAP[node?.name] || RING_COLORS[idx % RING_COLORS.length];
}

function getDriveKey(drive) {
  return drive?.filesystem || drive?.mount || drive?.name;
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
  return Boolean(node?.type === 'directory' && (node.name?.endsWith('.app') || node.path?.endsWith('.app')));
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
const TYPE_ORDER = { directory: 0, file: 1, special: 2 };
const DEFAULT_VIEW_OPTIONS = {
  sortBy: 'size',
  sortDirection: 'desc',
  typeFilter: 'all',
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
  if (options.typeFilter === 'files' && node.type !== 'file') return false;
  if (options.typeFilter === 'folders' && node.type !== 'directory') return false;
  if (options.typeFilter === 'special' && node.type !== 'special') return false;

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
  const packageCollapsed = isAppBundleNode(node) && !packageContentsShown[node.path];
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
  const packageCollapsed = isAppBundleNode(node) && !packageContentsShown[node.path];
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
  }
];

const DEFAULT_DRIVES = [
  { filesystem: '/dev/disk3s5', name: 'iDāsOS', total: 245.1e9, used: 231.3e9, free: 22.7e9, usePercent: '89%', mount: '/', scanPath: '/System/Volumes/Data', isStartup: true },
  { filesystem: '/dev/disk7s1', name: 'exAPFS', total: 2e12, used: 216.1e9, free: 1783.9e9, usePercent: '11%', mount: '/Volumes/exAPFS', scanPath: '/Volumes/exAPFS', isStartup: false },
  { filesystem: '/dev/disk8s1', name: 'I-MOVIES', total: 2e12, used: 1286.9e9, free: 713.1e9, usePercent: '64%', mount: '/Volumes/I-MOVIES', scanPath: '/Volumes/I-MOVIES', isStartup: false }
];

export default function App() {
  const [viewState, setViewState]           = useState('drives');
  const [drives, setDrives]                 = useState(DEFAULT_DRIVES);
  const [currentDrive, setCurrentDrive]     = useState(null);
  const [scannedTree, setScannedTree]       = useState(null);
  const [scanCache, setScanCache]           = useState({});
  const [driveMenuKey, setDriveMenuKey]     = useState(null);
  const [navStack, setNavStack]             = useState([]);
  const [historyBack, setHistoryBack]       = useState([]);
  const [historyForward, setHistoryForward] = useState([]);
  const [detailsOpen, setDetailsOpen]       = useState(true);
  const [matrixTheme, setMatrixTheme]       = useState(false);
  const [focusedNode, setFocusedNode]       = useState(null);
  const [pointerNode, setPointerNode]       = useState(null);
  const [itemDetails, setItemDetails]       = useState(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [hoveredNode, setHoveredNode]       = useState(null);
  const [highlightedPath, setHighlightedPath] = useState(null);
  const [loading, setLoading]               = useState(false);
    const [scanError, setScanError]       = useState(null);
  const [scanNotice, setScanNotice]     = useState(null);

  const [scanProgress, setScanProgress]     = useState({ percent: 0, currentDir: '', itemsScanned: 0 });
  const pendingScanCompletionRef = useRef(null);
  const [collector, setCollector]           = useState([]);
  const [isDragOver, setIsDragOver]         = useState(false);
  const [collectorExpanded, setCollectorExpanded] = useState(false);
  const [countdown, setCountdown]           = useState(null);
  const [contextMenu, setContextMenu]       = useState(null);
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
  const [terminalOutput, setTerminalOutput] = useState('');
  const [terminalBusy, setTerminalBusy] = useState(false);
  const [terminalFrame, setTerminalFrame] = useState({ left: 20, top: 20 });
  const [smartCleanOpen, setSmartCleanOpen] = useState(false);
  const [smartCleanLoading, setSmartCleanLoading] = useState(false);
  const [smartCleanData, setSmartCleanData] = useState(null);
  const [smartCleanSelected, setSmartCleanSelected] = useState(() => new Set());
  const [smartCleanMenuOpen, setSmartCleanMenuOpen] = useState(false);
  const [smartCleanScope, setSmartCleanScope] = useState('storage');
  const [smartCleanRiskFilter, setSmartCleanRiskFilter] = useState('all');
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [assistantLoading, setAssistantLoading] = useState(false);
  const [assistantItem, setAssistantItem] = useState(null);
  const [assistantResult, setAssistantResult] = useState(null);
  const [assistantCopied, setAssistantCopied] = useState(false);
  const [folderWatchState, setFolderWatchState] = useState({ active: false, rootPath: null, updating: false, error: null, lastChangedAt: null });

  const terminalDragRef = useRef(null);
  const folderWatchTreeRef = useRef(null);
  const folderWatchTargetRef = useRef(null);
  const folderWatchBusyRef = useRef(false);
  const folderWatchQueuedRef = useRef(null);
  const folderWatchGenerationRef = useRef(0);
  const breadcrumbRef = useRef(null);
  const breadcrumbMeasureRef = useRef(null);
  const countdownTimerRef = useRef(null);
  const [nodeLoading, setNodeLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [packageContentsShown, setPackageContentsShown] = useState({});

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
  const isCollapsedAppHover = Boolean(
    liveHoveredNode?.path?.toLowerCase?.().endsWith('.app')
      && !packageContentsShown[liveHoveredNode.path]
  );
  const previewSource = isCollapsedAppHover
    ? liveHoveredNode
    : liveHoveredNode && liveHoveredNode.children && liveHoveredNode.children.length > 0
      ? liveHoveredNode
      : currentViewNode;
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
    const isHoverPreview = previewSource !== currentViewNode;
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
      currentViewNode,
      viewOptions,
      displayMetadata,
      packageContentsShown,
      displayCacheRef.current,
      displayOptionsKey,
      needsDisplayMetadata
    );
    recordPerfEvent('display-tree.build', performance.now() - startedAt, {
      path: currentViewNode?.path || null,
      children: currentViewNode?.children?.length || 0,
      role: 'chart'
    });
    return result;
  }, [currentViewNode, viewOptions, displayMetadata, packageContentsShown, displayOptionsKey, needsDisplayMetadata]);
  const isPreviewNode = Boolean(liveHoveredNode && liveHoveredNode.children && liveHoveredNode.children.length > 0);
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
    const knownDirectoryForPath = changedPath => {
      let candidatePath = changedPath;
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
    recordPerfInstant('folder-watch.reconcile-start', {
      rootPath,
      targetCount: targetPaths.length,
      fullScan: Boolean(payload.fullScan),
      changedCount: Array.isArray(payload.changedPaths) ? payload.changedPaths.length : 0,
      truncated: Boolean(payload.truncated),
      rootMissing: Boolean(payload.rootMissing)
    });
    setFolderWatchState(previous => ({ ...previous, updating: true, lastChangedAt: payload.observedAt || Date.now() }));
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
      setFocusedNode(previous => previous?.path ? resolveByPath(nextTree, previous.path) || previous : previous);
      recordPerfInstant('folder-watch.reconcile-complete', { rootPath, targetCount: targetPaths.length });
      setFolderWatchState(previous => ({ ...previous, updating: false, error: null }));
    } catch (error) {
      recordPerfInstant('folder-watch.reconcile-error', { rootPath, message: error.message || 'Folder update failed' });
      if (folderWatchTargetRef.current?.path === rootPath && folderWatchTreeRef.current === tree) {
        setFolderWatchState(previous => ({ ...previous, updating: false, error: error.message || 'Folder update failed' }));
      }
    } finally {
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
      removeStatus?.();
      removeChange?.();
      if (api.stopCurrentFolderWatcher) void api.stopCurrentFolderWatcher();
    };
  }, [currentViewNode?.path, currentViewNode?.type, loading, reconcileFolderWatchChange, viewState]);

  // Close context menu on outside click
  useEffect(() => {
    const handler = () => {
      setContextMenu(null);
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
      setAssistantLoading(true);
      setAssistantOpen(true);
    });
    const removeAskSiriResult = window.electronAPI.onAskSiriResult?.(payload => {
      setAssistantLoading(false);
      setAssistantResult(payload || { ok: false, error: 'No result returned.' });
      setAssistantOpen(true);
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
    return () => {
      removeAskSiriStart?.();
      removeAskSiriResult?.();
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

  const fetchDrives = async () => {
    try {
      if (window.electronAPI) {
        const data = await window.electronAPI.getDrives();
        if (data?.drives?.length > 0) setDrives(data.drives);
      }
    } catch (e) { console.error('Drive fetch error:', e); }
  };

  const handleScanDrive = async (drive) => {
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

    try {
      if (window.electronAPI) {
        // Accurate full scan — sizes are always fully computed by the main
        // process; detail (children) is returned for the first 10 levels and
        // lazy-loaded beyond that. No timeout, no mock fallback.
        const scanStartedAt = performance.now();
        const data = await window.electronAPI.scanDirectory(scanPath, 10);
        recordPerfEvent('ipc.scan-directory', performance.now() - scanStartedAt, { path: scanPath });
        if (data?.tree) {
          data.tree.name = drive.name;
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
      console.error('Scan error:', e);
      setLoading(false);
      setScanError(e.message || 'The scan could not be completed');
    }
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
    setSmartCleanScope(scope);
    setSmartCleanRiskFilter('all');
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
      setSmartCleanData(result);
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

  const smartCleanCandidates = smartCleanData?.candidates || [];
  const smartCleanRiskCounts = smartCleanCandidates.reduce((counts, candidate) => ({
    ...counts,
    [candidate.risk || 'review']: (counts[candidate.risk || 'review'] || 0) + 1
  }), { safe: 0, review: 0, high: 0 });
  const smartCleanVisibleCandidates = smartCleanRiskFilter === 'all'
    ? smartCleanCandidates
    : smartCleanCandidates.filter(candidate => (candidate.risk || 'review') === smartCleanRiskFilter);
  const smartCleanSelectedItems = smartCleanCandidates.filter(candidate => smartCleanSelected.has(candidate.path));
  const smartCleanSelectedSize = smartCleanSelectedItems.reduce((sum, candidate) => sum + (Number(candidate.size) || 0), 0);

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
    if (isAppBundleNode(node) && !packageContentsShown[node.path]) return;
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

  const openHiddenSpace = useCallback(async (node) => {
    if (!window.electronAPI?.scanHiddenSpace) {
      alert('Hidden Space access is available in the Electron app only.');
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
      } else if (result?.error && !result.settingsOpened) {
        alert(result.error);
      }
    } finally {
      setNodeLoading(false);
    }
  }, []);

  const showPackageContents = useCallback(async (node) => {
    if (!isAppBundleNode(node) || !window.electronAPI?.scanSubdir) return;
    setNodeLoading(true);
    try {
      const result = await window.electronAPI.scanSubdir(node.path, true);
      if (!result?.tree) throw new Error(result?.error || 'Package contents could not be read');
      const enriched = {
        ...node,
        children: result.tree.children || [],
        size: result.tree.size ?? node.size,
        itemCount: Number.isFinite(result.tree.itemCount) ? result.tree.itemCount : (result.tree.children || []).length
      };
      setScannedTree(previous => previous ? updateNodeInTree(previous, node.path, enriched) : previous);
      setNavStack(previous => previous.map(current => current.path === node.path ? enriched : current));
      setFocusedNode(enriched);
      setPackageContentsShown(previous => ({ ...previous, [node.path]: true }));
    } catch (error) {
      alert(`Package contents could not be shown: ${error.message}`);
    } finally {
      setNodeLoading(false);
    }
  }, []);

  const hidePackageContents = useCallback((node) => {
    if (!isAppBundleNode(node)) return;
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
  }, []);

  const togglePackageContents = useCallback((node) => {
    if (!isAppBundleNode(node)) return;
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
      return;
    }
    if (node.type === 'special' || node.path === '__hidden__') {
      setFocusedNode(node);
      await openHiddenSpace(node);
      return;
    }
    if (node.type !== 'directory') {
      setFocusedNode(node);
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
      !node.path.startsWith('__')
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

  const runTerminalCommand = useCallback(async () => {
    if (!window.electronAPI?.terminalRunSafe || terminalBusy) return;
    setTerminalBusy(true);
    const cwd = currentViewNode?.type === 'directory' && !currentViewNode.path?.startsWith('__')
      ? currentViewNode.path
      : undefined;
    try {
      const result = await window.electronAPI.terminalRunSafe(terminalCommand, cwd);
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
  }, [currentViewNode, terminalBusy, terminalCommand]);

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

      // Re-read the current folder instead of deriving its size from visible
      // children. This keeps allocated sizes correct after moving items to Trash.
      if (deletedPaths.size > 0) await refreshCurrentFolder();

    } catch (e) {
      alert('Error moving items to Trash: ' + e.message);
    }
  }, [collector, refreshCurrentFolder]);

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
  const handleQuickLook = useCallback(async (item) => {
    if (!item?.path) return;
    if (item.type === 'special' || item.path === '__hidden__') {
      await openHiddenSpace(item);
      return;
    }
    if (item.path.startsWith('__') || item.type !== 'file') return;
    if (!window.electronAPI?.quickLook) {
      alert('Quick Look is available in the Electron app only.');
      return;
    }
    const result = await window.electronAPI.quickLook(item.path);
    if (!result?.ok) alert(result?.error || 'Quick Look could not open this file');
  }, [openHiddenSpace]);

  useEffect(() => {
    const onKeyDown = event => {
      if (event.key !== ' ' || event.repeat || viewState !== 'scan' || loading || nodeLoading) return;
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target?.isContentEditable || target instanceof HTMLButtonElement) return;
      if (!pointerNode || pointerNode.type !== 'file') return;
      event.preventDefault();
      handleQuickLook(pointerNode);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleQuickLook, loading, nodeLoading, pointerNode, viewState]);

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
    if (!item || !item.path || item.path.startsWith('__')) return;
    if (window.electronAPI) {
      window.electronAPI.showContextMenu({
        itemPath: item.path,
        itemName: item.name,
        item,
        canDelete: getRiskInfo(item).canDelete,
        packageContentsShown: Boolean(packageContentsShown[item.path])
      });
    } else {
      setContextMenu({ x: e.clientX, y: e.clientY, item });
    }
  };

  const totalCollectorSize = collector.reduce((s, i) => s + (i.size || 0), 0);

  // Filter out items already collected from the TOC list. A real file hover
  // has no relevant child list, so keep only its header and size visible.
  const isFileHover = liveHoveredNode?.type === 'file' || isCollapsedAppHover;
  const visibleChildren = isFileHover
    ? []
    : (previewNode?.children || []).filter(item => !collectedPaths.has(item.path));
  // The node size is authoritative; summing children can differ because du
  // reports allocated directory blocks and hidden/excluded entries separately.
  const currentTotalSize = previewNode?.size || 0;
  const liveHeaderNode = isFileHover ? liveHoveredNode : previewNode;

  return (
    <div className={`mac-window ${matrixTheme ? 'theme-matrix' : ''}`} onClick={() => { setContextMenu(null); }}>
      {assistantOpen && (
        <div className="assistant-backdrop" onClick={() => setAssistantOpen(false)}>
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
                  <div className="assistant-result-meta">Returned by {assistantResult.shortcutName || 'Sunburst Disk — Ask Siri'}</div>
                  <button className="assistant-copy-btn" type="button" onClick={() => void copyAssistantResult()} title="Copy result to clipboard" aria-label="Copy result to clipboard">
                    <Copy size={12} /> {assistantCopied ? 'Copied' : 'Copy'}
                  </button>
                </div>
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
      <header className="mac-header">
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
                <span className="mac-pill" title="Disks and Folders" onClick={() => setViewState('drives')}>
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
                        <div className="breadcrumb-overflow-menu" onClick={event => event.stopPropagation()}>
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
                          <span className={`mac-pill ${idx === navStack.length - 1 ? 'active' : ''}`} title={node.name} onClick={() => navigateTo(node, idx)}>
                            {compactBreadcrumbLabel(node.name)}
                          </span>
                        </React.Fragment>
                      );
                    })}
                  </>
                ) : navStack.map((node, idx) => (
                  <React.Fragment key={node.path || idx}>
                    <ChevronRight size={10} color="#656c7a" />
                    <span className={`mac-pill ${idx === navStack.length - 1 ? 'active' : ''}`} title={node.name} onClick={() => navigateTo(node, idx)}>
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
                  setSmartCleanMenuOpen(open => !open);
                }}
              >
                Smart Clean <ChevronDown size={10} />
              </button>
              {smartCleanMenuOpen && (
                <div className="smart-clean-menu" onClick={event => event.stopPropagation()}>
                  <button className="smart-clean-menu-item" onClick={() => { void openSmartClean('storage'); }}>
                    <span>Current Storage</span><span className="smart-clean-menu-hint">approved user-level locations</span>
                  </button>
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
          <div className="mac-title">Sunburst Disk</div>
        )}
      </header>

      {/* ── Screen 1: Drives ────────────────────────────────────────────────── */}
      {viewState === 'drives' && (
        <div className="drives-screen">
          <div className="drives-list">
            {drives.map((drive, idx) => {
              const driveKey = getDriveKey(drive);
              const hasCachedScan = Boolean(scanCache[driveKey]?.tree);
              return (
              <div key={driveKey || idx} className="drive-row">
                <div className="drive-icon-meta">
                  <svg className="drive-icon" viewBox="0 0 40 40">
                    <rect x="4" y="6" width="32" height="28" rx="4" fill={drive.isStartup ? '#b5b5b5' : '#e5a100'} />
                    <circle cx="20" cy="20" r="4" fill="#333" />
                  </svg>
                  <div>
                    <div className="drive-name">{drive.name}</div>
                    <div className="drive-desc">{formatBytes(drive.total)} {drive.isStartup ? 'startup disk' : 'external disk'}</div>
                  </div>
                </div>
                <div className="drive-bar-section">
                  <div className="drive-progress-bg">
                    <div className="drive-progress-fill" style={{
                      width: drive.usePercent,
                      background: drive.isStartup ? 'linear-gradient(90deg,#ff7e5f,#feb47b)' : '#2bd980'
                    }} />
                  </div>
                  <div className="drive-free-text">{formatBytes(drive.free)}</div>
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
                  {driveMenuKey === driveKey && (
                    <div className="drive-menu" onClick={event => event.stopPropagation()}>
                      <button className="drive-menu-item" onClick={() => handleViewDrive(drive)} disabled={!hasCachedScan}>
                        View saved scan
                      </button>
                      <button className="drive-menu-item" onClick={() => handleScanDrive(drive)}>
                        Scan again
                      </button>
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
        <div className="smart-clean-backdrop" onClick={() => setSmartCleanOpen(false)}>
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
                    <button onClick={() => setSmartCleanSelected(new Set(smartCleanVisibleCandidates.map(candidate => candidate.path)))} disabled={!smartCleanVisibleCandidates.length}>Select visible</button>
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
                    <button key={key} className={smartCleanRiskFilter === key ? 'active' : ''} role="tab" aria-selected={smartCleanRiskFilter === key} onClick={() => setSmartCleanRiskFilter(key)}>{label} <span>{count}</span></button>
                  ))}
                </div>
                <div className="smart-clean-safety-note">Safe = regenerable caches, logs and developer data. Moderate = saved state, incomplete downloads, old installers and screenshot-like personal files. High risk = duplicate fingerprints requiring manual verification. Mail attachments, Messages, Photos, Containers, Group Containers and Application Support remain excluded.</div>
                <div className="smart-clean-list">
                  {smartCleanVisibleCandidates.map(candidate => (
                    <label key={candidate.path} className="smart-clean-row">
                      <input
                        type="checkbox"
                        checked={smartCleanSelected.has(candidate.path)}
                        onChange={() => toggleSmartCleanCandidate(candidate.path)}
                      />
                      <span className="smart-clean-candidate-main">
                        <span className="smart-clean-candidate-name">{candidate.name}</span>
                        <span className="smart-clean-candidate-meta">{candidate.category} · {candidate.reason}</span>
                        <span className="smart-clean-candidate-path" title={candidate.path}>{candidate.path}</span>
                        {candidate.verification && <span className="smart-clean-candidate-verification">Verification: {candidate.verification}</span>}
                      </span>
                      <span className={`smart-clean-risk risk-${candidate.risk || 'review'}`}>{candidate.risk === 'safe' ? 'Safe' : candidate.risk === 'high' ? 'High' : 'Moderate'}</span>
                      <span className="smart-clean-candidate-size">{formatBytes(candidate.size)}</span>
                    </label>
                  ))}
                  {!smartCleanVisibleCandidates.length && <div className="smart-clean-empty">No candidates in this safety tier.</div>}
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
                <div className="scan-loading-text">Scanning disk…</div>
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
                  key={currentViewNode.path}
                  data={chartNode}
                  onSelectNode={node => navigateTo(resolveByPath(scannedTree, node.path) || node)}
                  onCenterClick={navigateUp}
                  onNeedChildren={handleChartNeedChildren}
                  setHoveredNode={handleHoverNode}
                  onContextMenu={handleContextMenu}
                  highlightedPath={highlightedPath}
                  colorAssignments={chartColorAssignments}
                  theme={matrixTheme ? 'matrix' : 'classic'}
                  collectedPaths={collectedPaths}
                  centerValue={formatBytes(liveHoveredNode ? liveHoveredNode.size : currentTotalSize).split(' ')[0]}
                  centerUnit={formatBytes(liveHoveredNode ? liveHoveredNode.size : currentTotalSize).split(' ')[1]}
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
                            <span className="collector-item-name" title={item.path}>{item.name}</span>
                          </div>
                          <div className="collector-item-right">
                            <span className="collector-item-size">{formatBytes(item.size)}</span>
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
                  <span className="terminal-readonly-badge">READ ONLY</span>
                  <button className="terminal-close" title="Hide Terminal" onClick={() => setTerminalOpen(false)}>×</button>
                </div>
                <div className="terminal-command-presets" aria-label="Safe terminal command helpers">
                  {TERMINAL_COMMAND_PRESETS.map(preset => (
                    <button
                      key={preset.command}
                      className="terminal-command-preset"
                      title={preset.help}
                      aria-label={preset.help}
                      onMouseEnter={() => setTerminalHelperHoverKey(preset.command)}
                      onMouseLeave={() => setTerminalHelperHoverKey(null)}
                      onFocus={() => setTerminalHelperHoverKey(preset.command)}
                      onBlur={() => setTerminalHelperHoverKey(null)}
                      onClick={() => { setTerminalCommand(preset.command); setTerminalHelpKey(preset.command); }}
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
                {terminalHelperHoverKey && (() => {
                  const preset = TERMINAL_COMMAND_PRESETS.find(item => item.command === terminalHelperHoverKey)
                    || TERMINAL_COMMAND_PRESETS.find(item => item.command === terminalHelpKey)
                    || TERMINAL_COMMAND_PRESETS[0];
                  return (
                    <div className="terminal-command-help" role="tooltip">
                      <div className="terminal-help-title"><code>{preset.syntax}</code><span>Read-only helper</span></div>
                      <div><strong>Purpose:</strong> {preset.purpose}</div>
                      <div><strong>Options:</strong> {preset.options}</div>
                      <div><strong>Examples:</strong><pre>{preset.examples}</pre></div>
                    </div>
                  );
                })()}
                <pre className="terminal-output">{terminalOutput || 'Safe commands: pwd · ls -la · du -sh · df -h'}</pre>
                <div className="terminal-command-row">
                  <span className="terminal-prompt">›</span>
                  <input
                    className="terminal-command-input"
                    value={terminalCommand}
                    onChange={event => setTerminalCommand(event.target.value)}
                    onKeyDown={event => { if (event.key === 'Enter') void runTerminalCommand(); }}
                    aria-label="Read-only terminal command"
                    spellCheck="false"
                    autoCapitalize="off"
                    autoCorrect="off"
                  />
                  <button className="terminal-run-btn" onClick={() => { void runTerminalCommand(); }} disabled={terminalBusy}>
                    {terminalBusy ? 'Running…' : 'Run'}
                  </button>
                </div>
                <div className="terminal-drawer-note">Filesystem changes, deletion, sudo and arbitrary shell commands are blocked.</div>
              </div>
            )}
          </div>

          {/* Legend / File List */}
          <div className="legend-area">
            <div className="legend-header">
              <div className="legend-title">
                {liveHeaderNode?.name || (loading ? currentDrive?.name || 'Scanning…' : '')}
                {isPreviewNode && liveHoveredNode?.type !== 'file' && (
                  <span className="legend-preview-badge"> preview</span>
                )}
                {previewNode?.previewLimited && !isFileHover && (
                  <span className="legend-preview-badge"> top 100</span>
                )}
                {folderWatchState.updating && (
                  <span className="folder-watch-badge updating" title="The open folder is being reconciled with the filesystem"> Updating…</span>
                )}
                {!folderWatchState.updating && folderWatchState.active && (
                  <span className="folder-watch-badge" title="Changes in this open folder are monitored and reconciled"> Live</span>
                )}
              </div>
              <div className="legend-header-actions">
                <div className="legend-total">
                                        {loading ? '' : formatBytes(isFileHover ? liveHoveredNode.size : currentTotalSize)}

                </div>
                <button
                  className={`view-options-trigger ${viewOptionsOpen ? 'active' : ''}`}
                  title="Sort and filter"
                  aria-label="Sort and filter"
                  aria-expanded={viewOptionsOpen}
                  onClick={event => {
                    event.stopPropagation();
                    setViewOptionsOpen(open => !open);
                  }}
                >
                  <span>Sort & Filter</span>
                  <ChevronDown size={11} />
                </button>
              </div>
            </div>

            {viewOptionsOpen && (
              <div className="view-options-panel" onClick={event => event.stopPropagation()}>
                <div className="view-options-heading">Display options</div>
                <div className="view-options-grid">
                  <label>Sort by
                    <select value={viewOptions.sortBy} onChange={event => setViewOptions(options => ({ ...options, sortBy: event.target.value }))}>
                      <option value="size">Size</option>
                      <option value="name">Name</option>
                      <option value="type">Type</option>
                      <option value="date">Date modified</option>
                    </select>
                  </label>
                  <button className="sort-direction-btn" onClick={() => setViewOptions(options => ({ ...options, sortDirection: options.sortDirection === 'asc' ? 'desc' : 'asc' }))}>
                    {viewOptions.sortDirection === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />}
                    {viewOptions.sortDirection === 'asc' ? 'Ascending' : 'Descending'}
                  </button>
                  <label>Type
                    <select value={viewOptions.typeFilter} onChange={event => setViewOptions(options => ({ ...options, typeFilter: event.target.value }))}>
                      <option value="all">All types</option>
                      <option value="folders">Folders</option>
                      <option value="files">Files</option>
                      <option value="special">System accounting</option>
                    </select>
                  </label>
                  <label>Minimum size
                    <select value={viewOptions.sizeFilter} onChange={event => setViewOptions(options => ({ ...options, sizeFilter: event.target.value }))}>
                      <option value="all">Any size</option>
                      <option value="1mb">1 MB+</option>
                      <option value="100mb">100 MB+</option>
                      <option value="1gb">1 GB+</option>
                    </select>
                  </label>
                  <label>Modified
                    <select value={viewOptions.dateFilter} onChange={event => setViewOptions(options => ({ ...options, dateFilter: event.target.value }))}>
                      <option value="all">Any date</option>
                      <option value="1">Last 24 hours</option>
                      <option value="7">Last 7 days</option>
                      <option value="30">Last 30 days</option>
                      <option value="365">Last year</option>
                    </select>
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
                    title={item.path && !item.path.startsWith('__') ? `${item.name}\n${item.path}` : item.name}
                    draggable={item.path && !item.path.startsWith('__')}
                    onDragStart={e => {
                      e.dataTransfer.setData('application/json', JSON.stringify(item));
                      e.dataTransfer.effectAllowed = 'move';
                    }}
                    onClick={() => {
                      setFocusedNode(item);
                      if (item.type === 'directory' || item.type === 'special') navigateTo(item);
                    }}
                    onMouseEnter={() => {
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
                      <span className={`legend-label ${item.name === 'hidden space...' ? 'special' : item.type === 'file' ? 'dim' : ''}`}>
                        {item.name}
                      </span>
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
            />
          )}
          <DebugDownbar
            terminalOpen={terminalOpen}
            onToggleTerminal={() => setTerminalOpen(open => !open)}
          />
        </div>
      )}

      {/* ── Custom Fallback Context Menu (when no Electron) ─────────────────── */}
      {contextMenu && (
        <div
          className="ctx-menu"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onClick={e => e.stopPropagation()}
        >
          <div className="ctx-item ctx-title">{contextMenu.item.name}</div>
          <div className="ctx-separator" />
          <div className={`ctx-item ${contextMenu.item.type === 'file' ? '' : 'disabled'}`} onClick={() => {
            if (contextMenu.item.type !== 'file') return;
            handleQuickLook(contextMenu.item);
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
            window.electronAPI?.revealInFinder(contextMenu.item.path);
            setContextMenu(null);
          }}>⌕ Reveal in Finder</div>
          {isAppBundleNode(contextMenu.item) && (
            <div className="ctx-item" onClick={() => {
              togglePackageContents(contextMenu.item);
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
