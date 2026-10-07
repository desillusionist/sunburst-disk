// Safety invariant: a cloud-managed node must be refused by every deletion
// entry point. The cloud walk marks every node it returns with `cloudManaged`,
// and this module is the single gate those entry points share, so proving the
// gate refuses a cloud node proves the Collector (legend "+", context menu,
// drag-and-drop), the details sidebar and Smart Clean export are all blocked.
import { describe, it, expect } from 'vitest';
import { getRiskInfo, canCollect, canExportCandidate, isStartupDataCategory } from './risk';

const cloudFile = {
  name: 'report.pdf',
  path: '/Users/x/Library/CloudStorage/GoogleDrive-a/My Drive/report.pdf',
  type: 'file',
  cloudManaged: true
};
const cloudDirectory = {
  name: 'My Drive',
  path: '/Users/x/Library/CloudStorage/GoogleDrive-a/My Drive',
  type: 'directory',
  cloudManaged: true
};
const cloudBundle = {
  name: 'Photos.photoslibrary',
  path: '/Users/x/Library/CloudStorage/GoogleDrive-a/My Drive/Photos.photoslibrary',
  type: 'directory',
  cloudManaged: true
};

const ordinaryFile = { name: 'notes.txt', path: '/Users/x/Documents/notes.txt', type: 'file' };
const ordinaryDirectory = { name: 'Projects', path: '/Users/x/Documents/Projects', type: 'directory' };
const systemItem = { name: 'System', path: '/System', type: 'directory' };
const hiddenSpace = { name: 'hidden space...', path: '__hidden__', type: 'special' };

describe('cloud read-only invariant', () => {
  it('classifies a cloud-managed node as refusing, for files and directories alike', () => {
    for (const node of [cloudFile, cloudDirectory, cloudBundle]) {
      const risk = getRiskInfo(node);
      expect(risk.canDelete, `${node.path} must not be deletable`).toBe(false);
      expect(risk.level).toBe('protected');
      expect(risk.label).toMatch(/read-only/i);
    }
  });

  it('blocks the Collector entry point', () => {
    expect(canCollect(cloudFile)).toBe(false);
    expect(canCollect(cloudDirectory)).toBe(false);
    expect(canCollect(cloudBundle)).toBe(false);
  });

  it('blocks Smart Clean export', () => {
    expect(canExportCandidate(cloudFile)).toBe(false);
    expect(canExportCandidate(cloudDirectory)).toBe(false);
  });

  it('blocks every deletion guard for a synthetic cloud root too', () => {
    const cloudRoot = {
      name: 'Google Drive — a@b.com',
      path: '/Users/x/Library/CloudStorage/GoogleDrive-a',
      type: 'directory',
      size: 512_000_000_000,
      cloudManaged: true,
      truncated: true,
      children: [cloudDirectory]
    };
    expect(getRiskInfo(cloudRoot).canDelete).toBe(false);
    expect(canCollect(cloudRoot)).toBe(false);
  });
});

describe('the gate is not over-broad', () => {
  it('still allows ordinary local content', () => {
    expect(getRiskInfo(ordinaryFile).canDelete).toBe(true);
    expect(getRiskInfo(ordinaryFile).level).toBe('safe');
    expect(canCollect(ordinaryFile)).toBe(true);
    expect(canCollect(ordinaryDirectory)).toBe(true);
    expect(canExportCandidate(ordinaryFile)).toBe(true);
  });

  it('still refuses protected system paths and virtual nodes without cloudManaged', () => {
    expect(getRiskInfo(systemItem).canDelete).toBe(false);
    expect(getRiskInfo(systemItem).label).toBe('Protected system item');
    expect(canCollect(systemItem)).toBe(false);
    expect(canCollect(hiddenSpace)).toBe(false);
    expect(canCollect(null)).toBe(false);
    expect(canCollect({ name: 'x', type: 'file' })).toBe(false);
  });

  it('keeps the startup Data-category rule intact', () => {
    expect(isStartupDataCategory({ path: '/System/Volumes/Data/System' })).toBe(true);
    expect(isStartupDataCategory({ path: '/System/Volumes/Data' })).toBe(false);
    expect(getRiskInfo({ name: 'System', path: '/System/Volumes/Data/System', type: 'directory' }).canDelete).toBe(false);
  });
});
