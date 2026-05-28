'use strict';

/**
 * worker/tasks/move.js
 *
 * PACO command task: move one or more files/directories to a target directory.
 *
 * Config:
 *   {string[]} sources   — absolute paths of items to move
 *   {string}   dst       — absolute path of destination directory
 *   {string}   panel     — source panel (refreshed after move)
 *   {string}   dstPanel  — destination panel (also refreshed)
 *
 * Behaviour:
 *   - Attempts rename() first (fast, same-volume)
 *   - Falls back to copy+delete for cross-volume moves, with byte-level progress
 *   - Collision handling: same " (copy)" suffix strategy as copy.js
 *   - Respects ctx.isCancelled() between items
 *   - Refreshes both panels on completion
 *
 * Result:
 *   {number}   moved     — number of items successfully moved
 *   {string[]} errors    — per-item error messages
 *   + left/right navigate-compatible panel payloads
 */

const nodePath = require('path');
const provider = require('../../paco/fs-provider');
const helpers  = require('../../paco/task-helpers');

// Reuse the same collision-resolution logic as copy.js
async function resolveDestination(srcPath, dstDir) {
  const base = nodePath.basename(srcPath);
  const ext  = nodePath.extname(base);
  const stem = base.slice(0, base.length - ext.length);

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

module.exports = {
  async start(ctx) {
    const { sources, dst, panel, dstPanel } = ctx.config;

    // ── 1. Bootstrap & validate ───────────────────────────────────────────────
    ctx.progress(2, 'Validating…');
    helpers.boot();

    if (!sources || sources.length === 0) return ctx.fail('No source items specified');
    if (!dst) return ctx.fail('No destination specified');

    const dstStat = await provider.stat(dst);
    if (!dstStat)              return ctx.fail(`Destination does not exist: ${dst}`);
    if (dstStat.type !== 'dir') return ctx.fail(`Destination is not a directory: ${dst}`);

    for (const src of sources) {
      const normSrc = nodePath.resolve(src);
      const normDst = nodePath.resolve(dst);
      if (normDst.startsWith(normSrc + nodePath.sep) || normDst === normSrc) {
        return ctx.fail(`Cannot move "${nodePath.basename(src)}" into itself`);
      }
    }

    // ── 2. Pre-scan for cross-volume progress tracking ────────────────────────
    ctx.progress(5, 'Scanning…');
    const sizes = [];
    for (const src of sources) {
      if (ctx.isCancelled()) return;
      sizes.push(await totalSize(src));
    }
    const tracker = helpers.makeProgressTracker(sizes, 10, 95);

    // ── 3. Move items ─────────────────────────────────────────────────────────
    let moved = 0;
    const errors = [];

    for (let i = 0; i < sources.length; i++) {
      if (ctx.isCancelled()) break;

      const src     = sources[i];
      const srcName = nodePath.basename(src);

      ctx.progress(tracker(i, 0, sizes[i]), `Moving "${srcName}"…`);

      let dstPath;
      try {
        dstPath = await resolveDestination(src, dst);
      } catch (err) {
        errors.push(`${srcName}: ${err.message}`);
        continue;
      }

      try {
        await provider.move(src, dstPath, (bytesDone, itemTotal) => {
          if (ctx.isCancelled()) return;
          const pct = tracker(i, bytesDone, sizes[i]);
          ctx.progress(pct, `Moving "${srcName}"…`);
        });
        moved++;
      } catch (err) {
        errors.push(`${srcName}: ${err.message}`);
      }
    }

    // ── 4. Refresh both panels ────────────────────────────────────────────────
    ctx.progress(97, 'Refreshing panels…');
    const panels = await helpers.refreshBothPanels();

    ctx.progress(100, `Moved ${moved} item${moved !== 1 ? 's' : ''}`);
    ctx.done({
      moved,
      errors,
      left:  panels.left,
      right: panels.right,
    });
  },
};
