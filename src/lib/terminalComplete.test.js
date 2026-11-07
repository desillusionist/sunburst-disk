import { describe, it, expect } from 'vitest';
import {
  normalizePath,
  tokenizeWithSpans,
  tokenAtCursor,
  splitPathToken,
  resolveDirPath,
  findNodeByPath,
  pathSuggestions,
  commandSuggestions,
  flagSuggestions,
  historySuggestion,
  completionFor
} from './terminalComplete';

const tree = {
  name: 'projects',
  path: '/Users/me/projects',
  type: 'directory',
  children: [
    { name: 'Photos', path: '/Users/me/projects/Photos', type: 'directory', size: 900, children: [] },
    { name: 'notes.md', path: '/Users/me/projects/notes.md', type: 'file', size: 10 },
    { name: 'Photoshop.txt', path: '/Users/me/projects/Photoshop.txt', type: 'file', size: 5 }
  ]
};

const presets = [
  { command: 'pwd' },
  { command: 'ls -lah' },
  { command: 'du -sh .' },
  { command: 'df -h' },
  { command: 'clear' }
];

const adminPresets = [
  { command: 'touch new-file.txt' },
  { command: 'mkdir -p new-folder' },
  { command: 'cp -R -- a b' }
];

describe('normalizePath', () => {
  it('collapses dot segments and duplicate slashes', () => {
    expect(normalizePath('/Users/me/../me/./x/')).toBe('/Users/me/x');
    expect(normalizePath('/')).toBe('/');
    expect(normalizePath('')).toBe('/');
  });
});

describe('tokenizing', () => {
  it('keeps quoted spans together and reports offsets', () => {
    expect(tokenizeWithSpans('ls "My Folder" x')).toEqual([
      { text: 'ls', start: 0, end: 2 },
      { text: '"My Folder"', start: 3, end: 14 },
      { text: 'x', start: 15, end: 16 }
    ]);
  });

  it('finds the token under the cursor, or an empty one in whitespace', () => {
    expect(tokenAtCursor('ls ~/Down', 8)).toEqual({ text: '~/Down', start: 3, end: 9 });
    expect(tokenAtCursor('ls ', 3)).toEqual({ text: '', start: 3, end: 3 });
  });
});

describe('path suggestions', () => {
  it('splits the typed directory part from the name prefix', () => {
    expect(splitPathToken('~/Down')).toEqual({ quote: '', dirPart: '~/', namePrefix: 'Down' });
    expect(splitPathToken('notes.md')).toEqual({ quote: '', dirPart: '', namePrefix: 'notes.md' });
    expect(splitPathToken('"My')).toEqual({ quote: '"', dirPart: '', namePrefix: 'My' });
  });

  it('resolves ~ and relative directory parts against the cwd', () => {
    expect(resolveDirPath('~/', { cwd: '/Users/me/projects', home: '/Users/me' })).toBe('/Users/me');
    expect(resolveDirPath('', { cwd: '/Users/me/projects', home: '/Users/me' })).toBe('/Users/me/projects');
    expect(resolveDirPath('../', { cwd: '/Users/me/projects', home: '/Users/me' })).toBe('/Users/me');
  });

  it('walks the loaded tree to the target directory', () => {
    expect(findNodeByPath(tree, '/Users/me/projects/Photos')).toBe(tree.children[0]);
    expect(findNodeByPath(tree, '/Users/me/projects/missing')).toBeNull();
    expect(findNodeByPath(tree, '/elsewhere')).toBeNull();
  });

  it('suggests matching children, directories first, with a trailing slash for folders', () => {
    const suggestions = pathSuggestions({ tree, cwd: tree.path, home: '/Users/me', tokenText: 'Pho' });
    expect(suggestions.map(s => s.value)).toEqual(['Photos/', 'Photoshop.txt']);
    expect(suggestions[0].kind).toBe('directory');
  });

  it('preserves the typed directory part', () => {
    const suggestions = pathSuggestions({ tree, cwd: tree.path, home: '/Users/me', tokenText: './not' });
    expect(suggestions.map(s => s.value)).toEqual(['./notes.md']);
  });

  it('quotes names that would otherwise split into several arguments', () => {
    const spaced = {
      name: 'projects',
      path: '/Users/me/projects',
      type: 'directory',
      children: [
        { name: 'My Documents', path: '/Users/me/projects/My Documents', type: 'directory', children: [] },
        { name: 'Plain.txt', path: '/Users/me/projects/Plain.txt', type: 'file' }
      ]
    };
    const suggestions = pathSuggestions({ tree: spaced, cwd: spaced.path, home: '/Users/me', tokenText: '' });
    expect(suggestions.map(s => s.value)).toEqual(['"My Documents/"', 'Plain.txt']);
    // The label stays readable; only the inserted value is quoted.
    expect(suggestions[0].label).toBe('My Documents');
  });
});

describe('command and flag suggestions', () => {
  it('suggests each program word once, filtered by prefix', () => {
    expect(commandSuggestions(presets, 'l').map(s => s.value)).toEqual(['ls']);
    expect(commandSuggestions(presets, 'd').map(s => s.value)).toEqual(['du', 'df']);
    expect(commandSuggestions(presets, '')).toEqual([]);
  });

  it('adds admin commands only when they are passed in', () => {
    expect(commandSuggestions([...presets, ...adminPresets], 't').map(s => s.value)).toEqual(['touch']);
  });

  it('suggests flags that are not already used', () => {
    expect(flagSuggestions('ls', ['ls', '-l'], '-').map(s => s.value)).not.toContain('-l');
    expect(flagSuggestions('ls', ['ls'], '-').map(s => s.value)).toContain('-a');
    expect(flagSuggestions('unknown', [], '-')).toEqual([]);
  });

  it('lists every option for a known command when no prefix is typed', () => {
    expect(flagSuggestions('ls', ['ls'], '').map(s => s.value))
      .toEqual(['-a', '-A', '-l', '-h', '-G', '-t', '-S', '-R']);
  });

  it('only offers write options the admin allowlist accepts', () => {
    expect(flagSuggestions('cp', ['cp'], '').map(s => s.value)).toEqual(['-R']);
    // `rm -i` prompts interactively (this pane has no stdin) and `mv` takes no
    // options here, so neither is suggested.
    expect(flagSuggestions('rm', ['rm'], '')).toEqual([]);
    expect(flagSuggestions('mv', ['mv'], '')).toEqual([]);
  });
});

describe('history suggestion', () => {
  it('extends the current input from the most recent matching entry', () => {
    expect(historySuggestion(['df -h', 'ls -lah'], 'ls')).toBe(' -lah');
    expect(historySuggestion(['ls -lah'], 'zz')).toBe('');
    // An exact match is not a prediction.
    expect(historySuggestion(['ls'], 'ls')).toBe('');
  });
});

describe('completionFor', () => {
  it('completes a path argument and exposes the ghost suffix', () => {
    const result = completionFor({ input: 'ls Pho', cursor: 6, tree, cwd: tree.path, home: '/Users/me', presets });
    expect(result.kind).toBe('path');
    expect(result.suggestions[0].value).toBe('Photos/');
    expect(result.ghost).toBe('tos/');
  });

  it('completes a command word in the first token', () => {
    const result = completionFor({ input: 'l', cursor: 1, tree, cwd: tree.path, home: '/Users/me', presets });
    expect(result.kind).toBe('command');
    expect(result.suggestions.map(s => s.value)).toEqual(['ls']);
    expect(result.ghost).toBe('s');
  });

  it('completes flags for a known command', () => {
    const result = completionFor({ input: 'ls -', cursor: 4, tree, cwd: tree.path, home: '/Users/me', presets });
    expect(result.kind).toBe('flag');
    expect(result.suggestions.map(s => s.value)).toContain('-l');
  });

  it('offers the command options, then browses the folder, for an empty argument token', () => {
    const result = completionFor({ input: 'ls ', cursor: 3, tree, cwd: tree.path, home: '/Users/me', presets });
    expect(result.kind).toBe('path');
    // Options come first so they are discoverable, then the folder's contents.
    expect(result.suggestions.slice(0, 3).map(s => s.value)).toEqual(['-a', '-A', '-l']);
    expect(result.suggestions.map(s => s.value))
      .toEqual(expect.arrayContaining(['Photos/', 'notes.md', 'Photoshop.txt']));
    expect(result.suggestions[result.suggestions.length - 1].kind).toBe('file');
    expect(result.ghost).toBe('');
  });

  it('omits options a command does not have, and ones already used', () => {
    const noFlags = completionFor({ input: 'pwd ', cursor: 4, tree, cwd: tree.path, home: '/Users/me', presets });
    expect(noFlags.suggestions.map(s => s.value)).toEqual(expect.arrayContaining(['Photos/']));
    expect(noFlags.suggestions.some(s => s.kind === 'flag')).toBe(false);

    const used = completionFor({ input: 'ls -l ', cursor: 6, tree, cwd: tree.path, home: '/Users/me', presets });
    const flagValues = used.suggestions.filter(s => s.kind === 'flag').map(s => s.value);
    expect(flagValues).not.toContain('-l');
    expect(flagValues).toContain('-a');
  });

  it('uses an on-demand listing for paths outside the loaded tree', () => {
    const input = 'mv -- a /Volumes/Ext/Ap';
    const result = completionFor({
      input,
      cursor: input.length,
      tree,
      cwd: tree.path,
      home: '/Users/me',
      presets,
      externalEntriesFor: dir => (dir === '/Volumes/Ext' ? [{ name: 'Applications', isDir: true }] : undefined)
    });
    expect(result.kind).toBe('path');
    expect(result.pathQuery.dirPath).toBe('/Volumes/Ext');
    expect(result.suggestions[0].value).toBe('/Volumes/Ext/Applications/');
  });
});
