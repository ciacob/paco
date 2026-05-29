'use strict';

/**
 * worker/tasks/copy.js
 *
 * PACO command task: copy one or more files/directories to a target directory.
 *
 * Config:
 *   {string[]} sources              — absolute paths to copy
 *   {string}   dst                  — destination directory (must exist)
 *   {string}   panel                — source panel id (refreshed after)
 *   {string}   dstPanel             — destination panel id (refreshed after)
 *   {string}   conflictFiles        — 'abort'|'replaceOlder'|'replaceAll'|'prefix'
 *   {string}   conflictFolders      — 'abort'|'merge'|'replace'|'prefix'
 *   {boolean}  showHidden           — include hidden files in copy
 *   {boolean}  keepOnAbort          — keep fully-copied files if aborted
 *
 * Progress payload (sent via ctx.progress):
 *   percent, message, extra: {
 *     itemIndex, itemCount, itemName,
 *     kbDone, kbTotal, speedKbps, etaSec
 *   }
 *
 * Result:
 *   {object}   stats      — copy statistics (see copyReport helper)
 *   {boolean}  aborted    — true if operation was aborted by user
 *   {string[]} errors     — non-fatal per-item errors
 *   + left/right panel payloads via refreshBothPanels()
 */

const nodePath = require('path');
const fsp      = require('fs/promises');
const fs       = require('fs');
const provider = require('../../paco/fs-provider');
const helpers  = require('../../paco/task-helpers');

// ─── Size scanning ────────────────────────────────────────────────────────────

async function scanSize(itemPath, showHidden) {
  const entry = await provider.stat(itemPath);
  if (!entry) return 0;
  if (entry.hidden && !showHidden) return 0;
  if (entry.type === 'file') return entry.size;
  if (entry.type !== 'dir')  return 0;
  let sum = 0;
  try {
    const children = await fsp.readdir(itemPath);
    for (const child of children) {
      if (!showHidden && child.startsWith('.')) continue;
      sum += await scanSize(nodePath.join(itemPath, child), showHidden);
    }
  } catch (_) {}
  return sum;
}

// ─── Prefixed name resolution ─────────────────────────────────────────────────

async function resolvePrefixedName(srcPath, dstDir) {
  const base = nodePath.basename(srcPath);
  let existing;
  try {
    existing = new Set(await fsp.readdir(dstDir));
  } catch (_) {
    existing = new Set();
  }
  if (!existing.has(base)) return nodePath.join(dstDir, base);
  for (let n = 1; n <= 999; n++) {
    const candidate = `(${n}) ${base}`;
    if (!existing.has(candidate)) return nodePath.join(dstDir, candidate);
  }
  return nodePath.join(dstDir, `(${Date.now()}) ${base}`);
}

// ─── Core copy engine ─────────────────────────────────────────────────────────

/**
 * Copy a single file, calling onBytes(bytesDone, total) periodically.
 * Throttled: only fires callback when ≥64KB new or ≥200ms elapsed.
 */
async function copyFile(src, dst, size, onBytes) {
  await fsp.mkdir(nodePath.dirname(dst), { recursive: true });
  return new Promise((resolve, reject) => {
    let done = 0;
    let lastNotify = 0;
    let lastTime   = Date.now();
    const THROTTLE_BYTES = 64 * 1024;
    const THROTTLE_MS    = 200;

    const rd = fs.createReadStream(src);
    const wr = fs.createWriteStream(dst);

    rd.on('data', chunk => {
      done += chunk.length;
      const now = Date.now();
      if (onBytes && (done - lastNotify >= THROTTLE_BYTES || now - lastTime >= THROTTLE_MS)) {
        onBytes(done, size);
        lastNotify = done;
        lastTime   = now;
      }
    });
    rd.on('error', reject);
    wr.on('error', reject);
    wr.on('finish', () => { if (onBytes) onBytes(done, size); resolve(); });
    rd.pipe(wr);
  });
}

/**
 * Copy a directory tree recursively.
 * Returns { copied, prefixed, replacedOlder, skippedNewer, skippedSecurity }.
 */
async function copyDir(src, dst, opts, onBytes, copiedPaths) {
  const stats = { copied:0, prefixed:0, replacedOlder:0, skippedNewer:0, skippedSecurity:0 };
  await fsp.mkdir(dst, { recursive: true });

  let children;
  try { children = await fsp.readdir(src, { withFileTypes: true }); }
  catch (_) { stats.skippedSecurity++; return stats; }

  for (const dirent of children) {
    if (opts.isCancelled && opts.isCancelled()) break;
    if (!opts.showHidden && dirent.name.startsWith('.')) continue;

    const srcChild = nodePath.join(src, dirent.name);
    const dstChild = nodePath.join(dst, dirent.name);

    if (dirent.isDirectory()) {
      // Check folder conflict
      const dstExists = await provider.stat(dstChild);
      if (dstExists) {
        if (opts.conflictFolders === 'abort') {
          opts.abortReason = dirent.name;
          opts.abortSignal = true;
          return stats;
        }
        if (opts.conflictFolders === 'replace') {
          await provider.remove(dstChild);
        }
        // 'merge' and 'prefix' handled below
      }

      let effectiveDst = dstChild;
      if (dstExists && opts.conflictFolders === 'prefix') {
        effectiveDst = await resolvePrefixedName(srcChild, dst);
        stats.prefixed++;
      }

      const sub = await copyDir(srcChild, effectiveDst, opts, onBytes, copiedPaths);
      stats.copied         += sub.copied;
      stats.prefixed       += sub.prefixed;
      stats.replacedOlder  += sub.replacedOlder;
      stats.skippedNewer   += sub.skippedNewer;
      stats.skippedSecurity+= sub.skippedSecurity;
      if (opts.abortSignal) return stats;

    } else {
      // It's a file (or symlink treated as file)
      const dstExists = await provider.stat(dstChild);
      if (dstExists) {
        if (opts.conflictFiles === 'abort') {
          opts.abortReason = dirent.name;
          opts.abortSignal = true;
          return stats;
        }
        if (opts.conflictFiles === 'replaceOlder') {
          const srcStat = await provider.stat(srcChild);
          const dstStat = dstExists;
          if (srcStat && srcStat.mtime <= dstStat.mtime) {
            stats.skippedNewer++;
            continue;
          }
          stats.replacedOlder++;
        } else if (opts.conflictFiles === 'prefix') {
          const prefixedDst = await resolvePrefixedName(srcChild, dst);
          try {
            const size = (await provider.stat(srcChild))?.size || 0;
            await copyFile(srcChild, prefixedDst, size, onBytes);
            copiedPaths.push(prefixedDst);
            stats.prefixed++;
          } catch (_) { stats.skippedSecurity++; }
          continue;
        }
        // replaceAll falls through to overwrite
      }

      try {
        const size = (await provider.stat(srcChild))?.size || 0;
        await copyFile(srcChild, dstChild, size, onBytes);
        copiedPaths.push(dstChild);
        if (!dstExists) stats.copied++;
      } catch (_) { stats.skippedSecurity++; }
    }
  }
  return stats;
}

// ─── Cleanup ──────────────────────────────────────────────────────────────────

async function cleanupCopied(paths) {
  for (const p of paths) {
    try { await provider.remove(p); } catch (_) {}
  }
}

// ─── Task ─────────────────────────────────────────────────────────────────────

module.exports = {
  async start(ctx) {
    const {
      sources,
      dst,
      panel,
      dstPanel,
      conflictFiles   = 'abort',
      conflictFolders = 'abort',
      showHidden      = false,
      keepOnAbort     = false,
      showReport      = true,
    } = ctx.config;

    // ── 1. Validate & persist prefs ──────────────────────────────────────────
    ctx.progress(2, 'Validating…', {});
    const context = require('../../paco/context');
    helpers.boot();

    // Persist the user's dialog preferences for next time
    context.updateConfig({
      copyConflictFiles:   conflictFiles,
      copyConflictFolders: conflictFolders,
      copyKeepOnAbort:     keepOnAbort,
      copyShowReport:      showReport,
    });

    if (!sources || sources.length === 0) return ctx.fail('No source items specified');
    if (!dst) return ctx.fail('No destination specified');

    const dstStat = await provider.stat(dst);
    if (!dstStat)              return ctx.fail(`Destination does not exist: ${dst}`);
    if (dstStat.type !== 'dir') return ctx.fail(`Destination is not a directory: ${dst}`);

    for (const src of sources) {
      const n = nodePath.resolve(src), d = nodePath.resolve(dst);
      if (d.startsWith(n + nodePath.sep) || d === n)
        return ctx.fail(`Cannot copy "${nodePath.basename(src)}" into itself`);
    }

    // ── 2. Pre-scan sizes (enables ETA) ──────────────────────────────────────
    ctx.progress(3, 'Scanning…', {});
    const sizes = [];
    for (const src of sources) {
      if (ctx.isCancelled()) return ctx.fail('Cancelled');
      sizes.push(await scanSize(src, showHidden));
    }
    const totalKb   = Math.max(1, Math.round(sizes.reduce((a, b) => a + b, 0) / 1024));
    const startTime = Date.now();
    let   doneBytes = 0;
    let   doneKb    = 0;
    const copiedPaths = [];  // track for cleanup-on-abort

    // ── Progress helper ───────────────────────────────────────────────────────
    function pushProgress(pct, itemIndex, itemName, itemKbDone, itemKbTotal) {
      const elapsedSec = (Date.now() - startTime) / 1000 || 0.001;
      const speedKbps  = Math.round(doneKb / elapsedSec);
      const remaining  = totalKb - doneKb;
      const etaSec     = speedKbps > 0 ? Math.round(remaining / speedKbps) : null;
      ctx.progress(pct, `Copying "${itemName}"…`, {
        itemIndex,
        itemCount:  sources.length,
        itemName,
        kbDone:     doneKb,
        kbTotal:    totalKb,
        speedKbps,
        etaSec,
      });
    }

    // ── 3. Copy items ─────────────────────────────────────────────────────────
    const totalStats = {
      copied:0, prefixed:0, replacedOlder:0, skippedNewer:0,
      mergedFolders:0, skippedSecurity:0, aborted:0, abortReason:'',
    };
    const errors = [];
    let   aborted = false;

    for (let i = 0; i < sources.length; i++) {
      if (ctx.isCancelled()) { aborted = true; break; }

      const src     = sources[i];
      const srcName = nodePath.basename(src);
      const srcStat = await provider.stat(src);

      if (!srcStat || (srcStat.hidden && !showHidden)) continue;

      pushProgress(Math.round(5 + (i / sources.length) * 88), i, srcName, 0, sizes[i] / 1024);

      // Per-item byte callback
      const onBytes = (bytesDone, _total) => {
        doneBytes = doneBytes - (_total > 0 ? 0 : 0); // running total updated below
        doneKb = Math.round(doneBytes / 1024);
        const pct = Math.round(5 + ((i + bytesDone / Math.max(1, sizes[i])) / sources.length) * 88);
        pushProgress(pct, i, srcName, Math.round(bytesDone / 1024), Math.round(sizes[i] / 1024));
      };

      if (srcStat.type === 'dir') {
        const dstPath  = nodePath.join(dst, srcName);
        const dstExists = await provider.stat(dstPath);

        if (dstExists) {
          if (conflictFolders === 'abort') {
            totalStats.aborted = 1;
            totalStats.abortReason = srcName;
            aborted = true;
            break;
          }
          if (conflictFolders === 'replace') {
            try { await provider.remove(dstPath); } catch (e) {
              errors.push(`${srcName}: ${e.message}`); continue;
            }
          }
        }

        let effectiveDst = dstPath;
        if (dstExists && conflictFolders === 'prefix') {
          effectiveDst = await resolvePrefixedName(src, dst);
          totalStats.prefixed++;
        }

        const isMerge = dstExists && conflictFolders === 'merge';
        if (isMerge) totalStats.mergedFolders++;

        const opts = {
          conflictFiles, conflictFolders, showHidden,
          isCancelled: () => ctx.isCancelled(),
          abortSignal: false, abortReason: '',
        };

        try {
          const sub = await copyDir(src, effectiveDst, opts, (bd, bt) => {
            doneBytes += Math.max(0, bd - (doneBytes % Math.max(1, bt)));
            doneKb = Math.round(doneBytes / 1024);
          }, copiedPaths);

          if (opts.abortSignal) {
            totalStats.aborted = 1;
            totalStats.abortReason = opts.abortReason;
            aborted = true;
            break;
          }

          totalStats.copied         += sub.copied;
          totalStats.prefixed       += sub.prefixed;
          totalStats.replacedOlder  += sub.replacedOlder;
          totalStats.skippedNewer   += sub.skippedNewer;
          totalStats.skippedSecurity+= sub.skippedSecurity;
          copiedPaths.push(effectiveDst);
          doneBytes += sizes[i];
          doneKb = Math.round(doneBytes / 1024);
        } catch (e) {
          errors.push(`${srcName}: ${e.message}`);
        }

      } else {
        // File
        const dstPath   = nodePath.join(dst, srcName);
        const dstExists = await provider.stat(dstPath);

        if (dstExists) {
          if (conflictFiles === 'abort') {
            totalStats.aborted = 1;
            totalStats.abortReason = srcName;
            aborted = true;
            break;
          }
          if (conflictFiles === 'replaceOlder') {
            if (srcStat.mtime <= dstExists.mtime) {
              totalStats.skippedNewer++;
              doneBytes += sizes[i];
              doneKb = Math.round(doneBytes / 1024);
              continue;
            }
            totalStats.replacedOlder++;
          }
          // replaceAll falls through
        }

        let effectiveDst = dstPath;
        if (dstExists && conflictFiles === 'prefix') {
          effectiveDst = await resolvePrefixedName(src, dst);
          totalStats.prefixed++;
        } else if (!dstExists) {
          totalStats.copied++;
        }

        try {
          await copyFile(src, effectiveDst, sizes[i], (bd, bt) => {
            doneBytes = (doneBytes - sizes[i]) + bd;  // replace estimate with actual
            if (doneBytes < 0) doneBytes = 0;
            doneKb = Math.round(doneBytes / 1024);
            const pct = Math.round(5 + ((i + bd / Math.max(1, bt)) / sources.length) * 88);
            pushProgress(pct, i, srcName, Math.round(bd / 1024), Math.round(sizes[i] / 1024));
          });
          copiedPaths.push(effectiveDst);
          doneBytes = sizes.slice(0, i + 1).reduce((a, b) => a + b, 0);
          doneKb = Math.round(doneBytes / 1024);
        } catch (e) {
          errors.push(`${srcName}: ${e.message}`);
          totalStats.copied = Math.max(0, totalStats.copied - 1);
        }
      }
    }

    // ── 4. Handle abort cleanup ───────────────────────────────────────────────
    if (aborted && !keepOnAbort) {
      ctx.progress(96, 'Reverting…', {});
      await cleanupCopied(copiedPaths);
    }

    // ── 5. Refresh panels ─────────────────────────────────────────────────────
    ctx.progress(98, 'Refreshing…', {});
    const panels = await helpers.refreshBothPanels();

    ctx.progress(100, aborted ? 'Aborted' : 'Done', {});
    ctx.done({
      stats:   totalStats,
      aborted,
      errors,
      left:    panels.left,
      right:   panels.right,
    });
  },
};
