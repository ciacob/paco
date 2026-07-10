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

// ─── Debounce factory ─────────────────────────────────────────────────────────

/**
 * Returns a debounced version of fn that fires after `delayMs` of silence.
 * Each call resets the timer. The returned function also exposes `.cancel()`.
 *
 * Pure in the sense that it's a deterministic factory — the returned closure
 * has side effects (timers) but the factory itself is testable via fake timers.
 *
 * Originally lived in paco/watcher-state.js (server-side filesystem-watch
 * debouncing only); relocated here — the one module already loaded both
 * server-side (Node tests, tasks) and client-side (<script> tag) — so the
 * UI layer can reuse the exact same tested implementation (e.g. debouncing
 * the F3 Viewer's reaction to a selection click that might be immediately
 * superseded by navigation) rather than a second, drifting copy of it.
 * watcher-state.js now re-exports this one rather than defining its own.
 *
 * @param {Function} fn
 * @param {number|Function} delayMs — a fixed value, or a zero-arg function
 *   returning the current value (re-read on every call — e.g. a config
 *   value that can change between when this debounced wrapper was CREATED
 *   and when it's actually SCHEDULED, rather than a value baked in once
 *   and never revisited)
 * @param {object}   [timers]  — injectable { setTimeout, clearTimeout } for testing
 */
function makeDebounced(fn, delayMs, timers) {
  // Deliberately NOT { setTimeout, clearTimeout } — destructuring these
  // into a plain object and later calling them as t.setTimeout(...)/
  // t.clearTimeout(...) throws "Illegal invocation" in a real browser:
  // they're native, branded Web APIs that require `this` to actually be
  // the real window/global object when called as a method, and a plain
  // object literal isn't that. Node's own timer implementation happens
  // to be lenient about this (unbound, this-agnostic) — confirmed via a
  // real user session: this exact bug passed every test in this suite
  // (Node) yet broke immediately in the browser this code actually runs
  // in. Wrapping in arrow functions that call the bare, unqualified
  // setTimeout/clearTimeout identifiers sidesteps the whole issue —
  // called that way, with no object-method receiver at all, browsers
  // resolve them correctly regardless.
  const t = timers || {
    setTimeout:   (...args) => setTimeout(...args),
    clearTimeout: (...args) => clearTimeout(...args),
  };
  let handle = null;
  const debounced = (...args) => {
    if (handle !== null) t.clearTimeout(handle);
    const effectiveDelay = typeof delayMs === 'function' ? delayMs() : delayMs;
    handle = t.setTimeout(() => { handle = null; fn(...args); }, effectiveDelay);
  };
  debounced.cancel = () => { if (handle !== null) { t.clearTimeout(handle); handle = null; } };
  return debounced;
}

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
    // Optimistic default until the first navigate result reports the real
    // value — keeps New Folder/New File enabled rather than flashing
    // disabled before anything has loaded.
    directoryWritable: true,
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
    // Viewer panel (F3) visibility — deliberately session-only, never
    // persisted (see context.js's viewerSplit comment for why). Every
    // session starts with the Viewer closed.
    viewerOpen: false,
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
    path:              result.path,
    entries:           result.entries    || [],
    selection:         [],
    history:           result.history    || prev.history,
    tabs:              updatedTabs,
    activeTab,
    volumes:           result.volumes    || prev.volumes,
    // Whether the panel's own listed directory can be written into (i.e.
    // whether New Folder/New File should be enabled). Defaults to true —
    // the optimistic default — if a result somehow doesn't carry it, rather
    // than leaving stale false from a previous directory.
    directoryWritable: result.directoryWritable !== undefined
      ? result.directoryWritable
      : true,
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
 *
 * Treats 0 as a real, formattable size ("0 B") — e.g. a freshly created
 * stub file (Shift+F4) is genuinely empty, and showing its size explicitly
 * is the only way to confirm that to the user rather than leaving the cell
 * looking blank/unloaded. Whether to show a size AT ALL (e.g. blank for
 * directories) is the caller's decision, not this function's — see the
 * `entry.type === 'dir' ? '' : fmtSize(entry.size)` pattern at the render
 * call site.
 *
 * @param {number} bytes
 * @returns {string}
 */
function fmtSize(bytes) {
  if (bytes == null) return '';
  if (bytes === 0)        return '0 B';
  if (bytes < 1024)       return bytes + ' B';
  if (bytes < 1048576)    return (bytes / 1024).toFixed(1) + ' K';
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' M';
  return (bytes / 1073741824).toFixed(2) + ' G';
}

/**
 * Verbose size format for the Viewer panel's size-calculation result —
 * deliberately distinct from fmtSize's compact file-list format, since
 * this context calls for the full unit word plus the precise byte count
 * in parentheses: "2.3 Mb (2,411,724 Bytes)". Not used anywhere fmtSize
 * already is; changing fmtSize itself would alter the file-list display
 * everywhere, which is out of scope here.
 *
 * @param {number} bytes
 * @returns {string}
 */
function fmtSizeVerbose(bytes) {
  if (bytes == null) return '';
  const exact = bytes.toLocaleString('en-US') + ' Bytes';
  if (bytes < 1024) return `${bytes} Bytes`;
  let value, unit;
  if (bytes < 1048576)         { value = bytes / 1024;        unit = 'Kb'; }
  else if (bytes < 1073741824) { value = bytes / 1048576;     unit = 'Mb'; }
  else                         { value = bytes / 1073741824;  unit = 'Gb'; }
  return `${value.toFixed(1)} ${unit} (${exact})`;
}

/**
 * Consistent, human-readable "file too large" error message — reused by
 * every F3 extractor that enforces a max-file-size limit (generic, image,
 * media, text). Previously each one independently built its own raw-
 * byte-count string ("File is 27384126 bytes, exceeding the 5242880-byte
 * limit.") — four separate copies of the same wording, with no shared
 * source of truth, and numbers nobody actually reads as bytes at that
 * scale. One function, reused via require('../../../ui-state') from
 * each extractor's own src/ — a deliberate, small, well-justified
 * exception to extractors otherwise being standalone/self-contained
 * packages: fmtSize is a pure string formatter with no DOM/IO coupling,
 * and the alternative (four drifting copies of the same message) is
 * worse than the one added dependency.
 *
 * @param {number} actualBytes
 * @param {number} limitBytes
 * @returns {string}
 */
function formatFileTooLargeError(actualBytes, limitBytes) {
  return `File too large: ${fmtSize(actualBytes)} exceeds the ${fmtSize(limitBytes)} limit.`;
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
 * Determine whether the "New File" command (Shift+F4) should be enabled.
 * Unlike Rename/Open-with, this has nothing to do with the current
 * selection — it's about whether the active panel's LISTED DIRECTORY
 * itself can be written into. That fact is refreshed on every panel
 * update (see paco/task-helpers.js#refreshPanel's directoryWritable field).
 *
 * @param {boolean} directoryWritable — appState.panels[side].directoryWritable
 * @param {boolean} busy
 * @returns {boolean}
 */
function canCreateFile(directoryWritable, busy) {
  if (busy) return false;
  return directoryWritable !== false;
}

/**
 * Build the header line for the "New File" dialog.
 * @param {string} dirPath — the directory the file will be created in
 * @returns {string}
 */
function createFileDialogHeader(dirPath) {
  return `New File in ${dirPath}`;
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

/**
 * Build the abort message for a source/destination type mismatch — a file
 * colliding with a same-named folder, or vice versa. This is always a hard
 * abort, independent of whatever conflict strategy is configured: "merge"
 * a folder into a file (or any of the file-replace strategies into a
 * folder) has no sensible meaning, so the type check happens before any
 * strategy is even consulted, in copy-engine.js and rename.js alike.
 *
 * Type labels reflect the item's REAL on-disk type (fs.stat), never an
 * extension-based guess — a file named "test.app" is still FILE, even on
 * a platform where ".app" is normally a bundle-folder convention.
 *
 * @param {'copy'|'move'|'rename'} action
 * @param {string} sourcePath    — full path of the source item
 * @param {'file'|'dir'} sourceType
 * @param {string} destDirPath   — the destination DIRECTORY (copy/move), or
 *                                 the shared parent directory (rename, where
 *                                 source and target are siblings)
 * @param {'file'|'dir'} destType — type of the EXISTING colliding item
 * @param {string} collidingName — basename of the colliding item
 * @returns {string}
 */
function typeMismatchMessage(action, sourcePath, sourceType, destDirPath, destType, collidingName) {
  const sourceLabel = sourceType === 'dir' ? 'FOLDER' : 'FILE';
  const destLabel    = destType === 'dir' ? 'FOLDER' : 'FILE';
  return (
    `Cannot ${action} source ${sourcePath} ${sourceLabel} to target ${destDirPath}, ` +
    `because a ${destLabel} named ${collidingName} already exists there.\n\n` +
    `Please rename either the source or the target in order to proceed.\n\n` +
    `Operation aborted.`
  );
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
    abortMessage = null,
  } = stats;

  if (aborted) {
    // A precise message (e.g. from a source/destination type mismatch)
    // always takes priority over the generic name-clash wording.
    if (abortMessage) return abortMessage;
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

// ─── Viewer panel (F3) ──────────────────────────────────────────────────────

/**
 * Top-level entry point for what the Viewer panel should show, given both
 * panels' current selection and entries. Pure and synchronous — it never
 * does I/O (no MIME detection, no owner/permission lookups, no size
 * calculation); those are gathered separately, asynchronously, and merged
 * into the column data the caller already has by the time this runs, OR
 * are represented here only as a flag the caller acts on (e.g.
 * needsSizeCalculation).
 *
 * Column count follows directly from how many panels have a non-empty
 * selection — 0 → empty state, 1 → one column, 2 → two columns. Within a
 * column, whether it's single- or multi-item content is a property of
 * that panel's own selection size, independent of the other panel.
 *
 * @param {object} panels — { left: {selection, entries}, right: {selection, entries} }
 * @returns {{ mode: 'empty' } | { mode: 'columns', columns: object[] }}
 *   Each column: { side, kind: 'single'|'multi', ...kind-specific fields }
 *   single:  { side, kind:'single', entry }
 *   multi:   { side, kind:'multi', entries, counts, recentCreated, recentModified }
 */
function describeViewerSelection(panels) {
  const sides = ['left', 'right'].filter(side => {
    const p = panels[side];
    return p && Array.isArray(p.selection) && p.selection.length > 0;
  });

  if (sides.length === 0) return { mode: 'empty' };

  const columns = sides.map(side => _describeViewerColumn(side, panels[side]));
  return { mode: 'columns', columns };
}

function _describeViewerColumn(side, panel) {
  const selectedPaths = new Set(panel.selection);
  const selectedEntries = (panel.entries || []).filter(e => selectedPaths.has(e.path));

  if (selectedEntries.length === 1) {
    return { side, kind: 'single', entry: selectedEntries[0] };
  }

  return {
    side,
    kind: 'multi',
    entries: selectedEntries,
    counts: _viewerCounts(selectedEntries),
    recentCreated:  _viewerRecent(selectedEntries, 'created'),
    recentModified: _viewerRecent(selectedEntries, 'mtime'),
  };
}

/**
 * @param {object[]} entries
 * @returns {{ files: number, folders: number, total: number }}
 */
function _viewerCounts(entries) {
  let files = 0, folders = 0;
  for (const e of entries) {
    if (e.type === 'dir') folders++;
    else files++; // file, symlink, other all count as "files" for this summary
  }
  return { files, folders, total: entries.length };
}

/**
 * Top 3 entries by the given timestamp field, newest first.
 *
 * @param {object[]} entries
 * @param {'created'|'mtime'} field
 * @returns {{ type: string, name: string, when: number }[]}
 */
function _viewerRecent(entries, field) {
  return entries
    .slice()
    .sort((a, b) => (b[field] || 0) - (a[field] || 0))
    .slice(0, 3)
    .map(e => ({ type: e.type, name: e.name, when: e[field] }));
}

/**
 * Build the "Type" row's label for a single-selection file, e.g.
 * "text — text/html file" or "binary — .png file". Folders don't get a
 * Type row at all (see the spec's bracketed-optional notation) — this is
 * only ever called for files.
 *
 * @param {boolean}     isTextual
 * @param {string|null} mime       — detected MIME, or null if file-type found no match
 * @param {string}      ext        — the file's own extension (with leading dot), used
 *                                   as the fallback label when there's no MIME match
 * @returns {string}
 */
/**
 * Whether a MIME type sits in the IANA "vnd." (vendor-specific) or "x-"
 * (unregistered/experimental) subtype namespace, rather than being a
 * clean, standard type — these are exactly the ones that read as noise
 * in a UI: needlessly long and technical for vnd. types (e.g.
 * "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
 * for a plain .docx) or just cryptic for x- types (e.g.
 * "image/x-canon-cr2" for a .cr2) — neither is how anyone actually
 * recognizes the file; they'd know it by its extension. Also treats any
 * excessively long mime string the same way regardless of its specific
 * subtype convention, as a defensive catch-all for whatever else is out
 * there that doesn't happen to match either prefix.
 *
 * @param {string|null} mime
 * @returns {boolean}
 */
function isVendorOrExperimentalMime(mime) {
  if (!mime) return false;
  return /^[a-z0-9.+-]+\/(vnd\.|x-)/i.test(mime) || mime.length > 40;
}

/**
 * @param {boolean} isTextual
 * @param {string|null} mime
 * @param {string} ext — with or without the leading dot; either works
 * @returns {string} e.g. "text \u2014 text/html file", or
 *   "binary \u2014 DOCX file" for a vendor/experimental mime where the
 *   extension reads far better than the raw MIME type would
 */
function viewerKindLabel(isTextual, mime, ext) {
  const kind = isTextual ? 'text' : 'binary';
  const extLabel = ext ? ext.replace(/^\./, '').toUpperCase() : null;
  // A clean, standard mime is still the most precise thing to show when
  // we have one (e.g. "image/jpeg" is more informative than "JPG" or
  // "JPEG", which aren't even guaranteed to agree with each other) — the
  // extension only takes over when the mime itself would be the worse
  // of the two to display, or is missing entirely.
  const label = (mime && !isVendorOrExperimentalMime(mime))
    ? mime
    : (extLabel || mime || 'unknown');
  return `${kind} \u2014 ${label} file`;
}

/**
 * Build the 3x3 boolean permission grid for a POSIX octal mode, in the
 * conventional [owner, group, other] x [read, write, execute] order.
 *
 * @param {number} mode — numeric mode, e.g. 0o644
 * @returns {{ owner: {r,w,x}, group: {r,w,x}, other: {r,w,x} }}
 */
function viewerPermissionGrid(mode) {
  const bit = (shift, flag) => !!(mode & (flag << shift));
  return {
    owner: { r: bit(6, 4), w: bit(6, 2), x: bit(6, 1) },
    group: { r: bit(3, 4), w: bit(3, 2), x: bit(3, 1) },
    other: { r: bit(0, 4), w: bit(0, 2), x: bit(0, 1) },
  };
}

/**
 * Build the SelectionClassification shape paco/renderers/matcher.js's
 * matchRenderers() expects, from what viewer-details.js's task result
 * already gives the client (mime, isTextual) plus the entry's own name.
 * Pure — no I/O, mirrors exactly what viewer-details.js/
 * file-handler-detect.js already established: isTextual IS fileMode
 * (true -> "text", false -> "binary"), never a separate derivation.
 *
 * @param {'single'|'multi'} selectionType
 * @param {boolean}     isTextual — from viewer-details.js's result
 * @param {string|null} mime      — from viewer-details.js's result
 * @param {string}      name      — the entry's basename, for its extension
 * @returns {{selectionType, fileMode: 'text'|'binary', binaryCategory: string|null, fileType: string|null}}
 */
function viewerRendererClassification(selectionType, isTextual, mime, name) {
  const fileMode = isTextual ? 'text' : 'binary';
  const binaryCategory = fileMode === 'binary' ? classifyMime(mime, isTextual) : null;
  const ext = extOf(name); // '.png', or '' if none
  const fileType = ext ? ext.slice(1) : null;
  return { selectionType, fileMode, binaryCategory, fileType };
}

/**
 * Reorder matchRenderers()'s own `tabs` output for on-screen display: the
 * base (generic) renderer first, everything else after, in matchRenderers'
 * own relative order. matchRenderers itself puts rung-1/2 matches first
 * and the base last (see its own header comment) — that's the right
 * internal priority order for CHOOSING a preselection, but the opposite
 * of how the tabs should read left-to-right (complimentary tab first,
 * most specific rightmost — see the F3 design discussion), so this is a
 * display-only reordering, never re-deciding which tab is preselected.
 *
 * @param {object[]} tabs — matchRenderers() result's own `tabs` array
 * @returns {object[]} same renderer objects, reordered
 */
function orderRendererTabsForDisplay(tabs) {
  const isBase = (r) => {
    const a = (r && r.abilities) || {};
    const ft = a.file_type;
    const hasFileType = Array.isArray(ft) ? ft.length > 0 : !!ft;
    return !hasFileType && !a.binary_category;
  };
  const base = tabs.filter(isBase);
  const specific = tabs.filter(r => !isBase(r));
  return [...base, ...specific];
}

/**
 * The one pair of renderers with genuine runtime ambiguity: filmstrip's
 * and waveform's renderer.json file_type lists are disjoint (video vs.
 * audio extensions), so extension-based matching only ever preselects
 * ONE of them — but media-extractor decides video-vs-audio itself, via
 * ffprobe, and can disagree with that extension-based guess (its own
 * README documents e.g. an audio-only .m4a vs. a video .mp4 being
 * indistinguishable by container alone). Matched by tab NAME rather than
 * uid deliberately — these two names are fixed, known constants this
 * project chose itself, simpler and more readable at the call site than
 * threading both real uids through just for this one lookup.
 *
 * @param {string} name — a renderer's display name
 * @returns {'Filmstrip'|'Waveform'|null} the sibling name, or null if
 *   `name` isn't one of this pair at all
 */
function siblingMediaRendererName(name) {
  if (name === 'Filmstrip') return 'Waveform';
  if (name === 'Waveform') return 'Filmstrip';
  return null;
}

/**
 * Compose the full HTML document set as an F3 Viewer iframe's `srcdoc` —
 * the CSP-enforcing shell described in the sandboxed-iframe architecture
 * discussion. The extractor's own output is a body-only fragment (never
 * a complete document) and carries no CSP of its own; composing the
 * shell around it is deliberately the parent's job, done here, once, in
 * the one place an iframe's srcdoc actually gets set — never inside an
 * extractor or a worker task. Pure string building, no DOM.
 *
 * `allow-same-origin` must NEVER be added to the iframe's own `sandbox`
 * attribute wherever this is used — that's a caller-side HTML-attribute
 * concern, not something this function can enforce, but it's the other
 * half of the safety story this shell only makes sense alongside.
 *
 * `textStyle`, if given, is emitted as a `body { ... }` rule so the
 * iframe's own text visually matches whatever's currently on screen
 * elsewhere in the Viewer, rather than falling back to the browser's own
 * (theme-unaware) default text color and font — the exact mismatch that
 * produced unreadable dark-on-dark text before this existed. Deliberately
 * NOT computed in here: this module stays pure/DOM-free by design, so the
 * caller is responsible for obtaining these values (e.g. via
 * getComputedStyle() on an already-live reference element) and passing
 * them in as plain strings. A missing/null textStyle just omits the
 * style block — extractor output still renders, using browser defaults,
 * same as before this existed.
 *
 * `selectionStyle`, if given, is emitted as a `::selection { ... }` rule
 * — same reasoning as textStyle, but for the browser's own native
 * text-selection highlight (dragging to select text inside the iframe)
 * rather than falling back to the browser's own theme-unaware default
 * (typically a jarring blue, regardless of the app's own theme). Same
 * caller-obtains-the-values contract, same graceful all-or-nothing
 * omission if incomplete — native selection just uses the browser
 * default in that case, same as before this existed.
 *
 * Always emits one base rule regardless of textStyle: `html,body{height:
 * 100%;margin:0;}`. Without it, an extractor's own height:100% (e.g.
 * image-extractor's flex-centering wrapper around its thumbnail) has
 * nothing meaningful to compute against — a percentage height against an
 * ancestor whose own height is auto (unset) is ignored per the CSS spec,
 * not just quietly wrong, since <body>'s default height is always auto
 * unless something says otherwise. This establishes that real, non-auto
 * chain once, here, so every extractor's own percentage-based sizing
 * actually works as written rather than each one needing to somehow
 * establish it independently. margin:0 removes body's default margin,
 * which would otherwise make even a correctly-100%-tall body slightly
 * taller than the iframe's own viewport and force an unwanted scrollbar.
 *
 * @param {string} bodyHtml — the extractor's own HTML output, verbatim
 * @param {{color:string, fontFamily:string, fontSize:string}} [textStyle]
 * @param {{backgroundColor:string, color:string}} [selectionStyle]
 * @returns {string} a complete HTML document string, ready for `srcdoc`
 */
function composeIframeDocument(bodyHtml, textStyle, selectionStyle) {
  const baseStyle = '<style>html,body{height:100%;margin:0;}</style>';
  const themeStyle = (textStyle && textStyle.color && textStyle.fontFamily && textStyle.fontSize)
    ? `<style>body{color:${textStyle.color};font-family:${textStyle.fontFamily};font-size:${textStyle.fontSize};}</style>`
    : '';
  const selectionStyleRule = (selectionStyle && selectionStyle.backgroundColor && selectionStyle.color)
    ? `<style>::selection{background-color:${selectionStyle.backgroundColor};color:${selectionStyle.color};}</style>`
    : '';
  return (
    '<!DOCTYPE html><html><head><meta charset="utf-8">' +
    '<meta http-equiv="Content-Security-Policy" content="' +
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:;" +
    '">' + baseStyle + themeStyle + selectionStyleRule + '</head><body>' + (bodyHtml || '') + '</body></html>'
  );
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
  fmtSizeVerbose,
  formatFileTooLargeError,
  fmtDate,
  shortenPath,
  basenameSelectionEnd,
  escHtml,
  fkeyEnabledState,
  canRename,
  canOpenWith,
  canCreateFile,
  createFileDialogHeader,
  renameDialogHeader,
  renameErrorMessage,
  typeMismatchMessage,
  isMacBundleDir,
  decideEnterAction,
  classifyMime,
  extOf,
  resolveFileHandler,
  opConfirmMessage,
  copyDialogHeader,
  copyReport,
  prefixedName,
  describeViewerSelection,
  viewerKindLabel,
  viewerPermissionGrid,
  viewerRendererClassification,
  orderRendererTabsForDisplay,
  siblingMediaRendererName,
  composeIframeDocument,
  makeDebounced,
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
