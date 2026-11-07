// Move & Symlink: confirmation gate, the bridge calls, and the undo toast.
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import pkg from '../package.json';
import App from './App';

vi.mock('./components/SunburstChart', () => ({
  default: () => <div data-testid="sunburst-chart" />
}));

const DRIVE = {
  filesystem: 'apfs',
  name: 'Macintosh HD',
  mount: '/',
  scanPath: '/',
  total: 1_000_000,
  free: 400_000,
  used: 600_000,
  usePercent: '60%',
  isStartup: true,
  isCustomFolder: false
};

function makeTree() {
  return {
    name: 'Macintosh HD',
    path: '/',
    type: 'directory',
    size: 3000,
    itemCount: 2,
    children: [
      { name: 'notes.txt', path: '/notes.txt', type: 'file', size: 10 },
      { name: 'Archive', path: '/Archive', type: 'directory', size: 2000, children: [] }
    ]
  };
}

function buildElectronAPI() {
  const noopUnsub = () => () => {};
  return {
    getDrives: vi.fn(async () => ({ drives: [DRIVE], userHome: '/Users/x' })),
    getCapacitySnapshot: vi.fn(async () => ({ df: { totalBytes: 1000000, usedBytes: 600000, availableBytes: 400000 } })),
    scanDirectory: vi.fn(async () => ({ tree: makeTree() })),
    scanSubdir: vi.fn(async () => ({ tree: makeTree() })),
    cancelScan: vi.fn(async () => ({ ok: true })),
    setWindowLayout: vi.fn(async () => ({ ok: true })),
    notifyScanComplete: vi.fn(async () => ({})),
    getPermissionStatus: vi.fn(async () => ({})),
    inspectItem: vi.fn(async () => ({ metadata: null })),
    inspectItems: vi.fn(async () => ({})),
    smartCleanPreview: vi.fn(async () => ({ ok: true, candidates: [], roots: [] })),
    chooseFolder: vi.fn(async () => ({
      ok: true,
      cancelled: false,
      folder: { name: 'Archive', mount: '/Volumes/External/Archive', scanPath: '/Volumes/External/Archive' }
    })),
    moveAndSymlink: vi.fn(async (itemPath, destinationDir) => ({
      ok: true,
      from: itemPath,
      to: `${destinationDir}/${itemPath.split('/').pop()}`
    })),
    undoMoveAndSymlink: vi.fn(async (from, to) => ({ ok: true, from: to, to: from })),
    onScanProgress: vi.fn(noopUnsub),
    onScanComplete: vi.fn(noopUnsub),
    onUpdateProgress: vi.fn(noopUnsub),
    onFolderWatchChange: vi.fn(noopUnsub),
    onFolderWatchStatus: vi.fn(noopUnsub),
    onQuickLookKey: vi.fn(noopUnsub),
    onAddToCollectorRequest: vi.fn(noopUnsub),
    onTogglePackageContentsRequest: vi.fn(noopUnsub)
  };
}

let confirmSpy;

beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem('sunburst-disk.onboarding-version', pkg.version);
  window.electronAPI = buildElectronAPI();
  confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
});

afterEach(() => {
  confirmSpy.mockRestore();
});

async function openLocalScan(user) {
  render(<App />);
  const scan = await screen.findByRole('button', { name: 'Scan' });
  await user.click(scan);
  await screen.findByText('notes.txt');
}

describe('Move & Symlink', () => {
  it('asks for a destination, confirms, then moves and offers undo', async () => {
    const user = userEvent.setup();
    await openLocalScan(user);

    fireEvent.contextMenu(screen.getByText('notes.txt').closest('.legend-row'));
    const action = await screen.findByText(/Move & Symlink/);
    await user.click(action);

    // The native panel is asked for a destination, starting beside the item.
    await waitFor(() => expect(window.electronAPI.chooseFolder).toHaveBeenCalled());
    expect(window.electronAPI.chooseFolder.mock.calls[0][1]).toBe('/');

    // Nothing happens until the confirmation is accepted.
    expect(confirmSpy).toHaveBeenCalled();
    await waitFor(() => expect(window.electronAPI.moveAndSymlink).toHaveBeenCalledWith(
      '/notes.txt',
      '/Volumes/External/Archive'
    ));

    // The toast names the move and offers a one-click undo.
    expect(await screen.findByText(/Moved .*notes\.txt/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(window.electronAPI.undoMoveAndSymlink).toHaveBeenCalledWith(
      '/notes.txt',
      '/Volumes/External/Archive/notes.txt'
    ));
  });

  it('does not move anything when the confirmation is cancelled', async () => {
    confirmSpy.mockReturnValue(false);
    const user = userEvent.setup();
    await openLocalScan(user);

    fireEvent.contextMenu(screen.getByText('notes.txt').closest('.legend-row'));
    await user.click(await screen.findByText(/Move & Symlink/));

    await waitFor(() => expect(confirmSpy).toHaveBeenCalled());
    expect(window.electronAPI.moveAndSymlink).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
  });

  it('reports a failed move instead of pretending it worked', async () => {
    window.electronAPI.moveAndSymlink = vi.fn(async () => ({ ok: false, error: 'Permission denied' }));
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const user = userEvent.setup();
    await openLocalScan(user);

    fireEvent.contextMenu(screen.getByText('notes.txt').closest('.legend-row'));
    await user.click(await screen.findByText(/Move & Symlink/));

    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('Permission denied'));
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
    alertSpy.mockRestore();
  });
});
