'use strict';

/**
 * paco/copy-engine.js
 *
 * Shared engine for copy and move operations.
 *
 * Move strategy: copy-then-delete.
 *   Phase 1 — copy everything to destination (same as copy operation)
 *   Phase 2 — only if phase 1 completed without abort: delete all sources
 *
 * This gives move the same transactional guarantee as copy:
 *   - On abort: destination copies are cleaned up (unless keepOnAbort),
 *     sources are untouched
 *   - On success: sources are deleted only after all copies are confirmed
 *
 * Same-volume renames are NOT used, sacrificing some speed for correctness.
 * The difference is only material for very large directory trees on the same
 * volume, which is an acceptable tradeoff.
 */

const nodePath = require('path');
const fsp      = require('fs/promises');
const fs       = require('fs');
const provider = require('./fs-provider');
const helpers  = require('./task-helpers');

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

// ─── Prefix-based collision resolution ───────────────────────────────────────

async function resolvePrefixedName(srcPath, dstDir) {
  const base = nodePath.basename(srcPath);
  let existing;
  try { existing = new Set(await fsp.readdir(dstDir)); }
  catch (_) { existing = new Set(); }
  if (!existing.has(base)) return nodePath.join(dstDir, base);
  for (let n = 1; n <= 999; n++) {
    const candidate = `(${n}) ${base}`;
    if (!existing.has(candidate)) return nodePath.join(dstDir, candidate);
  }
  return nodePath.join(dstDir, `(${Date.now()}) ${base}`);
}

// ─── Single file copy with throttled progress ─────────────────────────────────

const THROTTLE_BYTES = 64 * 1024;
const THROTTLE_MS    = 200;

async function copyFile(src, dst, size, onBytes) {
  await fsp.mkdir(nodePath.dirname(dst), { recursive: true });
  return new Promise((resolve, reject) => {
    let done = 0, lastNotify = 0, lastTime = Date.now();
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

// ─── Recursive directory copy ─────────────────────────────────────────────────

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
      const dstExists = await provider.stat(dstChild);
      if (dstExists) {
        if (opts.conflictFolders === 'abort') {
          opts.abortReason = dirent.name; opts.abortSignal = true; return stats;
        }
        if (opts.conflictFolders === 'replace') {
          await provider.remove(dstChild);
        }
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
      const dstExists = await provider.stat(dstChild);
      if (dstExists) {
        if (opts.conflictFiles === 'abort') {
          opts.abortReason = dirent.name; opts.abortSignal = true; return stats;
        }
        if (opts.conflictFiles === 'replaceOlder') {
          const srcStat = await provider.stat(srcChild);
          if (srcStat && srcStat.mtime <= dstExists.mtime) {
            stats.skippedNewer++; continue;
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
        // replaceAll falls through
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

// ─── Cleanup helpers ──────────────────────────────────────────────────────────

async function removeAll(paths, progressLabel, ctx) {
  for (let i = 0; i < paths.length; i++) {
    const pct = Math.round(96 + (i / Math.max(1, paths.length)) * 2);
    ctx.progress(pct, progressLabel, {});
    try { await provider.remove(paths[i]); } catch (_) {}
  }
}

// ─── Main engine ──────────────────────────────────────────────────────────────

/**
 * Run a copy or move operation.
 *
 * For moves: copies everything first, then deletes sources only if the full
 * copy phase completed without abort. On abort, sources are never touched.
 *
 * @param {object}  ctx     — task context (progress, isCancelled, fail, done)
 * @param {object}  config  — task config
 * @param {boolean} isMove  — true = delete sources after successful copy
 */
async function runCopyMove(ctx, config, isMove) {
  const {
    sources,
    dst,
    conflictFiles   = 'abort',
    conflictFolders = 'abort',
    showHidden      = false,
    keepOnAbort     = false,
    showReport      = true,
  } = config;

  const verb = isMove ? 'Moving' : 'Copying';

  // ── Validate & persist prefs ──────────────────────────────────────────────
  ctx.progress(2, 'Validating…', {});
  const context = require('./context');
  helpers.boot();

  if (isMove) {
    context.updateConfig({
      moveConflictFiles: conflictFiles, moveConflictFolders: conflictFolders,
      moveKeepOnAbort: keepOnAbort, moveShowReport: showReport,
    });
  } else {
    context.updateConfig({
      copyConflictFiles: conflictFiles, copyConflictFolders: conflictFolders,
      copyKeepOnAbort: keepOnAbort, copyShowReport: showReport,
    });
  }

  if (!sources || sources.length === 0) return ctx.fail('No source items specified');
  if (!dst)                             return ctx.fail('No destination specified');

  const dstStat = await provider.stat(dst);
  if (!dstStat)               return ctx.fail(`Destination does not exist: ${dst}`);
  if (dstStat.type !== 'dir') return ctx.fail(`Destination is not a directory: ${dst}`);

  for (const src of sources) {
    const n = nodePath.resolve(src), d = nodePath.resolve(dst);
    if (d.startsWith(n + nodePath.sep) || d === n)
      return ctx.fail(`Cannot ${isMove ? 'move' : 'copy'} "${nodePath.basename(src)}" into itself`);
  }

  // ── Phase 1: scan sizes ───────────────────────────────────────────────────
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
  const copiedPaths   = [];  // destination paths created — cleaned up on abort
  const sourcesToDelete = []; // source paths to delete after successful copy (move only)

  function pushProgress(pct, itemIndex, itemName) {
    const elapsedSec = (Date.now() - startTime) / 1000 || 0.001;
    const speedKbps  = Math.round(doneKb / elapsedSec);
    const remaining  = totalKb - doneKb;
    const etaSec     = speedKbps > 0 ? Math.round(remaining / speedKbps) : null;
    ctx.progress(pct, `${verb} "${itemName}"…`, {
      itemIndex, itemCount: sources.length, itemName,
      kbDone: doneKb, kbTotal: totalKb, speedKbps, etaSec,
    });
  }

  // ── Phase 2: copy ─────────────────────────────────────────────────────────
  const totalStats = {
    copied:0, prefixed:0, replacedOlder:0, skippedNewer:0,
    mergedFolders:0, skippedSecurity:0, aborted:0, abortReason:'',
  };
  const errors  = [];
  let   aborted = false;

  for (let i = 0; i < sources.length; i++) {
    if (ctx.isCancelled()) { aborted = true; break; }

    const src     = sources[i];
    const srcName = nodePath.basename(src);
    const srcStat = await provider.stat(src);

    if (!srcStat || (srcStat.hidden && !showHidden)) continue;

    pushProgress(Math.round(5 + (i / sources.length) * 85), i, srcName);

    if (srcStat.type === 'dir') {
      // ── Directory ──────────────────────────────────────────────────────────
      const dstPath   = nodePath.join(dst, srcName);
      const dstExists = await provider.stat(dstPath);

      if (dstExists) {
        if (conflictFolders === 'abort') {
          totalStats.aborted = 1; totalStats.abortReason = srcName;
          aborted = true; break;
        }
        if (conflictFolders === 'replace') {
          try { await provider.remove(dstPath); }
          catch (e) { errors.push(`${srcName}: ${e.message}`); continue; }
        }
        if (conflictFolders === 'merge') totalStats.mergedFolders++;
      }

      let effectiveDst = dstPath;
      if (dstExists && conflictFolders === 'prefix') {
        effectiveDst = await resolvePrefixedName(src, dst);
        totalStats.prefixed++;
      }

      const opts = {
        conflictFiles, conflictFolders, showHidden,
        isCancelled: () => ctx.isCancelled(),
        abortSignal: false, abortReason: '',
      };

      try {
        const sub = await copyDir(src, effectiveDst, opts, () => {}, copiedPaths);
        if (opts.abortSignal) {
          totalStats.aborted = 1; totalStats.abortReason = opts.abortReason;
          aborted = true; break;
        }
        totalStats.copied         += sub.copied;
        totalStats.prefixed       += sub.prefixed;
        totalStats.replacedOlder  += sub.replacedOlder;
        totalStats.skippedNewer   += sub.skippedNewer;
        totalStats.skippedSecurity+= sub.skippedSecurity;
        copiedPaths.push(effectiveDst);
        if (isMove) sourcesToDelete.push(src);
        doneBytes += sizes[i];
        doneKb = Math.round(doneBytes / 1024);
      } catch (e) { errors.push(`${srcName}: ${e.message}`); }

    } else {
      // ── File ───────────────────────────────────────────────────────────────
      const dstPath   = nodePath.join(dst, srcName);
      const dstExists = await provider.stat(dstPath);

      if (dstExists) {
        if (conflictFiles === 'abort') {
          totalStats.aborted = 1; totalStats.abortReason = srcName;
          aborted = true; break;
        }
        if (conflictFiles === 'replaceOlder') {
          if (srcStat.mtime <= dstExists.mtime) {
            totalStats.skippedNewer++;
            doneBytes += sizes[i]; doneKb = Math.round(doneBytes / 1024);
            continue;
          }
          totalStats.replacedOlder++;
        }
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
          doneBytes = sizes.slice(0, i).reduce((a, b) => a + b, 0) + bd;
          doneKb = Math.round(doneBytes / 1024);
          const pct = Math.round(5 + ((i + bd / Math.max(1, bt)) / sources.length) * 85);
          pushProgress(pct, i, srcName);
        });
        copiedPaths.push(effectiveDst);
        if (isMove) sourcesToDelete.push(src);
        doneBytes = sizes.slice(0, i + 1).reduce((a, b) => a + b, 0);
        doneKb = Math.round(doneBytes / 1024);
      } catch (e) {
        errors.push(`${srcName}: ${e.message}`);
        if (!dstExists) totalStats.copied = Math.max(0, totalStats.copied - 1);
      }
    }
  }

  // ── Phase 3a: abort cleanup (destination) ─────────────────────────────────
  if (aborted && !keepOnAbort) {
    await removeAll(copiedPaths, 'Reverting…', ctx);
  }

  // ── Phase 3b: delete sources (move only, copy phase must have completed) ──
  if (isMove && !aborted && sourcesToDelete.length > 0) {
    await removeAll(sourcesToDelete, 'Removing originals…', ctx);
  }

  // ── Phase 4: refresh panels ───────────────────────────────────────────────
  ctx.progress(99, 'Refreshing…', {});
  const panels = await helpers.refreshBothPanels();

  ctx.progress(100, aborted ? 'Aborted' : 'Done', {});
  ctx.done({
    stats:   totalStats,
    aborted,
    errors,
    left:    panels.left,
    right:   panels.right,
  });
}

module.exports = { scanSize, resolvePrefixedName, copyFile, runCopyMove };
