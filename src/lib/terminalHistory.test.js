import { describe, it, expect } from 'vitest';
import {
  loadTerminalHistory,
  saveTerminalHistory,
  TERMINAL_HISTORY_LIMIT
} from './terminalHistory';

function fakeStorage(initial) {
  const map = new Map(initial ? [['sunburst-disk.terminal-history', initial]] : []);
  return {
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, value),
    removeItem: key => map.delete(key)
  };
}

describe('terminal history persistence', () => {
  it('round-trips the commands that were run', () => {
    const storage = fakeStorage();
    expect(loadTerminalHistory(storage)).toEqual([]);
    saveTerminalHistory(storage, ['ls -la', 'du -sh .']);
    expect(loadTerminalHistory(storage)).toEqual(['ls -la', 'du -sh .']);
  });

  it('ignores a missing, malformed or non-array store', () => {
    expect(loadTerminalHistory(null)).toEqual([]);
    expect(loadTerminalHistory(fakeStorage('not json'))).toEqual([]);
    expect(loadTerminalHistory(fakeStorage('{"a":1}'))).toEqual([]);
    expect(loadTerminalHistory(fakeStorage('["ls", 7, "", "  ", "df -h"]'))).toEqual(['ls', 'df -h']);
  });

  it('keeps only the most recent entries', () => {
    const storage = fakeStorage();
    const history = Array.from({ length: TERMINAL_HISTORY_LIMIT + 12 }, (_, index) => `cmd-${index}`);
    saveTerminalHistory(storage, history);
    const loaded = loadTerminalHistory(storage);
    expect(loaded).toHaveLength(TERMINAL_HISTORY_LIMIT);
    expect(loaded.at(-1)).toBe(`cmd-${TERMINAL_HISTORY_LIMIT + 11}`);
    expect(loaded[0]).toBe('cmd-12');
  });

  it('survives a storage that throws', () => {
    const broken = {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
      removeItem: () => { throw new Error('denied'); }
    };
    expect(loadTerminalHistory(broken)).toEqual([]);
    expect(() => saveTerminalHistory(broken, ['ls'])).not.toThrow();
  });

  it('clears the store when history is emptied', () => {
    const storage = fakeStorage();
    saveTerminalHistory(storage, ['ls']);
    saveTerminalHistory(storage, []);
    expect(loadTerminalHistory(storage)).toEqual([]);
  });
});
