// Pure helpers for predictive typing in the Terminal pane.
//
// No I/O happens here: path suggestions come from the already-loaded scan tree,
// plus (for paths outside it) a caller-supplied directory-listing cache. The
// caller only ever *suggests* -- the Rust allowlist still decides what may run.

// Keep enough entries to browse a folder in the dropdown, but bounded so a
// folder with tens of thousands of children stays cheap per keystroke.
export const MAX_SUGGESTIONS = 50;

export const TERMINAL_FLAG_OPTIONS = {
  ls: ['-a', '-A', '-l', '-h', '-G', '-t', '-S', '-R'],
  du: ['-s', '-h', '-a', '-d', '-x'],
  df: ['-h', '-k', '-P', '-T'],
  // Only options the admin allowlist actually accepts (see terminal.rs). `cp -R`
  // is required by the allowlist; `rm -i` is accepted but prompts interactively,
  // which this pane cannot answer, so it is not suggested.
  cp: ['-R']
};

// Collapse `.`, `..`, duplicate and trailing slashes into an absolute path.
export function normalizePath(value) {
  const parts = [];
  for (const segment of String(value || '').split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') parts.pop();
    else parts.push(segment);
  }
  return `/${parts.join('/')}`;
}

// Whitespace-separated tokens with their offsets. Simple quoted spans are kept
// together so a path with spaces is one token.
export function tokenizeWithSpans(input) {
  const text = String(input || '');
  const tokens = [];
  const pattern = /"[^"]*"?|'[^']*'?|\S+/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    if (!match[0]) break;
    tokens.push({ text: match[0], start: match.index, end: match.index + match[0].length });
  }
  return tokens;
}

export function tokenAtCursor(input, cursor) {
  const text = String(input || '');
  const pos = Math.max(0, Math.min(Number(cursor) || 0, text.length));
  for (const token of tokenizeWithSpans(text)) {
    if (pos >= token.start && pos <= token.end) return token;
  }
  return { text: '', start: pos, end: pos };
}

// Split the token being completed into the directory part (kept verbatim, so
// `~/` or `./sub/` is preserved) and the name prefix.
export function splitPathToken(text) {
  const raw = String(text || '');
  const quote = raw.startsWith('"') || raw.startsWith("'") ? raw[0] : '';
  const body = quote ? raw.slice(1) : raw;
  const slash = body.lastIndexOf('/');
  return {
    quote,
    dirPart: slash >= 0 ? body.slice(0, slash + 1) : '',
    namePrefix: slash >= 0 ? body.slice(slash + 1) : body
  };
}

export function resolveDirPath(dirPart, { cwd, home } = {}) {
  let value = String(dirPart || '');
  if (!value) return normalizePath(cwd || home || '/');
  if (value === '~') value = home || '';
  else if (value.startsWith('~/')) value = `${home || ''}/${value.slice(2)}`;
  if (!value.startsWith('/')) value = `${cwd || home || '/'}/${value}`;
  return normalizePath(value);
}

function baseName(path) {
  return String(path || '').replace(/\/+$/, '').split('/').pop() || '';
}

// Walk the loaded tree from its root to the directory at `path`, one segment at a
// time (never a full DFS), so this stays cheap on large trees.
export function findNodeByPath(root, path) {
  if (!root || !root.path) return null;
  const target = normalizePath(path);
  const rootPath = normalizePath(root.path);
  if (target === rootPath) return root;
  if (rootPath !== '/' && !target.startsWith(`${rootPath}/`)) return null;
  const rest = target === '/'
    ? []
    : target.slice(rootPath === '/' ? 1 : rootPath.length + 1).split('/');
  let node = root;
  for (const segment of rest) {
    if (!segment) continue;
    if (!Array.isArray(node.children)) return null;
    node = node.children.find(child => baseName(child?.path) === segment) || null;
    if (!node) return null;
  }
  return node;
}

function treeEntry(child) {
  return { name: String(child?.name || ''), isDir: child?.type === 'directory' };
}

function externalEntry(entry) {
  return { name: String(entry?.name || ''), isDir: Boolean(entry?.isDir) };
}

// Characters that would split a path into several shell arguments. The admin
// allowlist -- like a real shell -- reads `My App/` as two arguments, so a
// suggestion that needs quoting must carry the quotes itself.
const NEEDS_QUOTING = /[\s"'`\\$;&|<>()]/;

function quotedValue(text, quote) {
  if (quote) return `${quote}${text}${quote}`;
  if (!NEEDS_QUOTING.test(text)) return text;
  return `"${text.replace(/"/g, '\\"')}"`;
}

// Build name suggestions from a directory's entries. Directories come first,
// then case-insensitive name order, so the list is predictable and browsable
// with the arrow keys.
export function buildPathSuggestions({ quote, dirPart, namePrefix, entries }) {
  const prefix = namePrefix.toLowerCase();
  const wantHidden = prefix.startsWith('.');
  const compare = (a, b) => (Number(b.isDir) - Number(a.isDir)) || a.name.localeCompare(b.name);
  const best = [];
  for (const entry of entries || []) {
    if (!entry || !entry.name) continue;
    if (entry.name.startsWith('__')) continue;
    // Hidden files appear only when the user starts the name with a dot.
    if (!wantHidden && entry.name.startsWith('.')) continue;
    if (!entry.name.toLowerCase().startsWith(prefix)) continue;
    best.push(entry);
    // Bound the work on huge folders: sort small batches, keep the top N.
    if (best.length >= MAX_SUGGESTIONS * 2) {
      best.sort(compare);
      best.length = MAX_SUGGESTIONS;
    }
  }
  best.sort(compare);
  return best.slice(0, MAX_SUGGESTIONS).map(entry => ({
    value: quotedValue(`${dirPart}${entry.name}${entry.isDir ? '/' : ''}`, quote),
    label: entry.name,
    kind: entry.isDir ? 'directory' : 'file',
    detail: entry.isDir ? 'folder' : 'file'
  }));
}

// Resolve the directory a path token points into, and find it in the loaded tree
// (null when it is outside the scanned tree and needs an on-demand listing).
export function resolvePathQuery({ tree, cwd, home, tokenText }) {
  const { quote, dirPart, namePrefix } = splitPathToken(tokenText);
  const dirPath = resolveDirPath(dirPart, { cwd, home });
  return { quote, dirPart, namePrefix, dirPath, node: findNodeByPath(tree, dirPath) };
}

export function pathSuggestions({ tree, cwd, home, tokenText }) {
  const query = resolvePathQuery({ tree, cwd, home, tokenText });
  if (!query.node || !Array.isArray(query.node.children)) return [];
  return buildPathSuggestions({ ...query, entries: query.node.children.map(treeEntry) });
}

// Suggest the program word once per preset (so `ls -lah` and `ls` do not both
// appear as `ls`), filtered by what the user has typed.
export function commandSuggestions(presets, prefix) {
  const want = String(prefix || '').toLowerCase();
  if (!want) return [];
  const seen = new Set();
  const suggestions = [];
  for (const preset of presets || []) {
    const word = String(preset.command || '').trim().split(/\s+/)[0];
    if (!word || seen.has(word) || !word.toLowerCase().startsWith(want)) continue;
    seen.add(word);
    suggestions.push({ value: word, label: word, kind: 'command', detail: 'command' });
  }
  return suggestions.slice(0, MAX_SUGGESTIONS);
}

export function flagSuggestions(command, existing, prefix) {
  const flags = TERMINAL_FLAG_OPTIONS[command] || [];
  const used = new Set(existing || []);
  const want = String(prefix || '');
  return flags
    .filter(flag => !used.has(flag) && flag.startsWith(want))
    .map(flag => ({ value: flag, label: flag, kind: 'flag', detail: 'option' }));
}

// Suffix of the most recent history entry that extends the current input.
export function historySuggestion(history, input) {
  const text = String(input || '');
  if (!text) return '';
  for (let index = (history || []).length - 1; index >= 0; index -= 1) {
    const entry = String(history[index] || '');
    if (entry && entry !== text && entry.startsWith(text)) return entry.slice(text.length);
  }
  return '';
}

export function completionFor({
  input,
  cursor,
  tree,
  cwd,
  home,
  presets = [],
  adminPresets = [],
  adminMode = false,
  externalEntriesFor,
  highlightIndex = 0
}) {
  const text = String(input || '');
  const pos = Math.max(0, Math.min(Number(cursor) || 0, text.length));
  const tokens = tokenizeWithSpans(text);
  const current = tokenAtCursor(text, pos);
  const isFirstToken = text.slice(0, current.start).trim() === '';
  const atEnd = pos === text.length;

  let kind = 'none';
  let suggestions = [];
  let pathQuery = null;

  if (isFirstToken) {
    if (current.text.trim()) {
      kind = 'command';
      const all = adminMode ? [...presets, ...adminPresets] : presets;
      suggestions = commandSuggestions(all, current.text.trim());
    }
  } else if (current.text.startsWith('-')) {
    kind = 'flag';
    const command = String(tokens[0]?.text || '').trim().split(/\s+/)[0];
    suggestions = flagSuggestions(command, tokens.slice(1).map(token => token.text), current.text);
  } else {
    // A path argument -- including an empty token after a space, so the
    // destination/target folder can be browsed from the dropdown.
    pathQuery = resolvePathQuery({ tree, cwd, home, tokenText: current.text });
    kind = 'path';
    const treeEntries = pathQuery.node && Array.isArray(pathQuery.node.children)
      ? pathQuery.node.children.map(treeEntry)
      : null;
    const external = treeEntries ? null : externalEntriesFor?.(pathQuery.dirPath);
    const paths = buildPathSuggestions({
      quote: pathQuery.quote,
      dirPart: pathQuery.dirPart,
      namePrefix: pathQuery.namePrefix,
      entries: treeEntries || (Array.isArray(external) ? external.map(externalEntry) : [])
    });
    // Right after the command word (an empty token) also surface that command's
    // options, so -a/-R/-h/… are discoverable without typing a dash first.
    const flags = current.text === ''
      ? flagSuggestions(
        String(tokens[0]?.text || '').trim().split(/\s+/)[0],
        tokens.slice(1).map(token => token.text),
        ''
      )
      : [];
    suggestions = [...flags, ...paths];
  }

  // The ghost previews the *highlighted* suggestion, so what you see is exactly
  // what Tab/→ will insert. No ghost on an empty token (the dropdown suffices).
  const highlight = suggestions.length > 0
    ? Math.max(0, Math.min(highlightIndex, suggestions.length - 1))
    : 0;
  const active = suggestions[highlight];
  const ghost = atEnd && current.text && active && active.value.startsWith(current.text)
    ? active.value.slice(current.text.length)
    : '';

  return { tokens, current, isFirstToken, atEnd, kind, suggestions, ghost, pathQuery, highlightIndex: highlight };
}
