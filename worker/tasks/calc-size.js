'use strict';

/**
 * worker/tasks/calc-size.js
 *
 * F3 Viewer panel: "Calculate" button for a folder's (or a multi-selection's)
 * total size. Spawns worker/calc-size-child.js as a separate, non-detached
 * child process to do the actual recursive walk, and returns immediately —
 * this task does NOT wait for that child to finish, so the single shared
 * worker queue is free again right away, just like calc-size's own caller
 * (the UI) doesn't block on this task's completion either.
 *
 * The spawned child is non-detached (Node's default — nothing extra needs
 * setting), so it's automatically killed if PACO's main process exits;
 * there's no orphan-process cleanup concern. It's registered in
 * paco/calc-registry.js under the returned calcId, which is what lets a
 * LATER, separate cancel-calc.js invocation find and kill it (this task's
 * own invocation has already finished and exited by then).
 *
 * The child's eventual result does NOT come back through this task (which
 * is long gone) — it's relayed by THIS task's own 'message'/'exit'
 * listeners directly through the worker process's existing IPC channel to
 * main.js, using the new EVT.CALC_RESULT event (see shared/messages.js),
 * completely independent of the normal task done/error/progress flow.
 * From there main.js relays it to server-process.js (SRV.CALC_RESULT),
 * which broadcasts it over WS — see those files for the rest of the chain.
 *
 * Config:
 *   {string}   panel — which panel this calculation is for (echoed back in
 *                       the result notification so the UI knows which
 *                       column to update)
 *   {string[]} paths — absolute paths to sum the size of
 *
 * Result (immediate, does not include the calculation itself):
 *   { calcId: string }
 */

const crypto = require('crypto');
const path   = require('path');
const { fork } = require('child_process');
const registry = require('../../paco/calc-registry');
const { EVT, msg } = require('../../shared/messages');

module.exports = {
  async start(ctx) {
    const { panel, paths } = ctx.config;

    if (!panel) return ctx.fail('No panel specified');
    if (!Array.isArray(paths) || paths.length === 0) {
      return ctx.fail('No items specified to calculate the size of');
    }

    const calcId = crypto.randomUUID();
    const childScript = path.join(__dirname, '..', 'calc-size-child.js');

    let child;
    try {
      child = fork(childScript, [JSON.stringify(paths)], {
        // detached defaults to false — the child dies with the worker
        // process automatically, no explicit option needed for that.
        silent: true, // don't inherit stdio; we only care about the IPC message
      });
    } catch (err) {
      return ctx.fail(`Could not start the size calculation: ${err.message}`);
    }

    registry.register(calcId, child);

    child.once('message', (result) => {
      registry.remove(calcId);
      _reportResult(calcId, panel, result);
      try { child.kill(); } catch (_) {}
    });

    child.once('exit', (code, signal) => {
      // If we got here WITHOUT a 'message' having already fired and removed
      // the registry entry, the child died without reporting a result
      // (crashed, was killed by cancel-calc.js, or similar). cancel-calc.js
      // already removes its own entry before killing, so this is a no-op
      // in that case; for an unexpected crash, clean up and notify.
      if (registry.get(calcId) === child) {
        registry.remove(calcId);
        if (signal == null && code !== 0) {
          _reportResult(calcId, panel, { ok: false, error: `Calculation process exited with code ${code}` });
        }
        // signal != null means it was killed (cancel-calc.js, or the whole
        // worker process exiting) — no result to report either way.
      }
    });

    ctx.done({ calcId });
  },
};

/**
 * Relay the child's result up through the worker process's existing IPC
 * channel to main.js, using EVT.CALC_RESULT — completely independent of
 * the normal task progress/done/error flow, since this task itself has
 * already finished and returned by the time this fires.
 *
 * @param {string} calcId
 * @param {string} panel
 * @param {{ok:true,bytes:number}|{ok:false,error:string}} result
 */
function _reportResult(calcId, panel, result) {
  if (!process.send) return; // not running as a forked child (e.g. a test) — nothing to relay to
  process.send(msg(EVT.CALC_RESULT, { calcId, panel, result }));
}
