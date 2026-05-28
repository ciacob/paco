'use strict';

/**
 * paco/task-helpers.js
 *
 * Reusable building blocks shared across PACO tasks.
 *
 * Keeps individual task files thin: they describe WHAT to do,
 * not the boilerplate of bootstrapping context, listing directories,
 * or assembling result objects.
 */

const nodePath = require('path');
const context  = require('./context');
const fs       = require('./fs-provider');

// ─── Bootstrap ────────────────────────────────────────────────────────────────

/**
 * Bootstrap context and read config + state in one call.
 * Safe to call multiple times (idempotent).
 *
 * @returns {{ config: object, state: object }}
 */
function boot() {
  context.bootstrap();
  return {
    config: context.readConfig(),
    state:  context.readState(),
  };
}

// ─── Panel refresh ────────────────────────────────────────────────────────────

/**
 * Produce a navigate-style result payload for a single panel.
 * Used by tasks that modify the filesystem and need to refresh the UI.
 *
 * Reads the current panel path from disk (so it reflects any updates
 * the task just made), lists the directory, builds breadcrumbs, and
 * assembles the full result the UI expects.
 *
 * @param {string}  panel      — 'left' | 'right'
 * @param {string}  [pathOverride] — if provided, use this path instead of
 *                                   what is stored in panel state
 * @returns {Promise<object>}  — navigate-compatible result payload
 */
async function refreshPanel(panel, pathOverride) {
  const config       = context.readConfig();
  const state        = context.readState();
  const panelState   = state.panels[panel];
  const dirPath      = nodePath.resolve(pathOverride || panelState.path);

  let entries;
  try {
    entries = await fs.list(dirPath, {
      showHidden: config.showHidden,
      sortBy:     config.sortBy,
      sortAsc:    config.sortAsc,
    });
  } catch (_) {
    entries = [];
  }

  let volumes;
  try { volumes = await fs.listVolumes(); } catch (_) { volumes = []; }

  const crumbs         = fs.breadcrumbs(dirPath);
  const updatedHistory = context.readHistory();

  return {
    panel,
    path:        dirPath,
    entries,
    breadcrumbs: crumbs,
    panelState:  context.readState().panels[panel],
    history:     updatedHistory[panel],
    volumes,
    config,
  };
}

/**
 * Refresh both panels and return their payloads.
 * The UI handler in paco-app.js applies navigate results for any panel key
 * it finds in the result, so returning both is safe.
 *
 * @returns {Promise<{ left: object, right: object }>}
 */
async function refreshBothPanels() {
  const [left, right] = await Promise.all([
    refreshPanel('left'),
    refreshPanel('right'),
  ]);
  return { left, right };
}

// ─── Path resolution ──────────────────────────────────────────────────────────

/**
 * Resolve and validate an absolute path from config input.
 * Throws a descriptive Error if the path is invalid or not absolute
 * after resolution.
 *
 * @param {string} rawPath
 * @returns {string} resolved absolute path
 */
function resolvePath(rawPath) {
  if (!rawPath && rawPath !== '') throw new Error('Path is required');
  const resolved = nodePath.resolve(rawPath);
  return resolved;
}

/**
 * Compute the destination path for a single source item being copied/moved
 * into a target directory.
 *
 * e.g. src='/home/a/foo.txt', dstDir='/home/b' → '/home/b/foo.txt'
 *
 * @param {string} srcPath
 * @param {string} dstDir
 * @returns {string}
 */
function dstFor(srcPath, dstDir) {
  return nodePath.join(dstDir, nodePath.basename(srcPath));
}

// ─── Progress math ────────────────────────────────────────────────────────────

/**
 * Given a set of items with known sizes, produce a progress-tracking
 * closure that maps per-item byte progress onto an overall percentage
 * range [rangeStart, rangeEnd].
 *
 * Returns a function: (itemIndex, bytesDone, itemTotal) => overallPct
 *
 * @param {number[]} sizes        — byte size of each item (0 for dirs)
 * @param {number}   rangeStart   — percentage at which this phase starts (e.g. 10)
 * @param {number}   rangeEnd     — percentage at which this phase ends   (e.g. 95)
 * @returns {Function}
 */
function makeProgressTracker(sizes, rangeStart, rangeEnd) {
  const total    = sizes.reduce((s, n) => s + n, 0) || 1; // avoid /0
  const range    = rangeEnd - rangeStart;
  // Cumulative byte offset of each item's start
  const offsets  = sizes.reduce((acc, s) => {
    acc.push((acc[acc.length - 1] || 0) + s);
    return acc;
  }, []);

  return function trackProgress(itemIndex, bytesDone, itemTotal) {
    const baseBytes  = itemIndex > 0 ? offsets[itemIndex - 1] : 0;
    const doneBytes  = baseBytes + bytesDone;
    return Math.round(rangeStart + (doneBytes / total) * range);
  };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  boot,
  refreshPanel,
  refreshBothPanels,
  resolvePath,
  dstFor,
  makeProgressTracker,
};
