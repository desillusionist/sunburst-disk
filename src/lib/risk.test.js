// Safety invariant: a cloud-managed node is refused by every *local* deletion
// entry point, and the only cloud capability is the explicit, separate
// `canTrashCloud` allowance (consumed solely by the cloud basket). The cloud walk
// marks every node it returns with `cloudManaged`, and this module is the single
// gate those entry points share.
import { describe, it, expect } from 'vitest';
import { getRiskInfo, canCollect, canCloudBasket, canExportCandidate, isStartupDataCategory } from './risk';

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

describe('cloud capability boundary', () => {
  it('refuses local deletion for every cloud node, but grants the cloud-basket allowance', () => {
    for (const node of [cloudFile, cloudDirectory, cloudBundle]) {
      const risk = getRiskInfo(node);
      expect(risk.canDelete, `${node.path} must not be locally deletable`).toBe(false);
      expect(risk.canTrashCloud, `${node.path} must be cloud-trashable`).toBe(true);
      expect(risk.level).toBe('protected');
      expect(risk.label).toMatch(/trash only/i);
    }
  });

  it('still blocks the local Collector and Smart Clean export', () => {
    expect(canCollect(cloudFile)).toBe(false);
    expect(canCollect(cloudDirectory)).toBe(false);
    expect(canCollect(cloudBundle)).toBe(false);
    expect(canExportCandidate(cloudFile)).toBe(false);
    expect(canExportCandidate(cloudDirectory)).toBe(false);
  });

  it('allows the cloud basket for cloud items only', () => {
    expect(canCloudBasket(cloudFile)).toBe(true);
    expect(canCloudBasket(cloudDirectory)).toBe(true);
    expect(canCloudBasket(cloudBundle)).toBe(true);
    // Everything that is not a cloud item stays out of the cloud basket.
    expect(canCloudBasket(ordinaryFile)).toBe(false);
    expect(canCloudBasket(ordinaryDirectory)).toBe(false);
    expect(canCloudBasket(systemItem)).toBe(false);
    expect(canCloudBasket(hiddenSpace)).toBe(false);
    expect(canCloudBasket(null)).toBe(false);
    expect(canCloudBasket({ name: 'x', type: 'file' })).toBe(false);
  });

  it('keeps the cloud root out of the Collector but in the cloud basket', () => {
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
    expect(getRiskInfo(cloudRoot).canTrashCloud).toBe(true);
    expect(canCollect(cloudRoot)).toBe(false);
    expect(canCloudBasket(cloudRoot)).toBe(true);
  });
});

describe('the gate is not over-broad', () => {
  it('still allows ordinary local content', () => {
    expect(getRiskInfo(ordinaryFile).canDelete).toBe(true);
    expect(getRiskInfo(ordinaryFile).canTrashCloud).toBe(false);
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
