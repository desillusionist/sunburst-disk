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
  const truncated = Boolean(tree.truncated) || children.some(child => Boolean(child.truncated));
  return { ...tree, children, size, truncated: truncated || undefined };
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
