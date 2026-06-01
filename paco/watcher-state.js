'use strict';

/**
 * paco/watcher-state.js
 *
 * Pure functions for the directory watcher logic.
 * No fs.watch, no WS, no side effects — fully testable.
 */

// ─── Debounce factory ─────────────────────────────────────────────────────────

/**
 * Returns a debounced version of fn that fires after `delayMs` of silence.
 * Each call resets the timer. The returned function also exposes `.cancel()`.
 *
 * Pure in the sense that it's a deterministic factory — the returned closure
 * has side effects (timers) but the factory itself is testable via fake timers.
 *
 * @param {Function} fn
 * @param {number}   delayMs
 * @param {object}   [timers]  — injectable { setTimeout, clearTimeout } for testing
 */
function makeDebounced(fn, delayMs, timers) {
  const t = timers || { setTimeout, clearTimeout };
  let handle = null;
  const debounced = (...args) => {
    if (handle !== null) t.clearTimeout(handle);
    handle = t.setTimeout(() => { handle = null; fn(...args); }, delayMs);
  };
  debounced.cancel = () => { if (handle !== null) { t.clearTimeout(handle); handle = null; } };
  return debounced;
}

// ─── Path matching ────────────────────────────────────────────────────────────

/**
 * Normalise a directory path for comparison — resolve trailing separators,
 * lower-case on Windows (case-insensitive FS).
 *
 * @param {string} p
 * @returns {string}
 */
function normalisePath(p) {
  if (!p) return '';
  let n = p.replace(/[\\/]+$/, '');  // strip trailing slashes
  if (process.platform === 'win32') n = n.toLowerCase();
  return n;
}

/**
 * Determine which panels (if any) are watching a given directory path.
 * Returns an array of side strings: [], ['left'], ['right'], or ['left','right'].
 *
 * @param {string}   changedPath   — absolute path that changed
 * @param {object}   panelPaths    — { left: string, right: string }
 * @returns {string[]}
 */
function affectedPanels(changedPath, panelPaths) {
  const norm = normalisePath(changedPath);
  return ['left', 'right'].filter(
    side => normalisePath(panelPaths[side]) === norm
  );
}

// ─── Watch-set diffing ────────────────────────────────────────────────────────

/**
 * Given the previous set of watched paths and the new panel paths,
 * return which paths need to be added and which removed.
 *
 * @param {Set<string>} current   — paths currently being watched (normalised)
 * @param {object}      panels    — { left: string, right: string }
 * @returns {{ toAdd: string[], toRemove: string[] }}
 */
function diffWatchSet(current, panels) {
  const desired = new Set(
    ['left', 'right']
      .map(s => panels[s])
      .filter(Boolean)
      .map(normalisePath)
  );

  const toAdd    = [...desired].filter(p => !current.has(p));
  const toRemove = [...current].filter(p => !desired.has(p));
  return { toAdd, toRemove };
}

// ─── Navigate decision ────────────────────────────────────────────────────────

/**
 * Decide whether an external change should trigger a navigate refresh.
 *
 * Returns true only when:
 *   - the worker is idle (no task running)
 *   - the changed path matches at least one panel
 *   - we're not already mid-boot
 *
 * @param {string}   workerState   — 'idle' | 'running' | 'done' | 'error' | ...
 * @param {string}   bootPhase     — appState.bootPhase
 * @param {string[]} panels        — result of affectedPanels()
 * @returns {boolean}
 */
function shouldRefresh(workerState, bootPhase, panels) {
  if (panels.length === 0)    return false;
  if (workerState !== 'idle') return false;
  if (bootPhase !== 'ready')  return false;
  return true;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = { makeDebounced, normalisePath, affectedPanels, diffWatchSet, shouldRefresh };
