'use strict';

/**
 * test/child-stdio-drain.test.js
 *
 * Direct verification of the specific failure mode that motivated draining
 * stdout/stderr in worker/tasks/extract-preview.js and worker/tasks/
 * calc-size.js: `fork(script, { silent: true })` pipes the child's stdio
 * rather than inheriting or closing it. If nothing ever reads those pipes
 * and the child writes enough to fill the OS pipe buffer (commonly 64KB),
 * the child's own write() call blocks indefinitely — it never crashes,
 * never exits, never sends its result. Neither 'message' nor 'exit' ever
 * fires on the parent side, so nothing depending on those events (a
 * timeout included, since the child is still "alive" as far as the OS is
 * concerned) can detect or recover from it on its own; only actively
 * reading the pipes prevents the wedge from happening at all.
 *
 * This is a standalone check of the underlying Node.js mechanism, not a
 * re-test of extract-preview.js/calc-size.js's own task logic (already
 * covered in test/tasks.test.js) — it confirms actively draining stdout/
 * stderr lets a child that writes well past a typical pipe buffer's
 * capacity still complete normally, using a throwaway fixture script.
 * (An earlier version of this file also tried to assert the OPPOSITE —
 * that leaving stdio undrained reliably wedges the same child — but OS
 * pipe-buffer capacity isn't something a portable test can force within a
 * bounded wait across every environment; that assertion was removed as
 * inherently flaky rather than kept for a false sense of completeness.)
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { fork } = require('child_process');
const fs   = require('fs');
const fsp  = require('fs/promises');
const os   = require('os');
const path = require('path');

let fixtureDir;
let fixtureScript;

before(async () => {
  fixtureDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'paco-stdio-drain-'));
  fixtureScript = path.join(fixtureDir, 'loud-child.js');
  // Writes well past any typical OS pipe buffer size (commonly 64KB on
  // Linux, similar order of magnitude elsewhere) to stderr before
  // reporting success and exiting — if the parent isn't draining that
  // pipe, this write blocks forever and 'message'/'exit' never fire.
  fs.writeFileSync(fixtureScript, `
    process.stderr.write('x'.repeat(2 * 1024 * 1024)); // 2MB, far past any pipe buffer
    if (process.send) process.send({ ok: true });
    process.exit(0);
  `);
});

after(async () => {
  await fsp.rm(fixtureDir, { recursive: true, force: true });
});

describe('child stdio draining', () => {
  test('a child that writes a large amount to stderr completes normally when stdout/stderr are actively drained', async () => {
    const child = fork(fixtureScript, [], { silent: true });

    // The fix: actively drain both pipes, exactly as extract-preview.js
    // and calc-size.js now do — discarding the content is fine here,
    // since only the ABSENCE of a reader causes the wedge, not what's
    // done with the data once read.
    if (child.stdout) child.stdout.on('data', () => {});
    if (child.stderr) child.stderr.on('data', () => {});

    const outcome = await new Promise((resolve) => {
      let settled = false;
      const guard = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill('SIGKILL');
        resolve({ completed: false });
      }, 5000);

      child.once('message', (msg) => {
        if (settled) return;
        settled = true;
        clearTimeout(guard);
        resolve({ completed: true, message: msg });
      });
      child.once('exit', () => {
        if (settled) return;
        settled = true;
        clearTimeout(guard);
        resolve({ completed: true, message: null });
      });
    });

    assert.equal(outcome.completed, true, 'child should complete (not wedge) when its stdio is actively drained');
    assert.equal(outcome.message && outcome.message.ok, true);
  });

  // NOTE: a companion "leave stdio undrained and confirm it wedges" test
  // was deliberately removed rather than left flaky. Whether an unread
  // pipe actually blocks a child's write() within any given time bound
  // depends on the OS's pipe buffer capacity (traditionally ~64KB on
  // Linux, but not guaranteed, and some environments configure it
  // larger) — a well-documented Node.js child_process gotcha, but not
  // something a portable test can reliably force within a bounded wait
  // across every environment this suite might run in. The test above
  // (drained stdio completes correctly) is the one that actually matters
  // for correctness; asserting the absence of the fix reliably breaks
  // would make this suite's pass/fail depend on kernel internals rather
  // than on PACO's own code.
});
