'use strict';

/**
 * worker/tasks/cancel-extract.js
 *
 * F3 Viewer panel: cancel an in-flight iframe extraction started by
 * extract-preview.js. Looks the jobId up in paco/extract-registry.js,
 * kills the still-running child process, and removes the registry entry
 * — same mechanism that catches an unexpected crash in extract-preview.js's
 * own 'exit' listener, just triggered deliberately here instead. Direct
 * counterpart to worker/tasks/cancel-calc.js — see that file's own header
 * for the fuller reasoning, which applies identically here.
 *
 * Triggered on both a selection change AND a tab switch (switching which
 * renderer is being viewed for the same file mid-extraction should cancel
 * the stale one) — the client decides when to call this; this task itself
 * doesn't distinguish why it was asked to cancel.
 *
 * No result is reported back for a cancelled extraction — same reasoning
 * as cancel-calc.js: the UI already knows it cancelled (that's why this
 * task was assigned) and reverts its own state immediately, rather than
 * waiting for any round-trip. A stray result that the child manages to
 * report in the brief window before the kill signal takes effect is
 * simply discarded by the UI's jobId check, same as any other stale-result
 * case.
 *
 * Config:
 *   {string} jobId
 *
 * Result:
 *   { cancelled: boolean } — false if jobId wasn't found (already
 *   finished naturally, already cancelled, or never existed — all
 *   equally harmless, not treated as an error).
 */

const registry = require('../../paco/extract-registry');

module.exports = {
  async start(ctx) {
    const { jobId } = ctx.config;

    if (!jobId) return ctx.fail('No extraction job ID specified');

    const child = registry.get(jobId);
    if (!child) {
      // Already finished, already cancelled, or never existed — not an
      // error, just nothing to do.
      return ctx.done({ cancelled: false });
    }

    registry.remove(jobId);
    try {
      child.kill();
    } catch (_) {
      // Process may have already exited on its own between the lookup and
      // the kill attempt — harmless, the outcome (it's not running) is the
      // same either way.
    }

    ctx.done({ cancelled: true });
  },
};
