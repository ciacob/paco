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
  state:      path.join(PACO_DIR, 'state.json'),
  history:    path.join(PACO_DIR, 'history.json'),
  operations: path.join(PACO_DIR, 'operations.json'),
  config:     path.join(PACO_DIR, 'config.json'),
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

  _ensureFile(PATHS.state,      DEFAULT_STATE);
  _ensureFile(PATHS.history,    DEFAULT_HISTORY);
  _ensureFile(PATHS.operations, DEFAULT_OPERATIONS);
  _ensureFile(PATHS.config,     DEFAULT_CONFIG);

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

  readConfig,
  writeConfig,
  updateConfig,
};
