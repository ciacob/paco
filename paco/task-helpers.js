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
const fsp      = require('fs/promises');
const fsConstants = require('fs').constants;
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

  // Whether the LISTED DIRECTORY ITSELF (not its children) is writable —
  // i.e. can new files/folders be created inside it. Checked fresh on every
  // refresh (every navigation, and after every operation that re-lists a
  // panel) so it's never more than one round-trip stale. Uses Node's own
  // fs.access(W_OK), which is known to be unreliable on Windows (it can
  // report writable for a folder that's actually inaccessible there) — an
  // accepted, documented gap; the task that actually writes still catches
  // and humanizes any real permission error regardless of what this flag says.
  let directoryWritable = true;
  try {
    await fsp.access(dirPath, fsConstants.W_OK);
  } catch (_) {
    directoryWritable = false;
  }

  return {
    panel,
    path:        dirPath,
    entries,
    breadcrumbs: crumbs,
    panelState:  context.readState().panels[panel],
    history:     updatedHistory[panel],
    volumes,
    config,
    directoryWritable,
    // The worker's actual OS — NOT a persisted preference, just a runtime
    // fact the UI needs (e.g. to decide whether a folder is a macOS bundle).
    // Deliberately kept separate from `config` since it isn't user-editable
    // and shouldn't ever be written back to config.json.
    platform: process.platform,
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
 * Resolve the directory a panel should open at startup.
 *
 * Preference order:
 *   1. An explicitly requested path (e.g. user clicked a breadcrumb) — used as-is.
 *   2. The last-known panel path persisted on disk, IF it still exists and is
 *      a readable directory.
 *   3. The OS home directory, as the ultimate fallback.
 *
 * This is what lets PACO "reopen where the user last was" across sessions,
 * while degrading gracefully if that directory was deleted, unmounted
 * (e.g. an external drive), or otherwise became inaccessible.
 *
 * @param {string} requestedPath  — explicit path from the caller ('' = none)
 * @param {string} savedPath      — last-known path from context.readState()
 * @returns {Promise<string>}     — a path guaranteed to exist as a readable dir,
 *                                  or the home directory if nothing else works
 */
async function resolveStartupPath(requestedPath, savedPath) {
  const os = require('os');

  if (requestedPath) {
    return nodePath.resolve(requestedPath);
  }

  if (savedPath) {
    const resolvedSaved = nodePath.resolve(savedPath);
    try {
      const entry = await fs.stat(resolvedSaved);
      if (entry && entry.type === 'dir' && entry.readable) {
        return resolvedSaved;
      }
    } catch (_) {
      // fall through to home
    }
  }

  return os.homedir();
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
  resolveStartupPath,
  dstFor,
  makeProgressTracker,
};
