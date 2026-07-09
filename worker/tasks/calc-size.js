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
 *   {number}   [timeoutMs] — how long to wait before giving up and
 *                            reporting a failure (see DEFAULT_TIMEOUT_MS
 *                            below — deliberately a much longer default
 *                            than extract-preview.js's own timeout, since a
 *                            large/network-mounted folder can legitimately
 *                            take minutes, not just seconds, to sum).
 *
 * Result (immediate, does not include the calculation itself):
 *   { calcId: string }
 */

const crypto = require('crypto');
const path   = require('path');
const { fork } = require('child_process');
const registry = require('../../paco/calc-registry');
const { EVT, msg } = require('../../shared/messages');

// Falls back to this if the client doesn't send config.timeoutMs — matches
// paco/context.js's DEFAULT_CONFIG.calcTimeoutMs. Deliberately generous
// (minutes, not seconds): unlike extract-preview.js's bounded preview
// renders, a legitimate recursive size sum over a huge or network-mounted
// tree can genuinely take a while — this timeout exists to catch a truly
// wedged child (see extract-preview.js's own comment on how that can
// happen), not to second-guess a large folder.
const DEFAULT_TIMEOUT_MS = 300000;

// Bound how much stderr we accumulate for a timeout/crash error message.
const MAX_CAPTURED_STDERR = 4000;

module.exports = {
  async start(ctx) {
    const { panel, paths, timeoutMs } = ctx.config;

    if (!panel) return ctx.fail('No panel specified');
    if (!Array.isArray(paths) || paths.length === 0) {
      return ctx.fail('No items specified to calculate the size of');
    }

    const calcId = crypto.randomUUID();
    const childScript = path.join(__dirname, '..', 'calc-size-child.js');
    const effectiveTimeoutMs = typeof timeoutMs === 'number' && timeoutMs > 0
      ? timeoutMs
      : DEFAULT_TIMEOUT_MS;

    let child;
    try {
      child = fork(childScript, [JSON.stringify(paths)], {
        // detached defaults to false — the child dies with the worker
        // process automatically, no explicit option needed for that.
        silent: true, // don't inherit stdio; piped instead — see the
                       // stdout/stderr drain below.
      });
    } catch (err) {
      return ctx.fail(`Could not start the size calculation: ${err.message}`);
    }

    registry.register(calcId, child);

    // Actively drain stdout/stderr rather than leaving them as unread
    // pipes — see extract-preview.js's own comment on why an unconsumed
    // pipe can wedge a child forever once it fills up. Less likely to
    // matter here (calc-size-child.js is plain recursive fs.readdir/lstat,
    // not a native decoder prone to emitting warnings), but the same
    // structural gap existed here too, so it gets the same fix.
    let capturedStderr = '';
    if (child.stdout) child.stdout.on('data', () => {});
    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        capturedStderr = (capturedStderr + chunk.toString()).slice(-MAX_CAPTURED_STDERR);
      });
    }

    const timeoutTimer = setTimeout(() => {
      if (registry.get(calcId) !== child) return; // already resolved/cancelled
      registry.remove(calcId);
      const suffix = capturedStderr.trim() ? ` — last output: ${capturedStderr.trim()}` : '';
      _reportResult(calcId, panel, {
        ok: false,
        error: `Calculation timed out after ${effectiveTimeoutMs}ms${suffix}`,
      });
      try { child.kill(); } catch (_) {}
    }, effectiveTimeoutMs);

    child.once('message', (result) => {
      clearTimeout(timeoutTimer);
      registry.remove(calcId);
      _reportResult(calcId, panel, result);
      try { child.kill(); } catch (_) {}
    });

    child.once('exit', (code, signal) => {
      clearTimeout(timeoutTimer);
      // Same reasoning as extract-preview.js's own 'exit' listener (see
      // its comment, and calc-size-child.js's header, for the
      // process.send()/process.exit() race this also guards against): a
      // clean exit code is not proof a message went out. cancel-calc.js
      // already removes its own registry entry before killing, so
      // signal != null (killed deliberately, or the worker process
      // exiting) is the one case with nothing to report.
      if (registry.get(calcId) === child) {
        registry.remove(calcId);
        if (signal == null) {
          const suffix = capturedStderr.trim() ? ` — last output: ${capturedStderr.trim()}` : '';
          const reason = code === 0
            ? `Calculation process exited without reporting a result${suffix}`
            : `Calculation process exited with code ${code}${suffix}`;
          _reportResult(calcId, panel, { ok: false, error: reason });
        }
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
