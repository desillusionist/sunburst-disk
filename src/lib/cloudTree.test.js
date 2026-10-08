// Renderer-side size accounting for partial cloud trees.
//
// The Rust walk is bounded, so a cloud tree is partial by construction. These
// tests pin the two renderer rules that keep the displayed hierarchy honest
// after a lazy drill-down: no parent smaller than a child, and a parent total
// that equals the sum of the children actually shown, with partial sub-trees
// labelled as lower bounds.
import { describe, it, expect } from 'vitest';
import { recomputeAncestorSizes, nodeSizeLabel, isAvailableOffline, isAvailableOnline } from './cloudTree';

const formatBytes = bytes => `${bytes} B`;

// A truncated cloud folder: `big` was un-walked when the scan was cut, so it
// carries size 0 and is flagged partial, as are its un-enumerated siblings.
function truncatedTree() {
  return {
    name: 'a folder',
    path: '/root',
    type: 'directory',
    size: 0,
    truncated: true,
    children: [
      { name: 'big', path: '/root/big', type: 'directory', size: 0, truncated: true, children: [] },
      { name: 'sib1', path: '/root/sib1', type: 'directory', size: 0, truncated: true, children: [] },
      { name: 'sib2', path: '/root/sib2', type: 'directory', size: 0, truncated: true, children: [] }
    ]
  };
}

function enrich(tree, path, size) {
  return {
    ...tree,
    children: tree.children.map(child => (
      child.path === path ? { ...child, size, truncated: undefined } : child
    ))
  };
}

describe('cloud tree size accounting', () => {
  it('recomputes ancestors so an enriched child never exceeds its parent', () => {
    const tree = enrich(truncatedTree(), '/root/big', 586_000_000_000);
    const next = recomputeAncestorSizes(tree, '/root/big');

    const maxChild = Math.max(...next.children.map(child => Number(child.size) || 0));
    expect(next.size).toBeGreaterThanOrEqual(maxChild);
    expect(next.size).toBe(586_000_000_000);
    expect(next.truncated).toBe(true);
  });

  it('keeps the parent total equal to the sum of the displayed children', () => {
    let tree = enrich(truncatedTree(), '/root/big', 586_000_000_000);
    tree = enrich(tree, '/root/sib1', 4_000_000);
    const next = recomputeAncestorSizes(tree, '/root/sib1');

    const shown = next.children.reduce((sum, child) => sum + (Number(child.size) || 0), 0);
    expect(next.size).toBe(shown);
    expect(next.size).toBe(586_000_000_000 + 4_000_000);
  });

  it('propagates truncation upward when a descendant is partial', () => {
    // Root starts un-truncated; enriching one child with a partial sub-walk must
    // mark the root partial again.
    const tree = {
      name: 'root',
      path: '/r',
      type: 'directory',
      size: 10,
      children: [
        { name: 'a', path: '/r/a', type: 'directory', size: 10, truncated: true, children: [] }
      ]
    };
    const next = recomputeAncestorSizes(tree, '/r/a');
    expect(next.truncated).toBe(true);
  });

  it('is a no-op when the target is not a descendant', () => {
    const tree = truncatedTree();
    expect(recomputeAncestorSizes(tree, '/elsewhere')).toBe(tree);
  });

  it('rolls local bytes up from the children, never from the node itself', () => {
    // The root carries a bogus "own" localBytes (as a directory inode would);
    // the recomputed value must be the sum of the children instead.
    const tree = {
      name: 'root',
      path: '/root',
      type: 'directory',
      size: 300,
      localBytes: 999_999,
      children: [
        { name: 'a', path: '/root/a', type: 'directory', size: 100, localBytes: 40, children: [] },
        { name: 'b', path: '/root/b', type: 'file', size: 200, localBytes: 60, children: [] }
      ]
    };
    const next = recomputeAncestorSizes(tree, '/root/a');
    expect(next.localBytes).toBe(100);
  });

  it('recomputes local bytes on every ancestor of a deep target', () => {
    const tree = {
      name: 'root',
      path: '/r',
      type: 'directory',
      size: 0,
      localBytes: 0,
      children: [{
        name: 'mid',
        path: '/r/mid',
        type: 'directory',
        size: 0,
        localBytes: 0,
        children: [
          { name: 'leaf', path: '/r/mid/leaf', type: 'file', size: 10, localBytes: 10, children: [] }
        ]
      }]
    };
    const next = recomputeAncestorSizes(tree, '/r/mid/leaf');
    expect(next.children[0].localBytes).toBe(10);
    expect(next.localBytes).toBe(10);
  });
});

describe('partial size labels', () => {
  it('never shows a precise number for an un-walked folder', () => {
    expect(nodeSizeLabel({ size: 0, truncated: true }, formatBytes)).toMatchObject({ text: 'partial', partial: true });
    expect(nodeSizeLabel({ size: 2_100_000, truncated: true }, formatBytes)).toMatchObject({ text: '≥ 2100000 B', partial: true });
  });

  it('shows a precise size for a fully-walked node', () => {
    const label = nodeSizeLabel({ size: 42, type: 'file' }, formatBytes);
    expect(label.partial).toBe(false);
    expect(label.text).toBe('42 B');
  });
});

describe('cloud availability filters', () => {
  it('treats any on-disk bytes as available offline', () => {
    expect(isAvailableOffline({ localBytes: 1 })).toBe(true);
    expect(isAvailableOffline({ localBytes: 4096 })).toBe(true);
  });

  it('excludes a dataless placeholder, which has no local bytes', () => {
    expect(isAvailableOffline({ localBytes: 0 })).toBe(false);
    expect(isAvailableOffline({ localBytes: '0' })).toBe(false);
    expect(isAvailableOffline({})).toBe(false);
  });

  it('treats no local bytes as available online', () => {
    expect(isAvailableOnline({ localBytes: 0 })).toBe(true);
    expect(isAvailableOnline({ localBytes: '0' })).toBe(true);
    expect(isAvailableOnline({})).toBe(true);
    expect(isAvailableOnline({ localBytes: 4096 })).toBe(false);
  });

  it('offline and online are exact complements', () => {
    for (const node of [{ localBytes: 0 }, { localBytes: 4096 }, {}, { localBytes: 1 }]) {
      expect(isAvailableOffline(node)).toBe(!isAvailableOnline(node));
    }
  });
});
