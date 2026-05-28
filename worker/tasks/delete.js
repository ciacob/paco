'use strict';

/**
 * worker/tasks/delete.js
 *
 * PACO command task: permanently delete one or more files/directories.
 *
 * Config:
 *   {string[]} sources  — absolute paths of items to delete
 *   {string}   panel    — panel to refresh after deletion
 *
 * Behaviour:
 *   - Deletes items one by one (non-atomic: partial success is possible)
 *   - Respects ctx.isCancelled() between items
 *   - Non-fatal per-item errors are collected; remaining items still processed
 *   - Refreshes the source panel on completion
 *
 * Result:
 *   {number}   deleted  — number of items successfully deleted
 *   {string[]} errors   — per-item error messages for any failures
 *   + navigate-compatible panel payload from refreshPanel()
 */

const nodePath = require('path');
const provider = require('../../paco/fs-provider');
const helpers  = require('../../paco/task-helpers');

module.exports = {
  async start(ctx) {
    const { sources, panel } = ctx.config;

    // ── 1. Bootstrap & validate ───────────────────────────────────────────────
    ctx.progress(2, 'Validating…');
    helpers.boot();

    if (!sources || sources.length === 0) {
      return ctx.fail('No items specified for deletion');
    }

    // ── 2. Delete items ───────────────────────────────────────────────────────
    let deleted = 0;
    const errors = [];
    const step   = Math.floor(90 / sources.length);

    for (let i = 0; i < sources.length; i++) {
      if (ctx.isCancelled()) break;

      const itemPath = sources[i];
      const name     = nodePath.basename(itemPath);
      const pct      = 5 + i * step;

      ctx.progress(pct, `Deleting "${name}"…`);

      try {
        await provider.remove(itemPath);
        deleted++;
      } catch (err) {
        errors.push(`${name}: ${err.message}`);
      }
    }

    // ── 3. Refresh panel ──────────────────────────────────────────────────────
    ctx.progress(95, 'Refreshing panel…');
    const panelResult = await helpers.refreshPanel(panel);

    ctx.progress(100, `Deleted ${deleted} item${deleted !== 1 ? 's' : ''}`);
    ctx.done({
      ...panelResult,
      deleted,
      errors,
    });
  },
};
