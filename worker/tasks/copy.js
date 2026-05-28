'use strict';

/**
 * worker/tasks/copy.js
 *
 * PACO command task: copy one or more files/directories to a target directory.
 *
 * Config:
 *   {string[]} sources   — absolute paths of items to copy
 *   {string}   dst       — absolute path of destination directory
 *   {string}   panel     — active panel ('left'|'right'), refreshed after copy
 *   {string}   dstPanel  — other panel ('left'|'right'), also refreshed
 *
 * Behaviour:
 *   - Pre-scans all sources to compute total byte count (enables accurate progress)
 *   - Copies items one by one, reporting byte-level progress
 *   - Respects ctx.isCancelled() between and during file copies
 *   - On name collision, appends " (copy)" suffix (simple policy; configurable later)
 *   - Refreshes both panels on completion so the UI reflects the new state
 *
 * Result:
 *   {number}  copied       — number of items successfully copied
 *   {number}  totalBytes   — total bytes transferred
 *   {string[]} errors      — any non-fatal per-item errors (item skipped, rest continues)
 *   + left/right navigate-compatible panel payloads via refreshBothPanels()
 */

const nodePath = require('path');
const provider = require('../../paco/fs-provider');
const helpers  = require('../../paco/task-helpers');

// ─── Collision resolution ─────────────────────────────────────────────────────

/**
 * Resolve a destination path that does not yet exist.
 * If <dstDir>/<name> is free, return it.
 * Otherwise try "<name> (copy)", "<name> (copy 2)", etc.
 *
 * @param {string} srcPath
 * @param {string} dstDir
 * @returns {Promise<string>}
 */
async function resolveDestination(srcPath, dstDir) {
  const base     = nodePath.basename(srcPath);
  const ext      = nodePath.extname(base);
  const stem     = base.slice(0, base.length - ext.length);

  let candidate = nodePath.join(dstDir, base);
  if (!(await provider.stat(candidate))) return candidate;

  let n = 0;
  while (true) {
    const suffix = n === 0 ? ' (copy)' : ` (copy ${n + 1})`;
    candidate = nodePath.join(dstDir, stem + suffix + ext);
    if (!(await provider.stat(candidate))) return candidate;
    n++;
    if (n > 99) throw new Error(`Too many copies of "${base}" in destination`);
  }
}

// ─── Size scanning ────────────────────────────────────────────────────────────

/**
 * Recursively compute the total byte size of a path (file or directory).
 * Returns 0 for unreadable items rather than throwing.
 *
 * @param {string} itemPath
 * @returns {Promise<number>}
 */
async function totalSize(itemPath) {
  const entry = await provider.stat(itemPath);
  if (!entry) return 0;
  if (entry.type === 'file') return entry.size;
  if (entry.type !== 'dir')  return 0;

  const fsp = require('fs/promises');
  let sum = 0;
  try {
    const children = await fsp.readdir(itemPath);
    for (const child of children) {
      sum += await totalSize(nodePath.join(itemPath, child));
    }
  } catch (_) {}
  return sum;
}

// ─── Task ─────────────────────────────────────────────────────────────────────

module.exports = {
  async start(ctx) {
    const { sources, dst, panel, dstPanel } = ctx.config;

    // ── 1. Bootstrap & validate ───────────────────────────────────────────────
    ctx.progress(2, 'Validating…');
    helpers.boot();

    if (!sources || sources.length === 0) {
      return ctx.fail('No source items specified');
    }
    if (!dst) {
      return ctx.fail('No destination specified');
    }

    // Ensure destination directory exists
    const dstStat = await provider.stat(dst);
    if (!dstStat) {
      return ctx.fail(`Destination does not exist: ${dst}`);
    }
    if (dstStat.type !== 'dir') {
      return ctx.fail(`Destination is not a directory: ${dst}`);
    }

    // Guard against copying into a descendant of itself
    for (const src of sources) {
      const normSrc = nodePath.resolve(src);
      const normDst = nodePath.resolve(dst);
      if (normDst.startsWith(normSrc + nodePath.sep) || normDst === normSrc) {
        return ctx.fail(`Cannot copy "${nodePath.basename(src)}" into itself`);
      }
    }

    // ── 2. Pre-scan sizes ─────────────────────────────────────────────────────
    ctx.progress(5, 'Scanning…');
    const sizes = [];
    for (const src of sources) {
      if (ctx.isCancelled()) return;
      sizes.push(await totalSize(src));
    }
    const grandTotal = sizes.reduce((s, n) => s + n, 0) || 1;
    const tracker    = helpers.makeProgressTracker(sizes, 10, 95);

    // ── 3. Copy items ─────────────────────────────────────────────────────────
    let copiedBytes = 0;
    let copiedCount = 0;
    const errors    = [];

    for (let i = 0; i < sources.length; i++) {
      if (ctx.isCancelled()) break;

      const src     = sources[i];
      const srcName = nodePath.basename(src);

      ctx.progress(tracker(i, 0, sizes[i]), `Copying "${srcName}"…`);

      let dstPath;
      try {
        dstPath = await resolveDestination(src, dst);
      } catch (err) {
        errors.push(`${srcName}: ${err.message}`);
        continue;
      }

      try {
        await provider.copy(src, dstPath, (bytesDone, _itemTotal) => {
          if (ctx.isCancelled()) return;
          const pct = tracker(i, bytesDone, sizes[i]);
          ctx.progress(pct, `Copying "${srcName}"… ${_pct(bytesDone, sizes[i])}`);
        });
        copiedBytes += sizes[i];
        copiedCount++;
      } catch (err) {
        errors.push(`${srcName}: ${err.message}`);
      }
    }

    // ── 4. Refresh both panels ────────────────────────────────────────────────
    ctx.progress(97, 'Refreshing panels…');
    const panels = await helpers.refreshBothPanels();

    ctx.progress(100, `Copied ${copiedCount} item${copiedCount !== 1 ? 's' : ''}`);
    ctx.done({
      copied:     copiedCount,
      totalBytes: copiedBytes,
      errors,
      left:       panels.left,
      right:      panels.right,
    });
  },
};

function _pct(done, total) {
  if (!total) return '';
  return Math.round((done / total) * 100) + '%';
}
