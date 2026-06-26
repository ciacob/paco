'use strict';

/**
 * paco/ui-state.js
 *
 * Pure functions over the PACO UI state object.
 *
 * NOTHING in here touches the DOM, window, adapter, or any I/O.
 * Every function takes state (and possibly other plain values) and returns
 * a new state or a plain derived value. All state mutations are explicit
 * returns — callers decide whether to apply them.
 *
 * This makes the entire UI logic unit-testable without a browser.
 */

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create a fresh, empty panel state.
 * @param {string} [defaultPath=''] — initial path (set before first navigate result)
 */
function makePanelState(defaultPath = '') {
  return {
    path:       defaultPath,
    entries:    [],
    selection:  [],          // array of paths (Set in UI, serialised here for purity)
    history:    [],
    tabs: [{ id: 'tab-default', path: defaultPath, label: null }],
    activeTab:  'tab-default',
    volumes:    [],
  };
}

/**
 * Create a fresh app state.
 */
function makeAppState(overrides = {}) {
  return Object.assign({
    activePanel: 'left',
    busy:        false,
    bootPhase:   'idle',   // 'idle' | 'booting-left' | 'booting-right' | 'ready'
    // The worker's actual OS, learned from the first navigate result.
    // Defaults to 'other' (i.e. "assume not macOS") until that arrives, so
    // macOS-only behaviour (like bundle-folder detection) never fires on a
    // guess — it only activates once we've heard from the worker for real.
    platform: 'other',
    panels: {
      left:  makePanelState(),
      right: makePanelState(),
    },
    config: {
      theme:         'dark',
      showHidden:    false,
      sortBy:        'name',
      sortAsc:       true,
      confirmDelete: true,
    },
  }, overrides);
}

// ─── Boot sequencing ─────────────────────────────────────────────────────────

/**
 * What should the app do next, given current bootPhase and a worker state push?
 *
 * Returns one of:
 *   { action: 'navigate-left' }
 *   { action: 'navigate-right' }
 *   { action: 'none' }
 *
 * Pure: no side effects.
 *
 * @param {string} bootPhase  — appState.bootPhase
 * @param {object} ws         — worker state object from WS push
 */
function nextBootAction(bootPhase, ws) {
  if (!ws) return { action: 'none' };

  const s = ws.state || 'idle';

  // Step 1: if idle and haven't started, kick off left panel
  if (bootPhase === 'idle' && s === 'idle') {
    return { action: 'navigate-left' };
  }

  // Step 2: left panel done → kick off right panel.
  // Also handles page reload landing on a stale 'done' result (bootPhase still 'idle').
  if ((bootPhase === 'booting-left' || bootPhase === 'idle') &&
      s === 'done' && ws.result && ws.result.panel === 'left') {
    return { action: 'navigate-right' };
  }

  // Step 3: right panel done → boot complete
  if ((bootPhase === 'booting-right' || bootPhase === 'idle') &&
      s === 'done' && ws.result && ws.result.panel === 'right') {
    return { action: 'none' };  // caller sets bootPhase = 'ready'
  }

  return { action: 'none' };
}

/**
 * Advance the boot phase given an action that was just taken.
 * Returns the new bootPhase string.
 *
 * @param {string} bootPhase
 * @param {string} action     — from nextBootAction
 */
function advanceBootPhase(bootPhase, action) {
  if (action === 'navigate-left')  return 'booting-left';
  if (action === 'navigate-right') return 'booting-right';
  if (bootPhase === 'booting-right') return 'ready';
  return bootPhase;
}

// ─── Worker state → app state ─────────────────────────────────────────────────

/**
 * Derive busy-bar display values from a worker state push.
 * Returns null if the bar should be hidden.
 *
 * @param {object} ws
 * @returns {{ msg: string, pct: number } | null}
 */
function busyStateFrom(ws) {
  if (!ws) return null;
  if (ws.state === 'running') {
    return {
      msg: ws.message || 'Working…',
      pct: typeof ws.percent === 'number' ? ws.percent : 0,
    };
  }
  return null;
}

/**
 * Apply a navigate task result to the panel slice of app state.
 * Returns a new panels object (does not mutate the input).
 *
 * @param {object} panels     — current appState.panels
 * @param {object} result     — navigate task done() payload
 * @returns {object}          — new panels
 */
function applyNavigateResult(panels, result) {
  if (!result || !result.panel) return panels;

  const side = result.panel;
  const prev = panels[side];

  // Tab structure (which tabs exist, which is active) is owned entirely by
  // the UI and written to disk explicitly on tab operations. Navigate results
  // must NEVER overwrite the in-memory tab list — they only update the active
  // tab's path to reflect where we navigated.
  const activeTab   = prev.activeTab;
  const updatedTabs = prev.tabs.map(t =>
    t.id === activeTab ? { ...t, path: result.path } : t
  );

  const newPanel = {
    ...prev,
    path:       result.path,
    entries:    result.entries    || [],
    selection:  [],
    history:    result.history    || prev.history,
    tabs:       updatedTabs,
    activeTab,
    volumes:    result.volumes    || prev.volumes,
  };

  return { ...panels, [side]: newPanel };
}

// ─── Navigation helpers ───────────────────────────────────────────────────────

/**
 * Compute the parent path of a given directory path.
 * Returns the same path if already at root.
 *
 * Platform-agnostic: detects separator from the path itself,
 * falling back to the OS separator.
 *
 * @param {string} dirPath
 * @returns {string}
 */
function parentPath(dirPath) {
  if (!dirPath) return dirPath;

  // Normalise to forward slashes for processing, remembering if it was win-style
  const isWin = dirPath.includes('\\') || /^[A-Za-z]:/.test(dirPath);
  const norm  = dirPath.replace(/\\/g, '/');

  // Windows drive root: "C:/" or "C:\" — already at root
  if (/^[A-Za-z]:\//.test(norm) && norm.replace(/\//g, '').length <= 2) return dirPath;

  // Unix root
  if (norm === '/') return '/';

  const parts = norm.split('/').filter(Boolean);
  if (parts.length === 0) return dirPath;
  if (parts.length === 1) {
    // one segment below root
    return isWin ? parts[0].replace(':', ':\\') : '/';
  }

  const parent = parts.slice(0, -1).join('/');
  return isWin ? parent.replace(/\//g, '\\') : '/' + parent;
}

// ─── Selection helpers ────────────────────────────────────────────────────────

/**
 * Toggle a path in a selection array.
 * Returns a new array (does not mutate).
 * @param {string[]} selection
 * @param {string}   entryPath
 * @returns {string[]}
 */
function toggleSelection(selection, entryPath) {
  const idx = selection.indexOf(entryPath);
  if (idx === -1) return [...selection, entryPath];
  return selection.filter((_, i) => i !== idx);
}

/**
 * Select all entries (excluding '..' pseudo-entry).
 * Returns a new array.
 * @param {object[]} entries   — FsEntry[]
 * @returns {string[]}
 */
function selectAllPaths(entries) {
  return entries.filter(e => e.name !== '..').map(e => e.path);
}

// ─── Tab helpers ──────────────────────────────────────────────────────────────

/**
 * Add a new tab to a panel state, cloned from the current path.
 * Returns a new panel state (does not mutate).
 * @param {object} panel
 * @param {string} id    — unique tab id
 * @returns {object}     — new panel state
 */
function addTab(panel, id) {
  const newTab = { id, path: panel.path, label: null };
  return {
    ...panel,
    tabs:      [...panel.tabs, newTab],
    activeTab: id,
    selection: [],
  };
}

/**
 * Close a tab by id. Refuses if it's the last tab.
 * Returns a new panel state, or the same panel if refused.
 * Also returns the path to navigate to if the active tab was closed.
 *
 * @param {object} panel
 * @param {string} tabId
 * @returns {{ panel: object, navigateTo: string|null }}
 */
function closeTab(panel, tabId) {
  if (panel.tabs.length <= 1) return { panel, navigateTo: null };

  const idx      = panel.tabs.findIndex(t => t.id === tabId);
  const newTabs  = panel.tabs.filter(t => t.id !== tabId);
  const closing  = panel.activeTab === tabId;
  const newActive = closing
    ? newTabs[Math.max(0, idx - 1)].id
    : panel.activeTab;
  const navigateTo = closing
    ? newTabs.find(t => t.id === newActive).path
    : null;

  return {
    panel: { ...panel, tabs: newTabs, activeTab: newActive, selection: [] },
    navigateTo,
  };
}

/**
 * Switch to a different tab. Returns new panel state.
 * Also returns the path to navigate to.
 *
 * @param {object} panel
 * @param {string} tabId
 * @returns {{ panel: object, navigateTo: string|null }}
 */
function switchTab(panel, tabId) {
  if (panel.activeTab === tabId) return { panel, navigateTo: null };
  const tab = panel.tabs.find(t => t.id === tabId);
  if (!tab) return { panel, navigateTo: null };
  return {
    panel:      { ...panel, activeTab: tabId, selection: [] },
    navigateTo: tab.path,
  };
}

// ─── Sort helpers ─────────────────────────────────────────────────────────────

/**
 * Compute the new sort state when a column header is clicked.
 * Toggles direction if same column, resets to ascending if different column.
 *
 * @param {{ sortBy: string, sortAsc: boolean }} current
 * @param {string} clickedColumn
 * @returns {{ sortBy: string, sortAsc: boolean }}
 */
function nextSortState(current, clickedColumn) {
  if (current.sortBy === clickedColumn) {
    return { sortBy: clickedColumn, sortAsc: !current.sortAsc };
  }
  return { sortBy: clickedColumn, sortAsc: true };
}

// ─── Display helpers (pure, no DOM) ──────────────────────────────────────────

/**
 * Format a byte count for display in the size column.
 * Returns empty string for zero (used for directories).
 * @param {number} bytes
 * @returns {string}
 */
function fmtSize(bytes) {
  if (!bytes || bytes === 0) return '';
  if (bytes < 1024)       return bytes + ' B';
  if (bytes < 1048576)    return (bytes / 1024).toFixed(1) + ' K';
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' M';
  return (bytes / 1073741824).toFixed(2) + ' G';
}

/**
 * Format a millisecond timestamp for display.
 * @param {number} ms
 * @returns {string}
 */
function fmtDate(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const date = d.toLocaleDateString(undefined, { year: '2-digit', month: '2-digit', day: '2-digit' });
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
  return date + ' ' + time;
}

/**
 * Shorten a path to just its last segment, for use in tab labels.
 * @param {string} p
 * @returns {string}
 */
function shortenPath(p) {
  if (!p) return '—';
  const parts = p.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] || p;
}

/**
 * Compute the selection end index for pre-selecting a filename in a rename
 * input — i.e. everything up to (but not including) the last dot, so the
 * extension stays untouched while the user types the new base name.
 *
 * Dot files (a leading dot with nothing before it) get no special treatment:
 * if the last dot is at position 0, or there is no dot at all, the selection
 * is empty (0).
 *
 * @param {string} name
 * @returns {number} index to use as the selection end (selection start is 0)
 */
function basenameSelectionEnd(name) {
  if (!name) return 0;
  const lastDot = name.lastIndexOf('.');
  if (lastDot <= 0) return 0; // no dot, or dot is the very first character
  return lastDot;
}

/**
 * Escape HTML special characters.
 * @param {string} str
 * @returns {string}
 */
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Determine which F-keys should be enabled given panel selection state.
 * Returns a plain object of { view, edit, copy, move, mkdir, delete }.
 *
 * @param {string[]} selection — selected paths in active panel
 * @param {boolean}  busy
 * @returns {{ view:boolean, edit:boolean, copy:boolean, move:boolean, mkdir:boolean, delete:boolean }}
 */
function fkeyEnabledState(selection, busy) {
  const hasSel = selection.length > 0;
  return {
    view:   !busy && hasSel,
    edit:   !busy && hasSel,
    copy:   !busy && hasSel,
    move:   !busy && hasSel,
    mkdir:  !busy,
    delete: !busy && hasSel,
  };
}

/**
 * Determine whether the Rename command (Shift+F6) should be enabled.
 * Rename only makes sense for exactly one selected item, and only if that
 * item is writable.
 *
 * @param {string[]} selection — selected paths
 * @param {object[]} entries   — current panel's FsEntry[] (to look up writable)
 * @param {boolean}  busy
 * @returns {boolean}
 */
function canRename(selection, entries, busy) {
  if (busy) return false;
  if (selection.length !== 1) return false;
  const entry = entries.find(e => e.path === selection[0]);
  if (!entry) return false;
  return entry.writable !== false;
}

/**
 * Determine whether the F4 "Open with…" command should be enabled.
 * Same single-selection constraint as Rename, but additionally requires
 * the selected item to be a file — F4's file-handlers cascade is about
 * which application opens a file, which has no meaning for a directory.
 * (Folders are navigated into, or — on macOS — opened as a bundle via
 * Enter/double-click; neither of those is F4's concern.)
 *
 * @param {string[]} selection — selected paths
 * @param {object[]} entries   — current panel's FsEntry[]
 * @param {boolean}  busy
 * @returns {boolean}
 */
function canOpenWith(selection, entries, busy) {
  if (busy) return false;
  if (selection.length !== 1) return false;
  const entry = entries.find(e => e.path === selection[0]);
  if (!entry) return false;
  return entry.type === 'file';
}

/**
 * Build the header line for the rename dialog.
 * @param {string} currentName
 * @returns {string}
 */
function renameDialogHeader(currentName) {
  return `Rename "${currentName}"`;
}

/**
 * Build the rename report/confirmation outcome message.
 * Mirrors copyReport's style but singular, and without the "report" phase —
 * used only for error display since rename has no progress/report dialog.
 *
 * @param {string} reason
 * @returns {string}
 */
function renameErrorMessage(reason) {
  return reason || 'Rename failed';
}

// ─── Open natively (Enter key) ─────────────────────────────────────────────────

/**
 * Known macOS bundle-style directory extensions. These are directories that
 * the OS treats as a single double-clickable/openable unit rather than a
 * folder to browse into — most commonly .app, but also a handful of other
 * Apple bundle conventions a user might reasonably encounter in Finder.
 *
 * Deliberately a short, explicit allow-list rather than a heuristic, so a
 * folder like "My.Project" is never mistaken for a bundle.
 */
const MAC_BUNDLE_EXTENSIONS = new Set([
  '.app', '.bundle', '.framework', '.plugin', '.kext',
  '.workflow', '.prefpane', '.qlgenerator', '.saver', '.action',
]);

/**
 * Determine whether a directory name matches a known macOS bundle extension.
 * Case-insensitive on the extension, since macOS's filesystem usually is.
 *
 * This check is extension-shape only — callers are responsible for also
 * checking `process.platform === 'darwin'`, since this concept is
 * macOS-specific and meaningless (and should not trigger) elsewhere.
 *
 * @param {string} name — directory name (basename, not full path)
 * @returns {boolean}
 */
function isMacBundleDir(name) {
  if (!name) return false;
  const lastDot = name.lastIndexOf('.');
  if (lastDot <= 0) return false; // no extension, or a dotfile with nothing before it
  const ext = name.slice(lastDot).toLowerCase();
  return MAC_BUNDLE_EXTENSIONS.has(ext);
}

/**
 * Decide what Enter should do for the currently selected entry.
 *
 * Rules:
 *   - Exactly one selected item is required; zero or multiple → 'none'.
 *   - A regular file with an extension → 'open' (hand off to the OS).
 *   - A regular file with no extension → 'none' (escape hatch is the future
 *     View/Edit commands, not a blind OS hand-off).
 *   - A directory matching a known macOS bundle extension, only when
 *     platform is 'darwin' → 'open'.
 *   - Any other directory (including dotted names that aren't bundles, and
 *     ALL directories on non-macOS platforms) → 'navigate'.
 *   - Symlinks are currently a no-op, consistent with existing double-click
 *     behaviour elsewhere in the panel, which also only acts on type 'dir'.
 *
 * @param {string[]} selection — selected paths in the active panel
 * @param {object[]} entries   — current panel's FsEntry[]
 * @param {string}   platform  — process.platform string (injected, not read
 *                               directly, so this stays pure and testable)
 * @returns {{ action: 'navigate'|'open'|'none', path: string|null }}
 */
function decideEnterAction(selection, entries, platform) {
  if (selection.length !== 1) return { action: 'none', path: null };

  const entry = entries.find(e => e.path === selection[0]);
  if (!entry) return { action: 'none', path: null };

  if (entry.type === 'dir') {
    if (platform === 'darwin' && isMacBundleDir(entry.name)) {
      return { action: 'open', path: entry.path };
    }
    return { action: 'navigate', path: entry.path };
  }

  if (entry.type === 'file') {
    const lastDot = entry.name.lastIndexOf('.');
    const hasExtension = lastDot > 0; // same "not a leading dot-file" rule as elsewhere
    if (hasExtension) return { action: 'open', path: entry.path };
    return { action: 'none', path: null };
  }

  // symlinks and anything else: no-op for now
  return { action: 'none', path: null };
}

// ─── File handlers (F4) ─────────────────────────────────────────────────────────

/**
 * MIME-category buckets, in the order they're documented (not significant
 * for matching — category lookup is a direct key access, not a cascade).
 */
const FILE_CATEGORIES = ['text', 'audio', 'image', 'video', 'other'];

/**
 * Classify a detected MIME type (or the absence of one) into one of the
 * category buckets used by file-handlers.json's "category" tier.
 *
 * `file-type` only detects binary signatures and returns no match at all
 * for text-based formats — that absence, combined with a separate content
 * sniff for "does this look like text", is what tells the two apart here.
 * This function does no I/O itself; the content sniff result is passed in.
 *
 * @param {string|null} mime        — MIME type from file-type, or null/undefined if no match
 * @param {boolean}     looksTextual — result of a separate binary-vs-text content sniff,
 *                                     only consulted when mime is null/undefined
 * @returns {'text'|'audio'|'image'|'video'|'other'}
 */
function classifyMime(mime, looksTextual) {
  if (!mime) {
    return looksTextual ? 'text' : 'other';
  }
  if (mime.startsWith('text/'))  return 'text';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  return 'other';
}

/**
 * Normalise a file name's extension for matching against file-handlers.json
 * — lower-cased, includes the leading dot, '' if there is none (or it's a
 * leading dot-file with nothing before it, consistent with the rule used
 * elsewhere in this module).
 *
 * @param {string} name
 * @returns {string}
 */
function extOf(name) {
  if (!name) return '';
  const lastDot = name.lastIndexOf('.');
  if (lastDot <= 0) return '';
  return name.slice(lastDot).toLowerCase();
}

/**
 * Resolve which handler (if any) should open a file, per the three-tier
 * cascade described in file-handlers.json:
 *
 *   1. specific  — array of { extensions, handler }, first match wins
 *   2. category  — one of text/audio/image/video/other, by detected MIME
 *   3. fallback  — 'nativeOpen' | 'lister' | null, the terminal step
 *
 * Tiers 1 and 2 apply identically regardless of whether the file is
 * executable — only the terminal fallback step branches on that, via
 * `exec_fallback` instead of `fallback`, and `exec_fallback` may never be
 * 'nativeOpen' (that is the exact case this whole gate exists to prevent).
 *
 * This function is pure: all inputs (config, name, mime, sniff result,
 * executable check) are supplied by the caller, which owns the actual I/O
 * (file-type detection, content sniffing, fs.access/PATHEXT check).
 *
 * @param {object}      config        — parsed file-handlers.json
 * @param {string}      name          — file's basename
 * @param {string|null} mime          — file-type's detected MIME, or null
 * @param {boolean}     looksTextual  — content-sniff result, used only if mime is null
 * @param {boolean}     isExecutable  — result of the platform-appropriate executable check
 * @returns {{ action: 'open'|'nativeOpen'|'lister'|'none', app?: string, args?: string[] }}
 */
function resolveFileHandler(config, name, mime, looksTextual, isExecutable) {
  const cfg = config || {};
  const ext = extOf(name);

  // Tier 1 — specific extension match, first entry wins
  const specificList = Array.isArray(cfg.specific) ? cfg.specific : [];
  for (const entry of specificList) {
    const extensions = (entry && Array.isArray(entry.extensions)) ? entry.extensions : [];
    if (extensions.some(e => String(e).toLowerCase() === ext)) {
      const handler = entry.handler || {};
      return { action: 'open', app: handler.app, args: handler.args || [] };
    }
  }

  // Tier 2 — category match
  const category = classifyMime(mime, looksTextual);
  const categoryHandler = cfg.category ? cfg.category[category] : null;
  if (categoryHandler && categoryHandler.app) {
    return { action: 'open', app: categoryHandler.app, args: categoryHandler.args || [] };
  }

  // Tier 3 — terminal fallback, branching on the executable gate
  if (isExecutable) {
    const execFallback = cfg.exec_fallback || null;
    // 'nativeOpen' is never a legal value here, even if misconfigured —
    // the whole point of this gate is to prevent that exact outcome.
    if (execFallback === 'lister') return { action: 'lister' };
    return { action: 'none' };
  }

  const fallback = cfg.fallback === undefined ? 'nativeOpen' : cfg.fallback;
  if (fallback === 'nativeOpen') return { action: 'nativeOpen' };
  if (fallback === 'lister')     return { action: 'lister' };
  return { action: 'none' };
}

/**
 * Build the confirmation message for a copy/move operation.
 * @param {'copy'|'move'} op
 * @param {number}        count
 * @param {string}        dstPath
 * @returns {string}
 */
function opConfirmMessage(op, count, dstPath) {
  const verb   = op === 'copy' ? 'Copy' : 'Move';
  const noun   = count === 1 ? '1 item' : `${count} items`;
  return `${verb} ${noun} to:\n${dstPath}`;
}

// ─── Copy dialog helpers ─────────────────────────────────────────────────────

/**
 * Build the header line for the copy dialog configure phase.
 * @param {string[]} sources  — source paths
 * @param {string}   dst      — destination directory path
 * @returns {string}
 */
function copyDialogHeader(sources, dst) {
  if (sources.length === 1) {
    const name = sources[0].split(/[/\\]/).filter(Boolean).pop() || sources[0];
    return `Copy "${name}" to ${dst}`;
  }
  return `Copy ${sources.length} items to ${dst}`;
}

/**
 * Build the summary report message after a copy operation.
 *
 * @param {object} stats
 * @param {number} stats.copied          — items fully copied
 * @param {number} stats.prefixed        — items copied with a (n) prefix
 * @param {number} stats.replacedOlder   — files replaced (were older)
 * @param {number} stats.skippedNewer    — files skipped (dest was newer/same)
 * @param {number} stats.mergedFolders   — folders merged
 * @param {number} stats.skippedSecurity — items skipped due to permissions
 * @param {number} stats.aborted         — 0 or 1 (operation aborted mid-way)
 * @param {string} [stats.abortReason]   — name of item that caused abort
 * @param {string} dst                   — destination path
 * @returns {string}
 */
function copyReport(stats, dst, mode) {
  const verb    = mode === 'move' ? 'Moved'  : 'Copied';
  const opNoun  = mode === 'move' ? 'Move'   : 'Copy';
  const {
    copied = 0, prefixed = 0, replacedOlder = 0, skippedNewer = 0,
    mergedFolders = 0, skippedSecurity = 0, aborted = 0, abortReason = '',
  } = stats;

  if (aborted) {
    const reason = abortReason
      ? `"${abortReason}" already exists`
      : 'a name conflict was encountered';
    return `${opNoun} aborted because ${reason}.`;
  }

  const parts = [];
  const dstName = dst.split(/[/\\]/).filter(Boolean).pop() || dst;

  // Main copy/move line
  const mainCopied = copied + prefixed + replacedOlder;
  if (mainCopied > 0) {
    let line = `${verb} ${mainCopied} item${mainCopied !== 1 ? 's' : ''} to ${dstName}`;
    const qualifiers = [];
    if (prefixed > 0)      qualifiers.push(`${prefixed} renamed with a prefix`);
    if (replacedOlder > 0) qualifiers.push(`${replacedOlder} replaced older`);
    if (skippedNewer > 0)  qualifiers.push(`${skippedNewer} skipped (destination newer)`);
    if (qualifiers.length) line += ` (${qualifiers.join(', ')})`;
    parts.push(line + '.');
  } else {
    parts.push(`Nothing was copied to ${dstName}.`);
  }

  if (mergedFolders > 0) {
    parts.push(`Merged ${mergedFolders} folder${mergedFolders !== 1 ? 's' : ''}.`);
  }
  if (skippedSecurity > 0) {
    parts.push(`Skipped ${skippedSecurity} item${skippedSecurity !== 1 ? 's' : ''} due to permission limitations.`);
  }

  return parts.join('\n');
}

/**
 * Derive a suggested (n) prefix name that doesn't clash in dstDir.
 * Pure function — takes an existing name set for O(1) lookup.
 *
 * @param {string}      name        — original filename or dirname
 * @param {Set<string>} existingNames — names already present in destination
 * @returns {string}                — prefixed name guaranteed not in existingNames
 */
function prefixedName(name, existingNames) {
  if (!existingNames.has(name)) return name;
  for (let n = 1; n <= 999; n++) {
    const candidate = `(${n}) ${name}`;
    if (!existingNames.has(candidate)) return candidate;
  }
  // Fallback — extremely unlikely
  return `(${Date.now()}) ${name}`;
}

// ─── Exports (CommonJS for tests, also assigned to window for browser use) ───

const uiState = {
  makeAppState,
  makePanelState,
  nextBootAction,
  advanceBootPhase,
  busyStateFrom,
  applyNavigateResult,
  parentPath,
  toggleSelection,
  selectAllPaths,
  addTab,
  closeTab,
  switchTab,
  nextSortState,
  fmtSize,
  fmtDate,
  shortenPath,
  basenameSelectionEnd,
  escHtml,
  fkeyEnabledState,
  canRename,
  canOpenWith,
  renameDialogHeader,
  renameErrorMessage,
  isMacBundleDir,
  decideEnterAction,
  classifyMime,
  extOf,
  resolveFileHandler,
  opConfirmMessage,
  copyDialogHeader,
  copyReport,
  prefixedName,
};

// Always expose as a browser global when running in a browser context.
// The typeof-window check is reliable; typeof-module is not (some environments
// define module without it being a proper CommonJS context).
if (typeof window !== 'undefined') {
  window.uiState = uiState;
}

// CommonJS export for Node.js (tests, tasks).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = uiState;
}
