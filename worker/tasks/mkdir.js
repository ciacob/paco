'use strict';

/**
 * worker/tasks/mkdir.js
 *
 * PACO command task: create a new directory.
 *
 * Config:
 *   {string} panel   — 'left' | 'right' (panel whose cwd receives the new dir)
 *   {string} name    — new folder name (not a full path — relative to panel cwd)
 *
 * Behaviour:
 *   - Resolves full path as <panel.path>/<name>
 *   - Fails if name contains a path separator (must be a single folder name)
 *   - Fails if the target already exists
 *   - Creates the directory
 *   - Refreshes the source panel so the UI reflects the new entry
 *
 * Result:
 *   {string}  panel        — echoed back
 *   {string}  created      — absolute path of the created directory
 *   + full navigate-compatible panel payload from refreshPanel()
 */

const nodePath = require('path');
const context  = require('../../paco/context');
const provider = require('../../paco/fs-provider');
const helpers  = require('../../paco/task-helpers');

module.exports = {
  async start(ctx) {
    const { panel, name } = ctx.config;

    // ── 1. Bootstrap & validate ───────────────────────────────────────────────
    ctx.progress(5, 'Validating…');
    const { state } = helpers.boot();

    if (!name || !name.trim()) {
      return ctx.fail('Folder name is required');
    }

    const trimmed = name.trim();

    // Reject any embedded separators — name must be a single segment
    if (trimmed.includes('/') || trimmed.includes('\\')) {
      return ctx.fail('Folder name must not contain path separators');
    }

    // Reject reserved names and characters that are invalid on any platform
    if (/[<>:"|?*\x00-\x1f]/.test(trimmed)) {
      return ctx.fail('Folder name contains invalid characters');
    }

    if (trimmed === '.' || trimmed === '..') {
      return ctx.fail('Invalid folder name');
    }

    // ── 2. Resolve full path ──────────────────────────────────────────────────
    ctx.progress(15, 'Resolving path…');
    const panelPath = state.panels[panel].path;

    if (!panelPath) {
      return ctx.fail('Panel has no current path — navigate to a directory first');
    }

    const newDirPath = nodePath.join(panelPath, trimmed);

    // ── 3. Check for collision ────────────────────────────────────────────────
    ctx.progress(25, 'Checking for conflicts…');
    const existing = await provider.stat(newDirPath);
    if (existing) {
      return ctx.fail(`"${trimmed}" already exists`);
    }

    // ── 4. Create ─────────────────────────────────────────────────────────────
    ctx.progress(40, `Creating "${trimmed}"…`);
    try {
      await provider.mkdir(newDirPath);
    } catch (err) {
      return ctx.fail(`Could not create folder: ${err.message}`);
    }

    // ── 5. Refresh panel ──────────────────────────────────────────────────────
    ctx.progress(80, 'Refreshing panel…');
    const panelResult = await helpers.refreshPanel(panel);

    ctx.progress(100, `Created "${trimmed}"`);
    ctx.done({
      ...panelResult,
      created: newDirPath,
    });
  },
};
