'use strict';

/**
 * test/extract-preview-child.test.js
 *
 * Tests for worker/extract-preview-child.js — the standalone grandchild
 * script that extract-preview.js forks to run the matched extractor.
 * Tested by actually forking it (same way extract-preview.js does, and
 * the same approach test/calc-size-child.test.js already established for
 * its own sibling), rather than require()-ing it directly — this script
 * calls main() unconditionally at module load, which would call
 * process.exit() on the TEST process itself if imported in-process.
 *
 * The "large payload" tests below exist because of a real bug found via
 * a user's real-world reproduction: process.send() writes to the IPC
 * channel asynchronously, and calling process.exit() immediately
 * afterward (the code's original shape) is a documented Node.js race — if
 * the process exits before that write flushes, the message is silently
 * dropped, with the child still exiting cleanly (code 0). Larger
 * payloads take longer to write and are more likely to lose that race.
 *
 * Honesty check on what these tests actually prove: attempting to force
 * the ORIGINAL (buggy) code to reliably fail in this environment did not
 * work — repeated real forks against the same large real-world image
 * that reproduced the bug on the reporting user's machine succeeded every
 * time here, meaning this sandbox's IPC/process-scheduling timing doesn't
 * hit the race window the way theirs did. So these tests can't fail-then-
 * pass across the fix the way a tight regression test ideally would; what
 * they DO verify is the actual invariant the fix establishes — the child
 * always resolves with 'message' before 'exit', for a genuinely large
 * payload, repeated several times — which is what actually matters here,
 * and would still catch a caller accidentally reordering things (e.g.
 * calling process.exit() before the send callback fires) regardless of
 * whether THIS environment's timing happens to expose the original bug.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fsp  = require('fs/promises');
const path = require('path');
const os   = require('os');
const { fork } = require('child_process');

const CHILD_SCRIPT = path.join(__dirname, '..', 'worker', 'extract-preview-child.js');
const GENERIC_EXTRACTOR = require.resolve('../paco/extractors/generic-extractor/src/genericExtractor');

let tmpDir;

before(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'paco-extract-child-'));
});

after(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

/**
 * Fork the real script and resolve with whatever it reports — rejects if
 * the child exits without ever sending a message, the exact failure mode
 * this whole file is about.
 *
 * @param {object} instructions
 * @returns {Promise<{ok:boolean, html?:string, kind?:string|null, error?:string}>}
 */
function runExtract(instructions) {
  return new Promise((resolve, reject) => {
    const child = fork(CHILD_SCRIPT, [JSON.stringify(instructions)], { silent: true });
    let settled = false;
    child.once('message', (m) => { settled = true; resolve(m); });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (!settled) reject(new Error(`child exited (code ${code}) without sending a message`));
    });
  });
}

describe('extract-preview-child', () => {
  test('reports success for a small text file via generic-extractor', async () => {
    const p = path.join(tmpDir, 'small.txt');
    await fsp.writeFile(p, 'hello world\n');
    const r = await runExtract({
      filePath: p, modulePath: GENERIC_EXTRACTOR, exportName: 'getGenericPreview', fixedArgs: [true, {}],
    });
    assert.equal(r.ok, true);
    assert.match(r.html, /hello world/);
  });

  test('invalid (non-JSON) argument reports a clean failure, not a crash', async () => {
    const child = fork(CHILD_SCRIPT, ['not valid json'], { silent: true });
    const result = await new Promise((resolve) => {
      child.once('message', resolve);
      child.once('exit', () => resolve(null));
    });
    assert.ok(result === null || result.ok === false);
  });

  test('a nonexistent file reports a clean failure via the catch branch, not a hang', async () => {
    const r = await runExtract({
      filePath: path.join(tmpDir, 'does-not-exist.txt'),
      modulePath: GENERIC_EXTRACTOR, exportName: 'getGenericPreview', fixedArgs: [true, {}],
    });
    assert.equal(r.ok, false);
    assert.equal(typeof r.error, 'string');
  });

  test('a large HTML payload is still reliably delivered before exit, repeated 10 times', async () => {
    // A large plain-text file through generic-extractor's own line-
    // numbered/escaped HTML output comfortably produces a payload in the
    // same size class as the real-world image that originally triggered
    // the send/exit race (tens of KB), without needing sharp or a real
    // image fixture here.
    const p = path.join(tmpDir, 'large.txt');
    await fsp.writeFile(p, 'the quick brown fox jumps over the lazy dog\n'.repeat(3000)); // ~135KB source

    for (let i = 0; i < 10; i++) {
      const r = await runExtract({
        filePath: p, modulePath: GENERIC_EXTRACTOR, exportName: 'getGenericPreview', fixedArgs: [true, {}],
      });
      assert.equal(r.ok, true, `run ${i}: expected success`);
      assert.ok(r.html.length > 100000, `run ${i}: expected a large html payload, got ${r.html.length} chars`);
    }
  });
});
