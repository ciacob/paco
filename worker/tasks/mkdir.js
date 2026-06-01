'use strict';

/**
 * worker/tasks/mkdir.js
 *
 * PACO command task: create a new directory (or branch of directories).
 *
 * Config:
 *   {string}  panel      — 'left' | 'right'
 *   {string}  name       — folder name or relative path (e.g. "foo" or "a/b/c")
 *   {boolean} [subDirs]  — if true, path separators are allowed and the full
 *                          branch is created in one shot (existing intermediate
 *                          directories are silently skipped). If false (default),
 *                          separators are rejected.
 *
 * Result:
 *   {string}  panel
 *   {string}  created   — absolute path of the deepest directory
 *   + navigate-compatible panel payload
 */

const nodePath = require('path');
const provider = require('../../paco/fs-provider');
const helpers  = require('../../paco/task-helpers');

const INVALID_CHARS = /[<>:"|?*\x00-\x1f]/;

function humaniseError(err, targetPath) {
  if (err.code === 'EACCES' || err.code === 'EPERM') {
    return `Permission denied — cannot create a folder inside "${nodePath.dirname(targetPath)}"`;
  }
  if (err.code === 'EEXIST') {
    // A file (not a directory) exists at one of the path segments
    return `A file with that name already exists and cannot be replaced by a folder`;
  }
  if (err.code === 'ENOSPC') {
    return 'Not enough disk space to create the folder';
  }
  if (err.code === 'ENAMETOOLONG') {
    return 'Folder name is too long';
  }
  if (err.code === 'ENOTDIR') {
    return `Part of the path already exists as a file, not a folder`;
  }
  return `Could not create folder: ${err.message}`;
}

module.exports = {
  async start(ctx) {
    const { panel, name, subDirs = false } = ctx.config;

    // ── 1. Bootstrap & basic validation ──────────────────────────────────────
    ctx.progress(5, 'Validating…');
    const { state } = helpers.boot();

    const trimmed = (name || '').trim();
    if (!trimmed) {
      return ctx.fail('Folder name is required');
    }

    const panelPath = state.panels[panel].path;
    if (!panelPath) {
      return ctx.fail('Panel has no current path — navigate to a directory first');
    }

    // Persist the subDirs preference for next time
    const context = require('../../paco/context');
    context.updateConfig({ mkdirSubDirs: !!subDirs });

    if (subDirs) {
      // Validate each segment individually for bad characters
      const segments = trimmed.split(/[/\\]/).filter(s => s.length > 0);
      if (segments.length === 0) {
        return ctx.fail('Folder name is required');
      }
      for (const seg of segments) {
        if (seg === '.' || seg === '..') {
          return ctx.fail(`"${seg}" is not a valid folder name`);
        }
        if (INVALID_CHARS.test(seg)) {
          return ctx.fail(`"${seg}" contains invalid characters`);
        }
      }
    } else {
      // Single-folder mode — separators not allowed
      if (trimmed.includes('/') || trimmed.includes('\\')) {
        return ctx.fail(
          'Folder name must not contain path separators.\n\n' +
          'Tip: enable \u201cSub-directories mode\u201d to create nested folders.'
        );
      }
      if (trimmed === '.' || trimmed === '..') {
        return ctx.fail(`"${trimmed}" is not a valid folder name`);
      }
      if (INVALID_CHARS.test(trimmed)) {
        return ctx.fail(`"${trimmed}" contains invalid characters`);
      }
    }

    // ── 2. Create (let the OS handle existing intermediates) ──────────────────
    ctx.progress(30, `Creating "${trimmed}"…`);

    // Join the full relative path — works for both single and multi-segment
    const newDirPath = nodePath.join(panelPath, ...trimmed.split(/[/\\]/).filter(Boolean));

    // Check the leaf (deepest) path — existing intermediates are fine in
    // subDirs mode, but we never silently accept the final destination.
    const leafExists = await provider.stat(newDirPath);
    if (leafExists) {
      const kind = leafExists.type === 'dir' ? 'Folder' : 'File';
      return ctx.fail(`${kind} “${trimmed}” already exists`);
    }

    try {
      // recursive: true silently skips existing intermediate dirs in subDirs mode
      await provider.mkdir(newDirPath);
    } catch (err) {
      return ctx.fail(humaniseError(err, newDirPath));
    }

    // ── 3. Refresh panel ──────────────────────────────────────────────────────
    ctx.progress(80, 'Refreshing panel…');
    const panelResult = await helpers.refreshPanel(panel);

    ctx.progress(100, `Created "${trimmed}"`);
    ctx.done({
      ...panelResult,
      created: newDirPath,
    });
  },
};
