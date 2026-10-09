// Cloud-tree display rules (v2a).
//
// The Rust cloud walk is bounded, so its tree is partial: any directory it did
// not fully enumerate carries `truncated: true` and its size is a **lower
// bound**. Two renderer-side rules keep the displayed hierarchy honest:
//
//   1. A directory's size is the sum of its children's sizes. The Rust walk
//      already guarantees this (it never counts a directory's own inode size),
//      but a lazily *enriched* child grows after the fact, so its ancestors are
//      recomputed here -- a child can never be shown larger than its parent.
//   2. Truncation propagates upward: if any descendant is partial, the ancestor
//      is partial too, and its total is shown as a lower bound.

// Recompute `size` (and propagate `truncated`) for every ancestor of
// `targetPath`, bottom-up. Returns a new tree only when the target is a
// descendant of `tree`; otherwise it returns `tree` unchanged.
export function recomputeAncestorSizes(tree, targetPath) {
  if (!tree || !tree.path || tree.path === targetPath) return tree;
  if (!tree.children || tree.children.length === 0) return tree;

  let touched = false;
  const children = tree.children.map(child => {
    if (child.path === targetPath) {
      touched = true;
      return child;
    }
    const updated = recomputeAncestorSizes(child, targetPath);
    if (updated !== child) touched = true;
    return updated;
  });
  if (!touched) return tree;

  const size = children.reduce((sum, child) => sum + (Number(child.size) || 0), 0);
  // The on-this-Mac figure rolls up exactly like the size: a directory's local
  // bytes are the sum of its children's, recomputed here so an enriched child
  // never leaves a stale ancestor behind. It is never read from the directory's
  // own lstat, matching the Rust walk's invariant.
  const localBytes = children.reduce((sum, child) => sum + (Number(child.localBytes) || 0), 0);
  const truncated = Boolean(tree.truncated) || children.some(child => Boolean(child.truncated));
  return { ...tree, children, size, localBytes, truncated: truncated || undefined };
}

// A node's size for display. Partial (un-fully-walked) cloud directories must
// not read as authoritative figures: a positive lower bound is prefixed with
// "≥", and a directory we have not loaded at all reads as "partial" rather than
// a misleading small number.
export function nodeSizeLabel(node, formatBytes) {
  const partial = Boolean(node?.truncated);
  const size = Number(node?.size) || 0;
  if (partial && size === 0) {
    return { text: 'partial', partial: true, title: 'Not fully loaded — open this folder to load more' };
  }
  if (partial) {
    return { text: `≥ ${formatBytes(size)}`, partial: true, title: 'Lower bound — the cloud scan stopped before finishing this folder' };
  }
  return { text: formatBytes(size), partial: false, title: undefined };
}

// "Available offline"/"available online": a cloud item is available offline when
// some of its bytes are actually on this Mac (`st_blocks > 0`), and available
// online when they are not (a dataless placeholder that lives only in the
// provider). These are pure display predicates -- testing them never triggers a
// download, and they are the only sense in which this feature touches "offline".
export function isAvailableOffline(node) {
  return (Number(node?.localBytes) || 0) > 0;
}

export function isAvailableOnline(node) {
  return (Number(node?.localBytes) || 0) === 0;
}

// The short provider name shown in the cloud-trash UI, derived from the provider
// folder (so an iCloud or Dropbox view never says "Google Drive").
const PROVIDER_LABELS = [
  ['GoogleDrive', 'Google Drive'],
  ['OneDrive', 'OneDrive'],
  ['Dropbox', 'Dropbox'],
  ['Box', 'Box'],
  ['pCloud', 'pCloud'],
  ['SharePoint', 'SharePoint']
];

export function cloudProviderLabel(source) {
  const path = String(source || '');
  const name = path.replace(/\/+$/, '').split('/').pop() || '';
  for (const [prefix, label] of PROVIDER_LABELS) {
    if (name.startsWith(prefix)) return label;
  }
  if (path.includes('/Mobile Documents/') || name === 'com~apple~CloudDocs') return 'iCloud Drive';
  return name || 'your provider';
}

// Where a cloud-trash action actually sends an item, and how the user recovers it.
// Google Drive has its own Trash; iCloud Drive uses "Recently Deleted" (in the
// Files app or at iCloud.com). Both keep items for about 30 days. Everything the
// cloud-trash UI says derives from this, so no screen can name the wrong
// destination (e.g. "iCloud Drive Trash", which does not exist).
export function cloudTrashDestination(providerName) {
  return providerName === 'iCloud Drive' ? 'Recently Deleted' : `${providerName} Trash`;
}

export function cloudRecoveryCopy(providerName) {
  const destination = cloudTrashDestination(providerName);
  // iCloud's recovery point is not a "Trash" -- name the actual place.
  const via = providerName === 'iCloud Drive' ? ' (in the Files app or at iCloud.com)' : '';
  return {
    destination,
    moved: `moved to ${destination}`,
    recoverable: `Recoverable from ${destination}${via} for ~30 days`,
    note: `Recover from ${destination}${via} for ~30 days — not an in-app undo, and not local Trash. This does not free local disk space.`
  };
}

// The Google Drive Trash URL for the account behind a CloudStorage provider
// folder. The provider folder is named `GoogleDrive-<email>`, and Google honours
// `?authuser=<email>` (an account email, not a positional /u/N index), so the
// button follows whichever Drive is being viewed and stays correct when accounts
// are added or removed. Non-Google providers fall back to the account-agnostic URL.
export function googleDriveTrashUrl(providerPath) {
  const name = String(providerPath || '').replace(/\/+$/, '').split('/').pop() || '';
  const match = /^GoogleDrive-(.+)$/.exec(name);
  if (match) {
    return `https://drive.google.com/drive/trash?authuser=${encodeURIComponent(match[1])}`;
  }
  return 'https://drive.google.com/drive/trash';
}
