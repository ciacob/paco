'use strict';

/**
 * paco/context.js
 *
 * Single owner of the ~/.paco/ directory. Every task, event, and UI bootstrap
 * that needs to read or write persistent state goes through here. Nothing else
 * touches ~/.paco/ directly.
 *
 * Files managed:
 *   ~/.paco/state.json      — panel paths, selections, tabs, active panel
 *   ~/.paco/history.json    — per-panel navigation history (ordered, capped)
 *   ~/.paco/operations.json — user-defined operations
 *   ~/.paco/config.json     — user preferences (theme, editor, show hidden, …)
 *
 * All public functions are synchronous where it is safe (small JSON files),
 * and expose an async variant only when write safety matters (e.g. atomic
 * write via temp-file rename). For now, simple fs.writeFileSync is used with
 * a try/catch; atomic writes can be swapped in later without changing callers.
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');

// ─── Paths ────────────────────────────────────────────────────────────────────

const PACO_DIR = path.join(os.homedir(), '.paco');

const PATHS = {
  state:        path.join(PACO_DIR, 'state.json'),
  history:      path.join(PACO_DIR, 'history.json'),
  operations:   path.join(PACO_DIR, 'operations.json'),
  config:       path.join(PACO_DIR, 'config.json'),
  fileHandlers: path.join(PACO_DIR, 'file-handlers.json'),
};

// ─── Defaults ────────────────────────────────────────────────────────────────

// Bump this when state schema changes in a breaking way.
// bootstrap() resets tabs when it finds a version mismatch.
const STATE_VERSION = 2;

const DEFAULT_STATE = {
  version:     STATE_VERSION,
  activePanel: 'left',
  panels: {
    left: {
      path:      os.homedir(),
      selection: [],
      tabs: [{ id: 'tab-default', path: os.homedir(), label: null }],
      activeTab: 'tab-default',
    },
    right: {
      path:      os.homedir(),
      selection: [],
      tabs: [{ id: 'tab-default', path: os.homedir(), label: null }],
      activeTab: 'tab-default',
    },
  },
};

const DEFAULT_HISTORY = {
  left:  [],
  right: [],
};

const DEFAULT_OPERATIONS = {
  operations: [],
};

// F4 file-handlers cascade: specific extensions → MIME category → fallback.
// See paco/ui-state.js's resolveFileHandler() for how this is consulted.
const DEFAULT_FILE_HANDLERS = {
  // 'nativeOpen' | 'lister' | null — terminal step for non-executable files
  // with no specific or category match. Defaults to today's native-open
  // behaviour so existing installs see no change until they configure this.
  fallback: 'nativeOpen',

  // 'lister' | null — terminal step for EXECUTABLE files specifically.
  // Deliberately excludes 'nativeOpen': F4 must never hand an executable
  // to the OS to run. Defaults to null (no-op) until F3 (the read-only
  // lister) exists to act as a safe fallback.
  exec_fallback: null,

  // Many-extensions-to-one-handler. First match wins. Applies regardless
  // of the executable bit — a specific match is always respected.
  specific: [],

  // One handler per MIME-ish bucket. Any entry may be null (falls through
  // to the fallback/exec_fallback step). Applies regardless of the
  // executable bit, same as `specific`.
  category: {
    text:  null,
    audio: null,
    image: null,
    video: null,
    other: null,
  },
};

const DEFAULT_CONFIG = {
  theme:       'dark',   // 'light' | 'dark'
  showHidden:  false,
  editor:      null,     // null = use system default
  viewer:      null,     // null = use built-in
  confirmDelete: true,
  sortBy:      'name',   // 'name' | 'size' | 'mtime' | 'type'
  sortAsc:     true,
  dateFormat:  'locale', // 'locale' | 'iso'
  appName:     'Partial Commander',

  // Copy dialog preferences — persisted between sessions
  // File conflict strategies: 'abort' | 'replaceOlder' | 'replaceAll' | 'prefix'
  // Folder conflict strategies: 'abort' | 'merge' | 'replace' | 'prefix'
  copyConflictFiles:   'abort',
  copyConflictFolders: 'abort',
  copyShowReport:      true,
  copyKeepOnAbort:     false,

  // Delete
  deleteToTrash: true,   // if true, move to system trash/recycle bin instead of permanent delete

  // New Folder dialog
  mkdirSubDirs: false,  // if true, path separators create nested directories

  // Move dialog preferences (same strategy options as copy)
  moveConflictFiles:   'abort',
  moveConflictFolders: 'abort',
  moveShowReport:      true,
  moveKeepOnAbort:     false,

  // Rename dialog preferences (subset: no merge, no progress/report)
  renameConflictFiles:   'abort',
  renameConflictFolders: 'abort',

  // Twin-panel divider position, as the left panel's share of the
  // available width (0..1). Persisted on drag-end and on double-click
  // reset. The 300px-per-panel minimum is enforced live at render time,
  // not baked into this stored value, so it stays meaningful across
  // different window sizes.
  panelSplit: 0.5,

  // Viewer panel (F3) divider position, as the twin-list-panels' share of
  // the available HEIGHT when the Viewer is open (0..1; the Viewer panel
  // itself gets 1 - viewerSplit). Same persistence model as panelSplit —
  // drag-end and double-click reset — and the same 300px-per-side minimum,
  // just on the vertical axis. Viewer OPEN/CLOSED state itself is
  // deliberately NOT persisted (see worker/tasks/save-config.js callers in
  // paco-app.js) — only the split position is, for whenever it's reopened.
  viewerSplit: 0.5,

  // F3 Viewer detached-child-process timeouts — worker/tasks/extract-
  // preview.js and worker/tasks/calc-size.js each fork a child that could,
  // in principle, hang forever (a native decoder deadlock, a stuck ffmpeg
  // invocation, an unread stdio pipe filling up) without ever crashing or
  // reporting a result — nothing else would ever detect or recover from
  // that. Deliberately two SEPARATE values, not one shared timeout:
  //
  //   extractionTimeoutMs — bounds a single preview render (thumbnail,
  //   formatted-document HTML, filmstrip/waveform). These normally finish
  //   in well under a second, occasionally longer for a large HEIC (WASM
  //   decode) or a multi-frame video filmstrip — 30s is generous headroom
  //   for a genuinely slow-but-working case while still catching a real hang.
  //
  //   calcTimeoutMs — bounds a recursive folder size sum, which can
  //   LEGITIMATELY take minutes for a huge or network-mounted tree. Using
  //   the short extraction timeout here would abort perfectly normal
  //   calculations, not just genuine hangs — 5 minutes is a much longer
  //   grace period appropriate to that very different risk profile.
  extractionTimeoutMs: 30000,
  calcTimeoutMs: 300000,
};

// Maximum navigation history entries kept per panel
const HISTORY_CAP = 200;

// ─── Bootstrap ───────────────────────────────────────────────────────────────

/**
 * Ensure ~/.paco/ exists and all managed files are present.
 * Safe to call multiple times (idempotent).
 */
function bootstrap() {
  if (!fs.existsSync(PACO_DIR)) {
    fs.mkdirSync(PACO_DIR, { recursive: true });
  }

  _ensureFile(PATHS.state,        DEFAULT_STATE);
  _ensureFile(PATHS.history,      DEFAULT_HISTORY);
  _ensureFile(PATHS.operations,   DEFAULT_OPERATIONS);
  _ensureFile(PATHS.config,       DEFAULT_CONFIG);
  _ensureFile(PATHS.fileHandlers, DEFAULT_FILE_HANDLERS);

  // Migrate stale state: reset tabs if state version is missing or outdated.
  // This clears accumulated ghost tabs from pre-versioned sessions.
  _migrateState();
}

function _migrateState() {
  const state = _read(PATHS.state, null);
  if (!state) return;
  if (state.version === STATE_VERSION) return;

  // Reset each panel's tabs to a single default tab, preserving the path.
  for (const side of ['left', 'right']) {
    const panel = state.panels && state.panels[side];
    if (!panel) continue;
    const path = panel.path || os.homedir();
    panel.tabs      = [{ id: 'tab-default', path, label: null }];
    panel.activeTab = 'tab-default';
    panel.selection = [];
  }
  state.version = STATE_VERSION;
  _write(PATHS.state, state);
}

function _ensureFile(filePath, defaultValue) {
  if (!fs.existsSync(filePath)) {
    _write(filePath, defaultValue);
  }
}

// ─── Internal read/write ──────────────────────────────────────────────────────

function _read(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function _write(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

// ─── State ───────────────────────────────────────────────────────────────────

function readState() {
  return _read(PATHS.state, DEFAULT_STATE);
}

function writeState(state) {
  _write(PATHS.state, state);
}

/**
 * Update a single panel's path + selection. Does not touch the other panel.
 * Merges deeply so callers can do partial updates.
 */
function updatePanel(side, updates) {
  const state = readState();
  state.panels[side] = Object.assign({}, state.panels[side], updates);
  writeState(state);
}

function setActivePanel(side) {
  const state = readState();
  state.activePanel = side;
  writeState(state);
}

// ─── History ──────────────────────────────────────────────────────────────────

function readHistory() {
  return _read(PATHS.history, DEFAULT_HISTORY);
}

/**
 * Push a path onto a panel's history stack.
 * Deduplicates consecutive identical entries and caps at HISTORY_CAP.
 */
function pushHistory(side, dirPath) {
  const history = readHistory();
  const stack   = history[side] || [];

  if (stack[stack.length - 1] !== dirPath) {
    stack.push(dirPath);
  }

  if (stack.length > HISTORY_CAP) {
    stack.splice(0, stack.length - HISTORY_CAP);
  }

  history[side] = stack;
  _write(PATHS.history, history);
}

// ─── Operations ───────────────────────────────────────────────────────────────

function readOperations() {
  return _read(PATHS.operations, DEFAULT_OPERATIONS);
}

function writeOperations(ops) {
  _write(PATHS.operations, ops);
}

// ─── File handlers (F4) ─────────────────────────────────────────────────────────

/**
 * Read the F4 file-handlers cascade config. Merges shallowly against
 * defaults so a config file from an older version (missing e.g.
 * `exec_fallback`) still gets a safe default for the missing key, the
 * same way readConfig() does for config.json.
 */
function readFileHandlers() {
  const stored = _read(PATHS.fileHandlers, {});
  return Object.assign({}, DEFAULT_FILE_HANDLERS, stored, {
    category: Object.assign({}, DEFAULT_FILE_HANDLERS.category, stored.category || {}),
  });
}

function writeFileHandlers(fileHandlers) {
  _write(PATHS.fileHandlers, fileHandlers);
}

function updateFileHandlers(updates) {
  const current = readFileHandlers();
  _write(PATHS.fileHandlers, Object.assign({}, current, updates));
}

// ─── Config ───────────────────────────────────────────────────────────────────

function readConfig() {
  const stored = _read(PATHS.config, {});
  // Merge with defaults so new keys added in future releases are present
  return Object.assign({}, DEFAULT_CONFIG, stored);
}

function writeConfig(config) {
  _write(PATHS.config, config);
}

function updateConfig(updates) {
  const config = readConfig();
  _write(PATHS.config, Object.assign({}, config, updates));
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  PACO_DIR,
  PATHS,

  bootstrap,

  readState,
  writeState,
  updatePanel,
  setActivePanel,

  readHistory,
  pushHistory,

  readOperations,
  writeOperations,

  readFileHandlers,
  writeFileHandlers,
  updateFileHandlers,

  readConfig,
  writeConfig,
  updateConfig,
};
