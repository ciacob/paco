'use strict';

/**
 * worker/tasks/cancel-calc.js
 *
 * F3 Viewer panel: cancel an in-flight size calculation started by
 * calc-size.js. Looks the calcId up in paco/calc-registry.js, kills the
 * still-running child process, and removes the registry entry — same
 * mechanism that catches an unexpected crash in calc-size.js's own 'exit'
 * listener, just triggered deliberately here instead.
 *
 * No result is reported back for a cancelled calculation — the UI already
 * knows it cancelled (that's WHY this task was assigned) and reverts its
 * own state immediately on the same user action that triggered this,
 * rather than waiting for any round-trip. See the F3 size-calculation
 * design discussion: a stray result arriving after cancellation is simply
 * discarded by the UI's calcId check, same as any other stale-result case.
 *
 * Config:
 *   {string} calcId
 *
 * Result:
 *   { cancelled: boolean } — false if calcId wasn't found (already
 *   finished naturally, already cancelled, or never existed — all
 *   equally harmless, not treated as an error).
 */

const registry = require('../../paco/calc-registry');

module.exports = {
  async start(ctx) {
    const { calcId } = ctx.config;

    if (!calcId) return ctx.fail('No calculation ID specified');

    const child = registry.get(calcId);
    if (!child) {
      // Already finished, already cancelled, or never existed — not an
      // error, just nothing to do.
      return ctx.done({ cancelled: false });
    }

    registry.remove(calcId);
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
