// Terminal command history, persisted for the next session.
//
// Only the commands the user chose to run are stored — never output, never a
// password — and the helper degrades to an in-memory list when storage is
// unavailable (private mode, quota, disabled storage).

const STORAGE_KEY = 'sunburst-disk.terminal-history';
export const TERMINAL_HISTORY_LIMIT = 100;

export function terminalHistoryStorage() {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

function clean(history) {
  return (Array.isArray(history) ? history : [])
    .filter(entry => typeof entry === 'string' && entry.trim())
    .slice(-TERMINAL_HISTORY_LIMIT);
}

export function loadTerminalHistory(storage) {
  try {
    const raw = storage?.getItem?.(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? clean(parsed) : [];
  } catch {
    return [];
  }
}

export function saveTerminalHistory(storage, history) {
  try {
    const entries = clean(history);
    if (!entries.length) {
      storage?.removeItem?.(STORAGE_KEY);
    } else {
      storage?.setItem?.(STORAGE_KEY, JSON.stringify(entries));
    }
  } catch {
    // History is a convenience; a full or unavailable store must never break a run.
  }
}
