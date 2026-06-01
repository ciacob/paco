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
  escHtml,
  fkeyEnabledState,
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
