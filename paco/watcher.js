'use strict';

/**
 * paco/watcher.js
 *
 * Watches the directories currently open in both panels using fs.watch().
 * When a change is detected, broadcasts a { state:'watch', panel, path }
 * message over the WS feed so the UI can refresh the affected panel.
 *
 * Lifecycle:
 *   start(broadcast)  — begin watching; call whenever server boots
 *   update(panels)    — call whenever panel paths change (after every navigate)
 *   stop()            — release all watchers (on server shutdown)
 *
 * Design notes:
 *   - Each unique directory path gets one fs.watch() instance, shared across
 *     panels (both panels open to the same dir = one watcher, two refreshes).
 *   - Changes are debounced 350ms to coalesce rapid filesystem events (e.g.
 *     a move operation may fire multiple events in quick succession).
 *   - fs.watch() on macOS/Linux watches immediate children only — which is
 *     exactly what we need (listed entries changed).
 *   - On error (e.g. watched dir deleted), the watcher is silently removed.
 */

const fs      = require('fs');
const context = require('./context');
const WS      = require('./watcher-state');

// Map of normalisedPath → { watcher: fs.FSWatcher, debounced: Function }
const watching = new Map();

let _broadcast = null;  // injected by start()

// ─── Public API ───────────────────────────────────────────────────────────────

function start(broadcastFn) {
  _broadcast = broadcastFn;
  _sync();
}

/**
 * Call after every navigate task completes to update watched paths.
 * Reads panel paths directly from context (source of truth on disk).
 */
function update() {
  _sync();
}

function stop() {
  for (const [, entry] of watching) {
    entry.debounced.cancel();
    try { entry.watcher.close(); } catch (_) {}
  }
  watching.clear();
}

// ─── Internal ─────────────────────────────────────────────────────────────────

function _currentPanelPaths() {
  try {
    const state = context.readState();
    return {
      left:  state.panels.left.path  || '',
      right: state.panels.right.path || '',
    };
  } catch (_) {
    return { left: '', right: '' };
  }
}

function _sync() {
  const panels = _currentPanelPaths();
  const current = new Set(watching.keys());
  const { toAdd, toRemove } = WS.diffWatchSet(current, panels);

  for (const p of toRemove) {
    const entry = watching.get(p);
    if (entry) {
      entry.debounced.cancel();
      try { entry.watcher.close(); } catch (_) {}
    }
    watching.delete(p);
  }

  for (const p of toAdd) {
    _addWatcher(p, panels);
  }
}

function _addWatcher(normPath, panels) {
  // Find the original (un-normalised) path for fs.watch
  const origPath = normPath;  // normalisePath is idempotent for our purposes

  let watcher;
  try {
    watcher = fs.watch(origPath, { persistent: false }, (eventType, filename) => {
      // Debounced handler fires after 350ms of silence
      entry.debounced(origPath);
    });
  } catch (_) {
    return;  // Directory may not exist yet or not watchable — skip silently
  }

  watcher.on('error', () => {
    watching.delete(normPath);
    try { watcher.close(); } catch (_) {}
  });

  const debounced = WS.makeDebounced((changedPath) => {
    if (!_broadcast) return;
    const current = _currentPanelPaths();
    const affected = WS.affectedPanels(changedPath, current);
    for (const side of affected) {
      _broadcast({ state: 'watch', panel: side, path: changedPath });
    }
  }, 350);

  const entry = { watcher, debounced };
  watching.set(normPath, entry);
}

module.exports = { start, update, stop };
