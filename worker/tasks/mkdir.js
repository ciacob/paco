'use strict';

/**
 * worker/tasks/mkdir.js
 *
 * PACO command task: create a new directory (or branch of directories).
 *
 * Config:
 *   {string}  panel      — 'left' | 'right'
 *   {string}  name       — folder name or path (e.g. "foo" or "foo/bar/baz")
 *   {boolean} [subDirs]  — if true, treat name as a path and create each
 *                          segment in turn; stop on first existing segment.
 *                          if false (default), separators are rejected.
 *
 * Sub-directories mode behaviour:
 *   - Split name on / and \ into segments
 *   - Validate each segment individually (no invalid chars, not . or ..)
 *   - Walk top-down: stop and fail on the first segment that already exists
 *   - Create all remaining segments
 *
 * Result:
 *   {string}    panel
 *   {string}    created   — absolute path of the deepest created directory
 *   {string[]}  segments  — all segments that were created
 *   + navigate-compatible panel payload
 */

const nodePath = require('path');
const provider = require('../../paco/fs-provider');
const helpers  = require('../../paco/task-helpers');

// Characters invalid in directory names on any of the supported platforms
const INVALID_CHARS = /[<>:"|?*\x00-\x1f]/;

function validateSegment(seg) {
  if (!seg || !seg.trim()) return 'Segment cannot be empty';
  const t = seg.trim();
  if (t === '.' || t === '..') return `"${t}" is not a valid folder name`;
  if (INVALID_CHARS.test(t))   return `"${t}" contains invalid characters`;
  return null; // ok
}

function humaniseError(err, dirPath) {
  if (err.code === 'EACCES' || err.code === 'EPERM') {
    return `Permission denied — cannot create folder in "${nodePath.dirname(dirPath)}"`;
  }
  if (err.code === 'ENOSPC') {
    return 'Not enough disk space to create the folder';
  }
  if (err.code === 'ENAMETOOLONG') {
    return `Folder name is too long`;
  }
  return `Could not create folder: ${err.message}`;
}

module.exports = {
  async start(ctx) {
    const { panel, name, subDirs = false } = ctx.config;

    // ── 1. Bootstrap ─────────────────────────────────────────────────────────
    ctx.progress(5, 'Validating…');
    const { state } = helpers.boot();

    if (!name || !name.trim()) {
      return ctx.fail('Folder name is required');
    }

    const panelPath = state.panels[panel].path;
    if (!panelPath) {
      return ctx.fail('Panel has no current path — navigate to a directory first');
    }

    // ── 2. Parse segments ─────────────────────────────────────────────────────
    ctx.progress(15, 'Validating name…');

    let segments;
    if (subDirs) {
      // Split on either separator, filter empty (leading/trailing/doubled seps)
      segments = name.trim().split(/[/\\]/).filter(s => s.length > 0);
      if (segments.length === 0) {
        return ctx.fail('Folder name is required');
      }
      for (const seg of segments) {
        const err = validateSegment(seg);
        if (err) return ctx.fail(err);
      }
    } else {
      // Single-folder mode — separators not allowed
      const trimmed = name.trim();
      if (trimmed.includes('/') || trimmed.includes('\\')) {
        return ctx.fail(
          'Folder name must not contain path separators.\n' +
          'Tip: enable "Create sub-directories" to create nested folders.'
        );
      }
      const err = validateSegment(trimmed);
      if (err) return ctx.fail(err);
      segments = [trimmed];
    }

    // ── 3. Walk top-down, stop on first clash ─────────────────────────────────
    ctx.progress(25, 'Checking for conflicts…');

    let currentPath = panelPath;
    let firstClash  = null;

    for (const seg of segments) {
      const candidate = nodePath.join(currentPath, seg);
      const existing  = await provider.stat(candidate);
      if (existing) {
        firstClash = candidate;
        return ctx.fail(
          `"${seg}" already exists` +
          (segments.length > 1 ? ` (in ${nodePath.relative(panelPath, currentPath) || '.'})` : '')
        );
      }
      currentPath = candidate;
    }

    // ── 4. Create directories top-down ────────────────────────────────────────
    const created   = [];
    currentPath     = panelPath;
    const total     = segments.length;

    for (let i = 0; i < segments.length; i++) {
      const seg       = segments[i];
      const newPath   = nodePath.join(currentPath, seg);
      const pct       = Math.round(40 + (i / total) * 40);
      ctx.progress(pct, `Creating "${seg}"…`);

      try {
        await provider.mkdir(newPath);
        created.push(newPath);
      } catch (err) {
        // If some dirs were created before failure, leave them (partial creation
        // is acceptable — they're all empty at this point)
        return ctx.fail(humaniseError(err, newPath));
      }

      currentPath = newPath;
    }

    // ── 5. Refresh panel ──────────────────────────────────────────────────────
    ctx.progress(85, 'Refreshing panel…');
    const panelResult = await helpers.refreshPanel(panel);

    const deepest = created[created.length - 1];
    ctx.progress(100, `Created "${segments.join('/')}"`)
    ctx.done({
      ...panelResult,
      created:  deepest,
      segments: created,
    });
  },
};
