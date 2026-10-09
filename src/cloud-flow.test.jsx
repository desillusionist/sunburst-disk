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
    localBytes: 2_000_000_000,
    children: [
      {
        name: 'My Drive',
        path: `${PROVIDER_PATH}/My Drive`,
        type: 'directory',
        size: 300_000_000_000,
        itemCount: 1800,
        cloudManaged: true,
        truncated: true,
        localBytes: 2_000_000_000,
        children: []
      },
      {
        name: 'Shared drives',
        path: `${PROVIDER_PATH}/Shared drives`,
        type: 'directory',
        size: 5_000_000_000,
        itemCount: 107,
        cloudManaged: true,
        localBytes: 0,
        children: []
      }
    ]
  };
}

// A minimal iCloud Drive provider, used to prove that every cloud-trash string
// follows the detected provider rather than a hard-coded "Google Drive".
const ICLOUD_PATH = '/Users/x/Library/Mobile Documents/com~apple~CloudDocs';

function makeICloudTree() {
  return {
    name: 'com~apple~CloudDocs',
    path: ICLOUD_PATH,
    type: 'directory',
    size: CLOUD_TOTAL,
    itemCount: 120,
    cloudManaged: true,
    truncated: true,
    localBytes: 0,
    children: [
      {
        name: 'Documents',
        path: `${ICLOUD_PATH}/Documents`,
        type: 'directory',
        size: 10_000_000_000,
        itemCount: 100,
        cloudManaged: true,
        localBytes: 0,
        children: []
      },
      {
        name: 'Desktop',
        path: `${ICLOUD_PATH}/Desktop`,
        type: 'directory',
        size: 5_000_000_000,
        itemCount: 20,
        cloudManaged: true,
        localBytes: 0,
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
    trashCloudItems: vi.fn(async (items) => ({
      results: (items || []).map(item => ({ path: item.path, name: item.name, success: true })),
      canceled: false,
      total: (items || []).length,
      succeeded: (items || []).length,
      failed: 0
    })),
    openExternalUrl: vi.fn(async () => ({ ok: true })),
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
    onCloudTrashProgress: vi.fn(noopUnsub),
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

  it('lets the read-only notice be dismissed', async () => {
    const user = userEvent.setup();
    await openCloudView(user);
    await screen.findByText(/Cloud content · read-only/i);

    await user.click(screen.getByRole('button', { name: /dismiss cloud content notice/i }));
    await waitFor(() => {
      expect(screen.queryByText(/Cloud content · read-only/i)).toBeNull();
    });
  });

  it('shows an on-this-Mac total and per-row badges for locally-stored items', async () => {
    const user = userEvent.setup();
    await openCloudView(user);
    await screen.findByText(/Cloud content · read-only/i);

    // The header carries an "on this Mac" total beside the cloud size.
    const headerLocal = document.querySelector('.legend-local-total');
    expect(headerLocal).toBeTruthy();
    expect(headerLocal.textContent).toMatch(/on this Mac/i);
    // Only the child with local bytes gets a per-row badge; the cloud-only one
    // does not.
    const myDriveRow = screen.getByText('My Drive').closest('.legend-row');
    expect(myDriveRow.querySelector('.legend-local-badge')).toBeTruthy();
    const sharedRow = screen.getByText('Shared drives').closest('.legend-row');
    expect(sharedRow.querySelector('.legend-local-badge')).toBeNull();
  });

  it('filters the list by availability from the Type section', async () => {
    const user = userEvent.setup();
    await openCloudView(user);
    await screen.findByText(/Cloud content · read-only/i);

    // Both rows show before filtering.
    expect(screen.getByText('My Drive')).toBeTruthy();
    expect(screen.getByText('Shared drives')).toBeTruthy();

    // "Available Offline" (in the Type section) hides the cloud-only row.
    await user.click(screen.getByRole('button', { name: /sort and filter/i }));
    await user.click(await screen.findByRole('checkbox', { name: /available offline/i }));
    await waitFor(() => expect(screen.queryByText('Shared drives')).toBeNull());
    expect(screen.getByText('My Drive')).toBeTruthy();

    // Switch to "Available Online": the locally-stored row is hidden instead.
    await user.click(screen.getByRole('checkbox', { name: /available offline/i }));
    await user.click(screen.getByRole('checkbox', { name: /available online/i }));
    await waitFor(() => expect(screen.queryByText('My Drive')).toBeNull());
    expect(screen.getByText('Shared drives')).toBeTruthy();
  });

  it('keeps cloud items out of the local Collector but stages them in the cloud basket', async () => {
    const user = userEvent.setup();
    await openCloudView(user);
    await screen.findByText(/Cloud content · read-only/i);

    // The legend "+" now stages into the cloud basket, and is enabled for cloud rows.
    const plusButtons = screen.getAllByTitle('Add to Google Drive Trash basket');
    expect(plusButtons.length).toBe(2);
    plusButtons.forEach(button => expect(button.disabled).toBe(false));

    // The local Collector is still refused for a cloud node.
    expect(screen.getByText('Deletion disabled')).toBeTruthy();
    expect(screen.getAllByText(/Cloud item — Trash only/i).length).toBeGreaterThan(0);

    // The local free-space / capacity rows are not shown in cloud view.
    expect(screen.queryByText(/^free space$/i)).toBeNull();
  });

  it('trashes the basket only after the count is typed (two-step gate)', async () => {
    const user = userEvent.setup();
    await openCloudView(user);
    await screen.findByText(/Cloud content · read-only/i);

    // Stage one row.
    await user.click(screen.getAllByTitle('Add to Google Drive Trash basket')[0]);
    expect(await screen.findByText(/1 item/i)).toBeTruthy();

    // Open the confirmation; the move button is disabled until the count matches.
    await user.click(screen.getByRole('button', { name: /move to google drive trash/i }));
    await waitFor(() => expect(document.querySelector('.cloud-trash-confirm')).toBeTruthy());
    expect(document.querySelector('.cloud-trash-confirm-go').disabled).toBe(true);
    expect(window.electronAPI.trashCloudItems).not.toHaveBeenCalled();

    // Wrong count keeps it disabled; the exact count enables it.
    await user.type(document.querySelector('.cloud-trash-confirm-typed input'), '2');
    expect(document.querySelector('.cloud-trash-confirm-go').disabled).toBe(true);
    await user.clear(document.querySelector('.cloud-trash-confirm-typed input'));
    await user.type(document.querySelector('.cloud-trash-confirm-typed input'), '1');
    await waitFor(() => expect(document.querySelector('.cloud-trash-confirm-go').disabled).toBe(false));

    await user.click(document.querySelector('.cloud-trash-confirm-go'));
    await waitFor(() => expect(window.electronAPI.trashCloudItems).toHaveBeenCalledTimes(1));
    const [items] = window.electronAPI.trashCloudItems.mock.calls[0];
    expect(items).toHaveLength(1);
    expect(items[0].path).toBe(`${PROVIDER_PATH}/My Drive`);
  });

  it('undoes basket staging with ⌘Z and never trashes', async () => {
    const user = userEvent.setup();
    await openCloudView(user);
    await screen.findByText(/Cloud content · read-only/i);

    await user.click(screen.getAllByTitle('Add to Google Drive Trash basket')[0]);
    await user.click(screen.getAllByTitle('Add to Google Drive Trash basket')[1]);
    expect(await screen.findByText(/2 items/i)).toBeTruthy();

    // ⌘Z walks the staging history back, one step per press.
    await user.keyboard('{Meta>}z{/Meta}');
    await waitFor(() => expect(screen.getByText(/1 item/i)).toBeTruthy());
    await user.keyboard('{Meta>}z{/Meta}');
    await waitFor(() => expect(screen.queryByText(/\d+ items?/i)).toBeNull());

    // Staging undo is local-only: nothing was ever sent to trash.
    expect(window.electronAPI.trashCloudItems).not.toHaveBeenCalled();
  });

  it('derives the confirm button, title, body and recovery wording from the provider (iCloud → Recently Deleted)', async () => {
    const user = userEvent.setup();

    // Scan an iCloud provider instead of the Google fixture. The confirm *button*
    // is the part that regressed to a hard-coded "Google Drive" once already, so
    // it is asserted explicitly alongside the title and body.
    window.electronAPI.cloudStorageSurvey = vi.fn(async () => ({
      ok: true,
      sharesHomeFolders: false,
      notes: [],
      providers: [{
        id: 'icloud-drive',
        name: 'iCloud Drive',
        kind: 'icloud',
        path: ICLOUD_PATH,
        cloudBytes: CLOUD_TOTAL,
        localBytes: 0,
        files: 120,
        dataless: 120,
        truncated: true,
        readable: true,
        largest: []
      }]
    }));
    window.electronAPI.scanDirectory = vi.fn(async () => ({ tree: makeICloudTree() }));

    await openCloudView(user);
    await screen.findByText(/Cloud content · read-only/i);

    // The legend "+" is provider-derived too -- and names the real destination.
    await user.click(screen.getAllByTitle('Add to Recently Deleted basket')[0]);
    expect(await screen.findByText(/1 item/i)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: /move to recently deleted/i }));
    await waitFor(() => expect(document.querySelector('.cloud-trash-confirm')).toBeTruthy());

    const dialog = document.querySelector('.cloud-trash-confirm');
    const goButton = dialog.querySelector('.cloud-trash-confirm-go');
    // The button is the label that was previously missed and must be provider-derived.
    expect(goButton.textContent.trim()).toBe('Move to Recently Deleted');
    expect(dialog.querySelector('.cloud-trash-confirm-title').textContent).toContain('to Recently Deleted?');
    expect(dialog.querySelector('.cloud-trash-confirm-body').textContent)
      .toContain('Recoverable from Recently Deleted (in the Files app or at iCloud.com)');
    // iCloud's recovery point is "Recently Deleted", never an "iCloud Drive Trash".
    expect(dialog.textContent).not.toContain('iCloud Drive Trash');
    expect(dialog.textContent).not.toContain('Google Drive');

    // Run the batch: the success/result wording must be provider-correct too.
    await user.type(dialog.querySelector('.cloud-trash-confirm-typed input'), '1');
    await user.click(goButton);
    await waitFor(() => expect(document.querySelector('.cloud-basket-result')).toBeTruthy());
    const result = document.querySelector('.cloud-basket-result');
    expect(result.textContent).toContain('moved to Recently Deleted');
    expect(result.textContent).toContain('Recover from Recently Deleted (in the Files app or at iCloud.com)');
    expect(result.textContent).not.toContain('iCloud Drive Trash');
    expect(result.textContent).not.toContain('Google Drive');
    // iCloud has no web Trash page, so no "Open ... Trash" button is offered.
    expect(result.querySelector('.cloud-basket-result-actions').textContent).not.toContain('Open');
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
