// End-to-end renderer flow for the read-only cloud view (v2a).
//
// This drives the real `App` in jsdom with a mocked `window.electronAPI` (the
// boundary the Rust core sits behind) and the canvas sunburst replaced by a
// stub, so the assertions cover the actual wiring: panel → Scan → cloud view.
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import pkg from '../package.json';
import App from './App';

vi.mock('./components/SunburstChart', () => ({
  default: () => <div data-testid="sunburst-chart" />
}));

const PROVIDER_PATH = '/Users/x/Library/CloudStorage/GoogleDrive-a';
const PROVIDER_NAME = 'Google Drive — a@b.com';
const CLOUD_TOTAL = 512_000_000_000;

// Fresh object per call: `handleScanDrive` renames the returned root in place.
function makeCloudTree() {
  return {
    name: 'GoogleDrive-a',
    path: PROVIDER_PATH,
    type: 'directory',
    size: CLOUD_TOTAL,
    itemCount: 1907,
    cloudManaged: true,
    truncated: true,
    children: [
      {
        name: 'My Drive',
        path: `${PROVIDER_PATH}/My Drive`,
        type: 'directory',
        size: 300_000_000_000,
        itemCount: 1800,
        cloudManaged: true,
        truncated: true,
        children: []
      },
      {
        name: 'Shared drives',
        path: `${PROVIDER_PATH}/Shared drives`,
        type: 'directory',
        size: 5_000_000_000,
        itemCount: 107,
        cloudManaged: true,
        children: []
      }
    ]
  };
}

function buildElectronAPI() {
  const noopUnsub = () => () => {};
  return {
    getDrives: vi.fn(async () => ({ drives: [], userHome: '/Users/x' })),
    getCapacitySnapshot: vi.fn(async () => ({ df: { totalBytes: 0, usedBytes: 0, availableBytes: 0 } })),
    scanDirectory: vi.fn(async () => ({ tree: makeCloudTree() })),
    scanSubdir: vi.fn(async () => ({ tree: { ...makeCloudTree(), children: [] } })),
    cancelScan: vi.fn(async () => ({ ok: true })),
    cloudStorageSurvey: vi.fn(async () => ({
      ok: true,
      sharesHomeFolders: false,
      notes: [],
      providers: [{
        id: 'GoogleDrive-a',
        name: PROVIDER_NAME,
        kind: 'provider',
        path: PROVIDER_PATH,
        cloudBytes: CLOUD_TOTAL,
        localBytes: 0,
        files: 1907,
        dataless: 1900,
        truncated: true,
        readable: true,
        largest: []
      }]
    })),
    cloudStorageClientState: vi.fn(async () => ({ ok: true, clientState: [] })),
    revealInFinder: vi.fn(async () => ({})),
    inspectItem: vi.fn(async () => ({ metadata: null })),
    inspectItems: vi.fn(async () => ({})),
    inspectAppRelated: vi.fn(async () => ({ resources: [] })),
    getPermissionStatus: vi.fn(async () => ({})),
    setWindowLayout: vi.fn(async () => ({ ok: true })),
    notifyScanComplete: vi.fn(async () => ({})),
    smartCleanPreview: vi.fn(async () => ({ ok: true, candidates: [], roots: [] })),
    onScanProgress: vi.fn(noopUnsub),
    onScanComplete: vi.fn(noopUnsub),
    onUpdateProgress: vi.fn(noopUnsub),
    onFolderWatchChange: vi.fn(noopUnsub),
    onFolderWatchStatus: vi.fn(noopUnsub),
    onQuickLookKey: vi.fn(noopUnsub),
    onAskSiriStart: vi.fn(noopUnsub),
    onAskSiriResult: vi.fn(noopUnsub),
    onAddToCollectorRequest: vi.fn(noopUnsub),
    onTogglePackageContentsRequest: vi.fn(noopUnsub)
  };
}

beforeEach(() => {
  window.localStorage.clear();
  // Skip the first-launch / after-update onboarding modal so the drives screen
  // is interactive.
  window.localStorage.setItem('sunburst-disk.onboarding-version', pkg.version);
  window.electronAPI = buildElectronAPI();
});

async function openCloudView(user) {
  render(<App />);
  await user.click(await screen.findByRole('button', { name: /cloud storage/i }));
  const providerScan = (await screen.findAllByRole('button', { name: 'Scan' }))[0];
  await user.click(providerScan);
}

describe('cloud view flow', () => {
  it('opens a read-only cloud view: the drawer closes and the banner + count render', async () => {
    const user = userEvent.setup();
    await openCloudView(user);

    // The Cloud Storage drawer is dismissed.
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: /cloud storage/i })).toBeNull();
    });

    // The read-only banner is present and names the provider.
    const banner = await screen.findByText(/Cloud content · read-only/i);
    expect(banner).toBeTruthy();
    const providerNamePattern = new RegExp(PROVIDER_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    expect(screen.getAllByText(providerNamePattern).length).toBeGreaterThan(0);
    // Size semantics: it says this is cloud content, not on-disk usage.
    expect(screen.getByText(/not the space it uses on this Mac/i)).toBeTruthy();
    expect(screen.getByText(/lower bounds/i)).toBeTruthy();
    // The dashboard legend carries the same "not on-disk" label.
    expect(screen.getByText(/cloud content \(not on-disk\)/i)).toBeTruthy();

    // The chart is rendered and the legend's cloud-content row carries the total
    // logical cloud size -- as a lower bound, because the snapshot was partial.
    expect(screen.getByTestId('sunburst-chart')).toBeTruthy();
    const cloudContentRow = screen.getByText(/cloud content \(not on-disk\)/i).closest('.legend-row');
    expect(cloudContentRow).toBeTruthy();
    expect(cloudContentRow.textContent).toContain('512 GB');
    expect(screen.getAllByText('≥ 512 GB').length).toBeGreaterThan(0);

    // The scan actually ran in cloud mode against the provider path.
    const calls = window.electronAPI.scanDirectory.mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe(PROVIDER_PATH);
    expect(calls[0][3]).toBe(true);
  });

  it('disables Collector for every cloud item and shows the read-only risk', async () => {
    const user = userEvent.setup();
    await openCloudView(user);
    await screen.findByText(/Cloud content · read-only/i);

    // Legend "+" buttons exist per child and are all disabled.
    const plusButtons = screen.getAllByTitle('Add to collector');
    expect(plusButtons.length).toBe(2);
    plusButtons.forEach(button => expect(button.disabled).toBe(true));

    // The details sidebar refuses deletion for the focused cloud node.
    expect(screen.getByText('Deletion disabled')).toBeTruthy();
    expect(screen.getAllByText(/Cloud item — read-only/i).length).toBeGreaterThan(0);

    // The local free-space / capacity rows are not shown in cloud view.
    expect(screen.queryByText(/^free space$/i)).toBeNull();
  });

  it('re-walks a partially-scanned cloud folder in full when it is opened', async () => {
    const user = userEvent.setup();
    // The bounded provider scan leaves `My Drive` partial, with a partial child.
    window.electronAPI.scanDirectory.mockResolvedValue({
      tree: {
        name: 'GoogleDrive-a',
        path: PROVIDER_PATH,
        type: 'directory',
        size: 0,
        itemCount: 2,
        cloudManaged: true,
        truncated: true,
        children: [{
          name: 'My Drive',
          path: `${PROVIDER_PATH}/My Drive`,
          type: 'directory',
          size: 0,
          itemCount: 1,
          cloudManaged: true,
          truncated: true,
          children: [{
            name: 'partial-child',
            path: `${PROVIDER_PATH}/My Drive/partial-child`,
            type: 'directory',
            size: 0,
            itemCount: 0,
            cloudManaged: true,
            truncated: true,
            children: []
          }]
        }]
      }
    });
    // Opening a folder triggers a full (unbounded) cloud re-walk.
    window.electronAPI.scanSubdir.mockImplementation(async (targetPath) => ({
      tree: {
        name: 'My Drive',
        path: targetPath,
        type: 'directory',
        size: 5_000_000_000,
        itemCount: 2,
        cloudManaged: true,
        children: [{
          name: 'sub',
          path: `${targetPath}/sub`,
          type: 'directory',
          size: 5_000_000_000,
          itemCount: 1,
          cloudManaged: true,
          children: []
        }]
      }
    }));

    await openCloudView(user);
    await screen.findByText(/Cloud content · read-only/i);

    // Before opening: the folder reads as a lower bound, not a number.
    const partialRow = screen.getByText('My Drive').closest('.legend-row');
    expect(partialRow.textContent).toContain('partial');

    await user.click(partialRow);

    // Opening it re-walks the folder (cloud mode, cancellable request id) ...
    await waitFor(() => expect(window.electronAPI.scanSubdir).toHaveBeenCalled());
    const call = window.electronAPI.scanSubdir.mock.calls.at(-1);
    expect(call[0]).toBe(`${PROVIDER_PATH}/My Drive`);
    expect(call[2]).toBe(true);
    expect(typeof call[3]).toBe('string');

    // ... and now every child shows a real size.
    await waitFor(() => {
      const row = screen.getByText('sub').closest('.legend-row');
      expect(row.textContent).toContain('5.0 GB');
    });
  });

  it('falls back to a lower bound when the folder cap binds, and offers Calculate exact size', async () => {
    const user = userEvent.setup();
    const partial = (name, size) => ({
      name,
      path: `${PROVIDER_PATH}/My Drive/${name}`,
      type: 'directory',
      size,
      itemCount: 0,
      cloudManaged: true,
      truncated: true,
      children: []
    });

    window.electronAPI.scanDirectory.mockResolvedValue({
      tree: {
        name: 'GoogleDrive-a',
        path: PROVIDER_PATH,
        type: 'directory',
        size: 0,
        itemCount: 1,
        cloudManaged: true,
        truncated: true,
        children: [{
          name: 'My Drive',
          path: `${PROVIDER_PATH}/My Drive`,
          type: 'directory',
          size: 0,
          itemCount: 1,
          cloudManaged: true,
          truncated: true,
          children: [partial('partial-child', 0)]
        }]
      }
    });

    // Capped folder open (exact=false) stays partial; the opt-in exact walk completes.
    window.electronAPI.scanSubdir.mockImplementation(async (targetPath, _pkg, _cloud, _id, exact) => ({
      tree: exact
        ? {
          name: 'My Drive',
          path: targetPath,
          type: 'directory',
          size: 5_000_000_000,
          itemCount: 2,
          cloudManaged: true,
          children: [{
            name: 'sub',
            path: `${targetPath}/sub`,
            type: 'directory',
            size: 5_000_000_000,
            itemCount: 1,
            cloudManaged: true,
            children: []
          }]
        }
        : {
          name: 'My Drive',
          path: targetPath,
          type: 'directory',
          size: 0,
          itemCount: 1,
          cloudManaged: true,
          truncated: true,
          children: [partial('partial-child', 0)]
        }
    }));

    await openCloudView(user);
    await screen.findByText(/Cloud content · read-only/i);

    // Open the folder: the default walk is capped (exact is not requested).
    await user.click(screen.getByText('My Drive').closest('.legend-row'));
    await waitFor(() => expect(window.electronAPI.scanSubdir).toHaveBeenCalled());
    const cappedCall = window.electronAPI.scanSubdir.mock.calls.at(-1);
    expect(cappedCall[2]).toBe(true);
    expect(cappedCall[4]).toBeFalsy();

    // The cap bound, so the folder reads as a lower bound and offers the opt-in.
    const exactButton = await screen.findByRole('button', { name: /calculate exact size/i });
    expect(screen.getAllByText('partial').length).toBeGreaterThan(0);

    await user.click(exactButton);
    await waitFor(() => expect(window.electronAPI.scanSubdir.mock.calls.at(-1)[4]).toBe(true));

    // Now it is exact: a real figure, and the action is gone.
    await waitFor(() => {
      expect(screen.getByText('sub').closest('.legend-row').textContent).toContain('5.0 GB');
    });
    expect(screen.queryByRole('button', { name: /calculate exact size/i })).toBeNull();
  });
});
