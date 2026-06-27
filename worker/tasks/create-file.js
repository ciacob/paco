'use strict';

/**
 * worker/tasks/create-file.js
 *
 * PACO command task: Shift+F4 — create a new, empty (0-byte) stub file in
 * the directory currently listed by the active panel. The classic Total
 * Commander "new file" shortcut.
 *
 * Unlike mkdir.js, there is no "sub-directories mode" equivalent here:
 * the name field is name-only, always — path separators are never
 * accepted, full stop. This task creates exactly one file, directly
 * inside the panel's current directory, nothing else.
 *
 * Config:
 *   {string} panel  — 'left' | 'right'
 *   {string} name   — desired file name (single segment, no separators)
 *
 * Result:
 *   {string}  panel
 *   {string}  created   — absolute path of the new file
 *   + navigate-compatible panel payload
 */

const nodePath = require('path');
const provider = require('../../paco/fs-provider');
const helpers  = require('../../paco/task-helpers');

// No path separators allowed, ever — unlike mkdir's optional sub-dirs mode,
// this field is name-only by design (see the file header above).
const INVALID_CHARS = /[<>:"|?*\x00-\x1f/\\]/;

/**
 * Validate a candidate file name. Returns an error message string if
 * invalid, or null if the name is acceptable to attempt creating.
 *
 * Pure / synchronous — does not check the filesystem (existence is checked
 * separately, since that requires I/O). This only validates the NAME
 * itself: non-empty, not "." or "..", no path separators, no characters
 * that are invalid on any of the platforms PACO supports.
 *
 * @param {string} rawName
 * @returns {string|null}
 */
function validateFileName(rawName) {
  const trimmed = (rawName || '').trim();
  if (!trimmed) return 'File name is required';
  if (trimmed === '.' || trimmed === '..') return `"${trimmed}" is not a valid file name`;
  if (trimmed.includes('/') || trimmed.includes('\\')) {
    return 'File name must not contain path separators.';
  }
  if (INVALID_CHARS.test(trimmed)) {
    return `"${trimmed}" contains invalid characters`;
  }
  return null;
}

/**
 * Translate a raw Node.js fs error (from provider.createFile()) into a
 * clear, user-facing message. Mirrors mkdir.js's humaniseError, adapted
 * for file creation.
 *
 * @param {NodeJS.ErrnoException} err
 * @param {string} targetPath — the file path that was being created
 * @returns {string}
 */
function humaniseError(err, targetPath) {
  if (err.code === 'EACCES' || err.code === 'EPERM') {
    return `Permission denied \u2014 cannot create a file inside "${nodePath.dirname(targetPath)}"`;
  }
  if (err.code === 'EEXIST') {
    // The 'wx' flag in provider.createFile() caught a race: something was
    // created at this exact path between our own existence check and the
    // actual write (another process, or another PACO panel/instance).
    return `Found existing item: ${nodePath.basename(targetPath)}`;
  }
  if (err.code === 'ENOSPC') {
    return 'Not enough disk space to create the file';
  }
  if (err.code === 'ENAMETOOLONG') {
    return 'File name is too long';
  }
  if (err.code === 'ENOTDIR') {
    return 'Part of the path already exists as a file, not a folder';
  }
  return `Could not create file: ${err.message}`;
}

module.exports = {
  validateFileName, // exported for direct unit testing

  async start(ctx) {
    const { panel, name } = ctx.config;

    // ── 1. Bootstrap & basic validation ──────────────────────────────────────
    ctx.progress(5, 'Validating\u2026');
    const { state } = helpers.boot();

    const nameError = validateFileName(name);
    if (nameError) return ctx.fail(nameError);

    const trimmed = name.trim();

    const panelPath = state.panels[panel] ? state.panels[panel].path : '';
    if (!panelPath) {
      return ctx.fail('Panel has no current path \u2014 navigate to a directory first');
    }

    const newFilePath = nodePath.join(panelPath, trimmed);

    // ── 2. Check non-existence (file OR folder, either blocks creation) ───────
    ctx.progress(25, 'Checking for conflicts\u2026');
    const existing = await provider.stat(newFilePath);
    if (existing) {
      const kind = existing.type === 'dir' ? 'folder' : 'file';
      return ctx.fail(`Found existing ${kind}: ${trimmed}`);
    }

    // ── 3. Create the empty file ───────────────────────────────────────────────
    ctx.progress(50, `Creating \u201c${trimmed}\u201d\u2026`);
    try {
      await provider.createFile(newFilePath);
    } catch (err) {
      return ctx.fail(humaniseError(err, newFilePath));
    }

    // ── 4. Refresh panel ──────────────────────────────────────────────────────
    ctx.progress(85, 'Refreshing panel\u2026');
    const panelResult = await helpers.refreshPanel(panel);

    ctx.progress(100, `Created \u201c${trimmed}\u201d`);
    ctx.done({
      ...panelResult,
      created: newFilePath,
    });
  },
};
