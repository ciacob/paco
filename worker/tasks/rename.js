'use strict';

/**
 * worker/tasks/rename.js
 *
 * PACO command task: rename a single file or folder, in place (same parent
 * directory). Renaming is just "moving to a different name in the same
 * folder", so the same collision strategies as copy/move apply — but
 * narrowed to what makes sense for a single in-place operation:
 *
 *   Files:   abort | replaceOlder | replaceAll | prefix
 *   Folders: abort | replace | prefix
 *            (no "merge" — merging two folders via rename is move semantics,
 *             not rename semantics; a real merge belongs to the Move command)
 *
 * Config:
 *   {string} panel            — panel to refresh after rename
 *   {string} source           — absolute path of the item being renamed
 *   {string} newName           — the desired new name (not a full path)
 *   {string} [conflictFiles]   — 'abort'|'replaceOlder'|'replaceAll'|'prefix'
 *   {string} [conflictFolders] — 'abort'|'replace'|'prefix'
 *
 * Result:
 *   {string}  panel
 *   {string}  renamedTo   — absolute path of the item after renaming
 *   + navigate-compatible panel payload
 */

const nodePath = require('path');
const provider = require('../../paco/fs-provider');
const helpers  = require('../../paco/task-helpers');
const uiState  = require('../../paco/ui-state');

const INVALID_CHARS = /[<>:"|?*\x00-\x1f/\\]/; // no separators allowed — single segment only

function humaniseError(err, targetPath) {
  if (err.code === 'EACCES' || err.code === 'EPERM') {
    return `Permission denied \u2014 cannot rename inside "${nodePath.dirname(targetPath)}"`;
  }
  if (err.code === 'ENOSPC')       return 'Not enough disk space to complete the rename';
  if (err.code === 'ENAMETOOLONG') return 'New name is too long';
  if (err.code === 'ENOTEMPTY')    return 'Destination folder is not empty';
  return `Could not rename: ${err.message}`;
}

/**
 * Resolve a (n) prefixed sibling name that doesn't clash in dirPath.
 * Mirrors copy-engine's resolvePrefixedName but for an explicit desired name
 * rather than one derived from a source path.
 */
async function resolvePrefixedSibling(desiredName, dirPath) {
  const fsp = require('fs/promises');
  let existing;
  try { existing = new Set(await fsp.readdir(dirPath)); }
  catch (_) { existing = new Set(); }
  if (!existing.has(desiredName)) return desiredName;
  for (let n = 1; n <= 999; n++) {
    const candidate = `(${n}) ${desiredName}`;
    if (!existing.has(candidate)) return candidate;
  }
  return `(${Date.now()}) ${desiredName}`;
}

module.exports = {
  async start(ctx) {
    const {
      panel, source, newName,
      conflictFiles   = 'abort',
      conflictFolders = 'abort',
    } = ctx.config;

    // ── 1. Bootstrap & basic validation ──────────────────────────────────────
    ctx.progress(5, 'Validating\u2026');
    helpers.boot();

    const context = require('../../paco/context');
    context.updateConfig({ renameConflictFiles: conflictFiles, renameConflictFolders: conflictFolders });

    if (!source) return ctx.fail('No item specified for renaming');

    const trimmed = (newName || '').trim();
    if (!trimmed) return ctx.fail('New name is required');
    if (trimmed === '.' || trimmed === '..') return ctx.fail(`"${trimmed}" is not a valid name`);
    if (INVALID_CHARS.test(trimmed)) {
      return ctx.fail('Name must not contain path separators or invalid characters');
    }

    const srcStat = await provider.stat(source);
    if (!srcStat) return ctx.fail('The item to rename no longer exists');
    if (!srcStat.writable) return ctx.fail('This item is read-only and cannot be renamed');

    const oldName = nodePath.basename(source);
    if (trimmed === oldName) {
      // No-op — nothing to do. Caller should have prevented this, but guard anyway.
      return ctx.fail('The new name is the same as the current name');
    }

    const dirPath = nodePath.dirname(source);
    let targetPath = nodePath.join(dirPath, trimmed);

    // ── 2. Handle collision ────────────────────────────────────────────────────
    ctx.progress(20, 'Checking for conflicts\u2026');
    const targetExists = await provider.stat(targetPath);

    if (targetExists) {
      // Type mismatch is never a strategy decision — see paco/ui-state.js's
      // typeMismatchMessage doc comment for the full reasoning. This check
      // runs before conflictFiles/conflictFolders are even consulted, the
      // same way copy-engine.js handles the equivalent case for copy/move.
      // Type mismatch is never a strategy decision — see paco/ui-state.js's
      // typeMismatchMessage doc comment for the full reasoning. This check
      // runs before conflictFiles/conflictFolders are even consulted, the
      // same way copy-engine.js handles the equivalent case for copy/move.
      // The check is dir-vs-non-dir, matching the only distinction the rest
      // of this function actually makes (a symlink colliding with another
      // symlink, for instance, is a same-"kind" collision for our purposes
      // and should still go through the normal file-style strategy below).
      const srcIsDir = srcStat.type === 'dir';
      const dstIsDir = targetExists.type === 'dir';
      if (srcIsDir !== dstIsDir) {
        return ctx.fail(uiState.typeMismatchMessage(
          'rename', source, srcStat.type, dirPath, targetExists.type, trimmed
        ));
      }

      const isDirTarget = targetExists.type === 'dir';
      const strategy = isDirTarget ? conflictFolders : conflictFiles;

      if (strategy === 'abort') {
        const kind = isDirTarget ? 'Folder' : 'File';
        return ctx.fail(`${kind} "${trimmed}" already exists`);
      }

      if (!isDirTarget && strategy === 'replaceOlder') {
        if (srcStat.mtime <= targetExists.mtime) {
          return ctx.fail(`"${trimmed}" already exists and is not older than the item being renamed`);
        }
        // Older destination — remove it, then proceed with the rename below
        try { await provider.remove(targetPath); }
        catch (err) { return ctx.fail(humaniseError(err, targetPath)); }
      } else if (!isDirTarget && strategy === 'replaceAll') {
        try { await provider.remove(targetPath); }
        catch (err) { return ctx.fail(humaniseError(err, targetPath)); }
      } else if (isDirTarget && strategy === 'replace') {
        try { await provider.remove(targetPath); }
        catch (err) { return ctx.fail(humaniseError(err, targetPath)); }
      } else if (strategy === 'prefix') {
        const prefixed = await resolvePrefixedSibling(trimmed, dirPath);
        targetPath = nodePath.join(dirPath, prefixed);
      }
      // any other combination (e.g. conflictFiles on a dir target) falls through
      // and will simply hit the same "already exists" case again at rename time
    }

    // ── 3. Rename ──────────────────────────────────────────────────────────────
    ctx.progress(60, `Renaming to "${nodePath.basename(targetPath)}"\u2026`);
    try {
      await provider.rename(source, targetPath);
    } catch (err) {
      return ctx.fail(humaniseError(err, targetPath));
    }

    // ── 4. Refresh panel ──────────────────────────────────────────────────────
    ctx.progress(85, 'Refreshing panel\u2026');
    const panelResult = await helpers.refreshPanel(panel);

    ctx.progress(100, 'Renamed');
    ctx.done({
      ...panelResult,
      renamedTo: targetPath,
    });
  },
};
