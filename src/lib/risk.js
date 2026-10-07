// Deletion-safety gate.
//
// This is the single source of truth for "may this node be collected / deleted?".
// It lives outside App.jsx so it can be unit-tested: the cloud read-only
// invariant and the protected-system rules are exactly the kind of thing that
// must not regress silently.
//
// `canDelete` is consumed by every deletion entry point:
//   * the legend "+" button and the context-menu "Add to Collector" item,
//   * `addToCollector` / `collectItem` (also the drag-and-drop handler),
//   * the details sidebar's collector button (via the `risk` prop),
//   * Smart Clean export, which routes through `collectItem`.
import { AlertTriangle, LockKeyhole, ShieldAlert, ShieldCheck } from 'lucide-react';

export function isStartupDataCategory(node) {
  const parts = (node?.path || '').replace(/\/+$/, '').split('/').filter(Boolean);
  return parts.length === 4 && parts[0] === 'System' && parts[1] === 'Volumes' && parts[2] === 'Data';
}

export function getRiskInfo(node) {
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
  // Cloud FileProvider trees are read-only. The app must never delete, collect or
  // download remote content, so every cloud node carries `cloudManaged` (set by
  // the Rust cloud walk) and is refused here -- which disables the legend "+",
  // the Collector, the context menu action and Smart Clean export in one place.
  if (node.cloudManaged) {
    return {
      level: 'protected',
      label: 'Cloud item — read-only',
      description: 'This item lives in cloud storage. Sunburst Disk cannot delete, collect or download it — use the provider’s own app or Finder.',
      canDelete: false,
      Icon: LockKeyhole
    };
  }

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

// The exact guard used by every Collector entry point (legend "+", context menu,
// drag-and-drop, `addToCollector` and `collectItem`). A node without a real
// filesystem path, or any cloud-managed node, is refused.
export function canCollect(node) {
  return Boolean(
    node
    && node.path
    && !String(node.path).startsWith('__')
    && getRiskInfo(node).canDelete
  );
}

// Smart Clean's "Add selected to Collector" routes each candidate through
// `collectItem`, so it shares the Collector guard. Named separately so the
// invariant is asserted for the export path explicitly.
export function canExportCandidate(candidate) {
  return canCollect(candidate);
}
