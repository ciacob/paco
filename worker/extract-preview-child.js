'use strict';

/**
 * worker/extract-preview-child.js
 *
 * Standalone script, run as its own child process via child_process.fork()
 * from worker/tasks/extract-preview.js — NOT a worker/tasks/*.js task
 * itself (no TaskShell ctx, no progress reporting), same relationship
 * calc-size-child.js has to calc-size.js. Its only job: read the target
 * file's bytes, call the extractor function the parent already resolved
 * (via the matched renderer's glue.js — see extract-preview.js), and
 * report the result (or an error) back to its parent via IPC, then exit.
 *
 * Receives its instructions via process.argv (JSON-encoded), same
 * simplicity reasoning as calc-size-child.js: a single, one-shot input
 * that never changes after spawn doesn't need an IPC round-trip to
 * deliver.
 *
 * argv[2] (JSON): { filePath: string, modulePath: string, exportName: string, fixedArgs: any[] }
 *
 * Sends exactly one message before exiting:
 *   { ok: true,  html: string, kind: string|null }
 *   { ok: false, error: string }
 *
 * `kind` is media-extractor's own confirmed 'video'|'audio' classification
 * when the invoked extractor is media-extractor and it found a usable
 * stream; null for every other extractor (they don't have anything
 * equivalent to report) and null on failure. The parent relays it as-is —
 * see extract-preview.js and paco-app.js's handling of the filmstrip/
 * waveform tab-guess-vs-confirmed-kind mismatch case.
 *
 * IMPORTANT: process.send() writes to the IPC channel ASYNCHRONOUSLY —
 * calling process.exit() immediately afterward is a well-documented
 * Node.js race: if the process exits before that write actually flushes,
 * the message is silently dropped, with the child still exiting cleanly
 * (code 0) as far as the parent can see. Larger payloads take longer to
 * write and are correspondingly more likely to lose that race — this is
 * exactly what a large real-world photo's HTML output triggered in
 * practice. _sendThenExit() below waits for process.send()'s own
 * callback (confirming the write completed) before exiting, closing the
 * race entirely rather than hoping the timing works out.
 *
 * DEBUGGING: set PACO_EXTRACT_DEBUG=1 in the environment to print
 * timestamped checkpoints to stderr at every major step. Off by default —
 * this is temporary diagnostic instrumentation, not permanent logging.
 * extract-preview.js's own stderr drain prints these live (rather than
 * only capturing them silently) when the same env var is set, so they
 * show up directly in the main process's console when running the real
 * app, not just in a one-off manual repro script.
 */

const fs = require('fs');

const DEBUG = process.env.PACO_EXTRACT_DEBUG === '1';
function checkpoint(label) {
  if (!DEBUG) return;
  process.stderr.write(`[extract-child ${new Date().toISOString()}] ${label}\n`);
}

checkpoint('script started');

/**
 * Send a message and only exit once it's actually been written, instead
 * of racing process.exit() against process.send()'s asynchronous flush.
 * Falls back to exiting immediately if process.send isn't available at
 * all (e.g. not actually running as a forked child).
 *
 * @param {object} message
 * @param {number} code — exit code
 */
function sendThenExit(message, code) {
  checkpoint(`sendThenExit called — ok=${message.ok}`);
  if (!process.send) {
    checkpoint('process.send unavailable — exiting directly');
    process.exit(code);
    return;
  }
  process.send(message, () => {
    checkpoint('process.send callback fired — write confirmed flushed, exiting now');
    process.exit(code);
  });
  checkpoint('process.send() call returned (callback pending)');
}

async function main() {
  const rawArg = process.argv[2];
  let instructions;
  try {
    instructions = JSON.parse(rawArg);
    checkpoint('parsed instructions: ' + JSON.stringify({ ...instructions, filePath: instructions.filePath }));
  } catch (_) {
    checkpoint('JSON.parse of argv failed');
    sendThenExit({ ok: false, error: 'Invalid arguments to extract-preview-child' }, 1);
    return;
  }

  const { filePath, modulePath, exportName, fixedArgs } = instructions;

  try {
    checkpoint(`reading file: ${filePath}`);
    const fileBuffer = await fs.promises.readFile(filePath);
    checkpoint(`read ${fileBuffer.length} bytes`);

    checkpoint(`requiring extractor module: ${modulePath}`);
    const extractorModule = require(modulePath);
    checkpoint('extractor module loaded');

    const fn = extractorModule[exportName];
    if (typeof fn !== 'function') {
      throw new Error(`"${exportName}" is not a function on ${modulePath}`);
    }

    checkpoint(`calling ${exportName}(...)`);
    // Every extractor's main entry point is either sync (generic-extractor)
    // or async (text/image/media-extractor) — Promise.resolve() handles
    // both uniformly without this script needing to know which.
    const result = await Promise.resolve(fn(fileBuffer, ...(fixedArgs || [])));
    checkpoint(`${exportName}(...) resolved — error=${result && result.error ? JSON.stringify(result.error) : 'none'}, html length=${result && result.html ? result.html.length : 'n/a'}`);

    if (!result || result.error) {
      const message = (result && result.error && result.error.message) || 'Extraction failed';
      sendThenExit({ ok: false, error: message }, 0);
    } else {
      sendThenExit({ ok: true, html: result.html, kind: result.kind || null }, 0);
    }
  } catch (err) {
    checkpoint(`caught exception: ${err && err.stack}`);
    sendThenExit({ ok: false, error: err.message }, 0);
  }
}

main();
