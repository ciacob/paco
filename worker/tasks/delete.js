'use strict';

/**
 * worker/tasks/delete.js
 *
 * PACO command task: delete one or more files/directories.
 *
 * Config:
 *   {string[]} sources      — absolute paths of items to delete
 *   {string}   panel        — panel to refresh after deletion
 *   {boolean}  [toTrash]    — if true, move to system trash (default from config)
 *
 * Behaviour:
 *   - toTrash=true:  uses `trash` package — macOS Trash, Windows Recycle Bin,
 *                    Linux XDG trash. Safe and reversible.
 *   - toTrash=false: permanent deletion via fs.rm (irreversible).
 *   - Non-fatal per-item errors collected; remaining items still processed.
 *   - Persists toTrash preference to config.
 *
 * Result:
 *   {number}   deleted  — number of items successfully deleted/trashed
 *   {string[]} errors   — per-item error messages for any failures
 *   + navigate-compatible panel payload
 */

const nodePath = require('path');
const provider  = require('../../paco/fs-provider');
const helpers   = require('../../paco/task-helpers');

module.exports = {
  async start(ctx) {
    const { sources, panel } = ctx.config;

    // ── 1. Bootstrap & resolve toTrash preference ─────────────────────────────
    ctx.progress(2, 'Validating…');
    const { config } = helpers.boot();
    const context   = require('../../paco/context');

    // toTrash from config payload takes precedence; fall back to stored config
    const toTrash = ctx.config.toTrash !== undefined
      ? ctx.config.toTrash
      : config.deleteToTrash !== false;

    // Persist the preference
    context.updateConfig({ deleteToTrash: toTrash });

    if (!sources || sources.length === 0) {
      return ctx.fail('No items specified for deletion');
    }

    // ── 2. Load trash lazily (ESM package, dynamic import) ────────────────────
    let trashFn = null;
    if (toTrash) {
      try {
        const mod = await import('trash');
        trashFn = mod.default;
      } catch (err) {
        // Trash unavailable — fall back to permanent delete with a warning
        ctx.progress(5, 'Trash unavailable, falling back to permanent delete…');
        trashFn = null;
      }
    }

    // ── 3. Delete items ───────────────────────────────────────────────────────
    let deleted = 0;
    const errors = [];
    const step   = Math.floor(90 / sources.length);

    for (let i = 0; i < sources.length; i++) {
      if (ctx.isCancelled()) break;

      const itemPath = sources[i];
      const name     = nodePath.basename(itemPath);
      const pct      = 5 + i * step;
      const verb     = trashFn ? 'Trashing' : 'Deleting';

      ctx.progress(pct, `${verb} "${name}"…`);

      try {
        if (trashFn) {
          await trashFn([itemPath]);
        } else {
          await provider.remove(itemPath);
        }
        deleted++;
      } catch (err) {
        errors.push(`${name}: ${err.message}`);
      }
    }

    // ── 4. Refresh panel ──────────────────────────────────────────────────────
    ctx.progress(95, 'Refreshing panel…');
    const panelResult = await helpers.refreshPanel(panel);

    const verb = trashFn ? 'Trashed' : 'Deleted';
    ctx.progress(100, `${verb} ${deleted} item${deleted !== 1 ? 's' : ''}`);
    ctx.done({
      ...panelResult,
      deleted,
      errors,
      toTrash: !!trashFn,
    });
  },
};
