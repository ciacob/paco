'use strict';

/**
 * worker/tasks/extract-preview.js
 *
 * F3 Viewer panel: iframe extraction for the "View as:" tab row. Given a
 * single selected file's path and the uid of the renderer the user is
 * currently viewing (either the preselected match, or one the user
 * switched to), spawns worker/extract-preview-child.js as a separate,
 * non-detached child process to run the matched extractor, and returns
 * immediately — this task does NOT wait for that child to finish, same
 * "free the shared worker queue right away" reasoning as
 * worker/tasks/calc-size.js, which this whole file deliberately mirrors.
 *
 * Which extractor to run and how to call it is resolved here, not in the
 * child: paco/renderers/registry.js#folderForUid finds which
 * paco/renderers/<folder>/ the uid belongs to, and that folder's glue.js
 * (pure, no I/O) turns the file's extension into a concrete
 * { modulePath, exportName, fixedArgs } invocation plan, which is handed
 * to the child as-is — the child only ever reads the file's bytes and
 * calls what it's told to call, no per-extractor branching lives there.
 *
 * The spawned child is non-detached (Node's default), so it's
 * automatically killed if PACO's main process exits. It's registered in
 * paco/extract-registry.js under the returned jobId, which is what lets a
 * LATER, separate cancel-extract.js invocation find and kill it (this
 * task's own invocation has already finished and exited by then — e.g.
 * the user switched tabs or changed selection mid-extraction).
 *
 * The child's eventual result does NOT come back through this task
 * (which is long gone) — it's relayed by THIS task's own 'message'/'exit'
 * listeners directly through the worker process's existing IPC channel to
 * main.js, using EVT.EXTRACT_RESULT (see shared/messages.js), completely
 * independent of the normal task done/error/progress flow. From there
 * main.js relays it to server-process.js (SRV.EXTRACT_RESULT), which
 * broadcasts it over WS — see those files for the rest of the chain.
 *
 * Config:
 *   {string} panel     — which panel this extraction is for (echoed back in
 *                         the result notification so the UI knows which
 *                         column to update)
 *   {string} path      — absolute path of the single selected item
 *   {string} uid       — the matched renderer's uid (paco/renderers/<name>/renderer.json)
 *   {number} [timeoutMs] — how long to wait for the child before giving up
 *                          and reporting a failure (see DEFAULT_TIMEOUT_MS
 *                          below for why this has its own config value,
 *                          separate from calc-size.js's).
 *
 * Result (immediate, does not include the extraction itself):
 *   { jobId: string }
 */

const path   = require('path');
const crypto = require('crypto');
const { fork } = require('child_process');
const registry         = require('../../paco/extract-registry');
const rendererRegistry = require('../../paco/renderers/registry');
const { EVT, msg } = require('../../shared/messages');

// Falls back to this if the client doesn't send config.timeoutMs (an older
// cached client, or a direct API call in a test) — matches
// paco/context.js's DEFAULT_CONFIG.extractionTimeoutMs, kept in sync
// manually since this file has no reason to require() context.js just for
// one constant (worker tasks generally receive config values from the
// client, which already read them from context.js — see task-helpers.js's
// own header comment on that division of responsibility).
const DEFAULT_TIMEOUT_MS = 30000;

// Bound how much stderr we accumulate for a timeout/crash error message —
// plenty to show the last meaningful line(s) a native decoder printed
// before wedging, without letting a runaway child's output grow this
// task's own memory usage unboundedly.
const MAX_CAPTURED_STDERR = 4000;

// DEBUGGING: set PACO_EXTRACT_DEBUG=1 to print timestamped checkpoints
// here AND to have this file live-print (not just capture) whatever the
// child writes to stderr — worker-process.js itself is forked with
// silent:false (see main.js), so these checkpoints show up directly in
// the main process's own console when running the real app. Off by
// default; temporary diagnostic instrumentation, not permanent logging.
const DEBUG = process.env.PACO_EXTRACT_DEBUG === '1';
function checkpoint(label) {
  if (!DEBUG) return;
  console.log(`[extract-preview ${new Date().toISOString()}] ${label}`);
}

module.exports = {
  async start(ctx) {
    const { panel, path: targetPath, uid, timeoutMs } = ctx.config;
    checkpoint(`start() called — panel=${panel} uid=${uid} path=${targetPath}`);

    if (!panel) return ctx.fail('No panel specified');
    if (!targetPath) return ctx.fail('No item specified');
    if (!uid) return ctx.fail('No renderer specified');

    const folder = rendererRegistry.folderForUid(uid);
    if (!folder) return ctx.fail(`Unknown renderer uid: "${uid}"`);
    checkpoint(`resolved renderer folder: ${folder}`);

    let glue;
    try {
      glue = require(path.join(__dirname, '..', '..', 'paco', 'renderers', folder, 'glue.js'));
    } catch (err) {
      return ctx.fail(`Could not load renderer "${folder}": ${err.message}`);
    }

    const ext = path.extname(targetPath).replace(/^\./, '').toLowerCase();
    const plan = glue.buildInvocation(ext);
    checkpoint(`build invocation plan — modulePath=${plan.modulePath} exportName=${plan.exportName}`);

    const jobId = crypto.randomUUID();
    const childScript = path.join(__dirname, '..', 'extract-preview-child.js');
    const effectiveTimeoutMs = typeof timeoutMs === 'number' && timeoutMs > 0
      ? timeoutMs
      : DEFAULT_TIMEOUT_MS;
    checkpoint(`jobId=${jobId} effectiveTimeoutMs=${effectiveTimeoutMs}`);

    const instructions = {
      filePath:   targetPath,
      modulePath: plan.modulePath,
      exportName: plan.exportName,
      fixedArgs:  plan.fixedArgs,
    };

    let child;
    try {
      child = fork(childScript, [JSON.stringify(instructions)], {
        // detached defaults to false — the child dies with the worker
        // process automatically, no explicit option needed for that.
        silent: true, // don't inherit stdio; piped instead — see the
                       // stdout/stderr drain below for why those pipes are
                       // still actively read rather than left unconsumed.
        // env is NOT overridden here — fork() inherits process.env by
        // default, which is exactly what propagates PACO_EXTRACT_DEBUG
        // (if set) down to the child automatically.
      });
    } catch (err) {
      return ctx.fail(`Could not start the extraction: ${err.message}`);
    }
    checkpoint(`forked child, pid=${child.pid}`);

    registry.register(jobId, child);

    // Actively drain stdout/stderr rather than leaving them as unread
    // pipes. With { silent: true }, Node pipes the child's stdio instead
    // of inheriting or closing it — if nothing ever reads those pipes and
    // the child (or a native library it calls into, e.g. sharp/libvips/
    // ffmpeg) writes enough to fill the OS pipe buffer, the child's own
    // write() call blocks indefinitely, wedging it forever with neither a
    // 'message' nor an 'exit' ever following. Capturing stderr (bounded)
    // also gives the timeout/crash error message something more useful to
    // say than a bare exit code.
    let capturedStderr = '';
    if (child.stdout) child.stdout.on('data', () => {}); // discarded; nothing currently needs it
    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        capturedStderr = (capturedStderr + chunk.toString()).slice(-MAX_CAPTURED_STDERR);
        if (DEBUG) process.stdout.write(chunk); // live-print the child's own checkpoints
      });
    }

    const timeoutTimer = setTimeout(() => {
      checkpoint(`TIMEOUT fired for jobId=${jobId}`);
      if (registry.get(jobId) !== child) return; // already resolved/cancelled
      registry.remove(jobId);
      const suffix = capturedStderr.trim() ? ` — last output: ${capturedStderr.trim()}` : '';
      _reportResult(jobId, panel, {
        ok: false,
        error: `Extraction timed out after ${effectiveTimeoutMs}ms${suffix}`,
      });
      try { child.kill(); } catch (_) {}
    }, effectiveTimeoutMs);

    child.once('message', (result) => {
      checkpoint(`'message' received for jobId=${jobId} — ok=${result && result.ok}`);
      clearTimeout(timeoutTimer);
      registry.remove(jobId);
      _reportResult(jobId, panel, result);
      try { child.kill(); } catch (_) {}
    });

    child.once('exit', (code, signal) => {
      checkpoint(`'exit' received for jobId=${jobId} — code=${code} signal=${signal}`);
      clearTimeout(timeoutTimer);
      // If we got here WITHOUT a 'message' having already fired and
      // removed the registry entry, the child ended without successfully
      // reporting a result — a crash, a kill from cancel-extract.js, OR
      // (the case that motivated this) the process.send()/process.exit()
      // race documented in extract-preview-child.js's own header: the
      // child can exit perfectly cleanly (code 0, no signal) while its
      // final message was silently dropped. A clean exit code is NOT
      // proof a message went out — only registry.get(jobId) still
      // pointing at this child tells us nothing else already handled it.
      // signal != null (killed by cancel-extract.js, or the worker
      // process exiting) is the one case with deliberately nothing to
      // report — the UI already knows why in that case.
      if (registry.get(jobId) === child) {
        registry.remove(jobId);
        if (signal == null) {
          const suffix = capturedStderr.trim() ? ` — last output: ${capturedStderr.trim()}` : '';
          const reason = code === 0
            ? `Extraction process exited without reporting a result${suffix}`
            : `Extraction process exited with code ${code}${suffix}`;
          _reportResult(jobId, panel, { ok: false, error: reason });
        }
      } else {
        checkpoint(`'exit' for jobId=${jobId} — registry entry already cleared, nothing to do`);
      }
    });

    ctx.done({ jobId });
    checkpoint(`start() returned jobId=${jobId} to the caller`);
  },
};

/**
 * Relay the child's result up through the worker process's existing IPC
 * channel to main.js, using EVT.EXTRACT_RESULT — completely independent
 * of the normal task progress/done/error flow, since this task itself has
 * already finished and returned by the time this fires.
 *
 * @param {string} jobId
 * @param {string} panel
 * @param {{ok:true,html:string,kind:string|null}|{ok:false,error:string}} result
 */
function _reportResult(jobId, panel, result) {
  if (!process.send) return; // not running as a forked child (e.g. a test) — nothing to relay to
  process.send(msg(EVT.EXTRACT_RESULT, { jobId, panel, result }));
}
