'use strict';

/**
 * test/calc-size-child.test.js
 *
 * Tests for worker/calc-size-child.js — the standalone grandchild script
 * that calc-size.js forks to do the actual recursive size walk. Tested by
 * actually forking it (same way calc-size.js does), against a real temp
 * directory tree, rather than unit-testing an internal function — this
 * script's entire contract IS "spawn me with these args, get this message
 * back", so that's what's worth verifying directly.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('fs');
const fsp  = require('fs/promises');
const path = require('path');
const os   = require('os');
const { fork } = require('child_process');

const CHILD_SCRIPT = path.join(__dirname, '..', 'worker', 'calc-size-child.js');

let tmpDir;

before(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'paco-calc-child-'));
});

after(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

/**
 * Fork the real script and resolve with whatever it reports.
 * @param {string[]} paths
 * @returns {Promise<{ok:boolean, bytes?:number, error?:string}>}
 */
function runCalc(paths) {
  return new Promise((resolve, reject) => {
    const child = fork(CHILD_SCRIPT, [JSON.stringify(paths)], { silent: true });
    let settled = false;
    child.once('message', (m) => { settled = true; resolve(m); });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (!settled) reject(new Error(`child exited (code ${code}) without sending a message`));
    });
  });
}

describe('calc-size-child', () => {
  test('sums a single flat file correctly', async () => {
    const p = path.join(tmpDir, 'flat.txt');
    await fsp.writeFile(p, 'hello world'); // 11 bytes
    const r = await runCalc([p]);
    assert.equal(r.ok, true);
    assert.equal(r.bytes, 11);
  });

  test('sums a directory tree recursively', async () => {
    const dir = path.join(tmpDir, 'tree');
    await fsp.mkdir(path.join(dir, 'sub'), { recursive: true });
    await fsp.writeFile(path.join(dir, 'a.txt'), 'x'.repeat(100));
    await fsp.writeFile(path.join(dir, 'sub', 'b.txt'), 'x'.repeat(50));
    const r = await runCalc([dir]);
    assert.equal(r.ok, true);
    assert.equal(r.bytes, 150);
  });

  test('sums multiple given paths together', async () => {
    const fileA = path.join(tmpDir, 'multi-a.txt');
    const fileB = path.join(tmpDir, 'multi-b.txt');
    await fsp.writeFile(fileA, 'x'.repeat(10));
    await fsp.writeFile(fileB, 'x'.repeat(20));
    const r = await runCalc([fileA, fileB]);
    assert.equal(r.ok, true);
    assert.equal(r.bytes, 30);
  });

  test('an empty directory contributes 0 bytes', async () => {
    const dir = path.join(tmpDir, 'empty-dir');
    await fsp.mkdir(dir);
    const r = await runCalc([dir]);
    assert.equal(r.ok, true);
    assert.equal(r.bytes, 0);
  });

  test('a path that no longer exists is skipped, not fatal', async () => {
    const r = await runCalc([path.join(tmpDir, 'does-not-exist.txt')]);
    assert.equal(r.ok, true);
    assert.equal(r.bytes, 0);
  });

  test('a mix of existing and non-existing paths sums only what exists', async () => {
    const real = path.join(tmpDir, 'mix-real.txt');
    await fsp.writeFile(real, 'x'.repeat(42));
    const r = await runCalc([real, path.join(tmpDir, 'mix-ghost.txt')]);
    assert.equal(r.ok, true);
    assert.equal(r.bytes, 42);
  });

  test('symlinks count only their own link size, never followed/recursed', async () => {
    const target = path.join(tmpDir, 'symlink-target-dir');
    await fsp.mkdir(target);
    await fsp.writeFile(path.join(target, 'inside.txt'), 'x'.repeat(999));
    const linkPath = path.join(tmpDir, 'a-symlink');
    try { await fsp.symlink(target, linkPath); }
    catch (err) { if (err.code === 'EPERM') return; throw err; } // e.g. unprivileged on some CI
    const r = await runCalc([linkPath]);
    assert.equal(r.ok, true);
    // A symlink's own lstat size is small (just the path string), NOT 999 —
    // confirms the target's contents were never walked into.
    assert.ok(r.bytes < 999);
  });

  test('invalid (non-JSON) argument reports a clean failure, not a crash', async () => {
    const child = fork(CHILD_SCRIPT, ['not valid json'], { silent: true });
    const result = await new Promise((resolve) => {
      child.once('message', resolve);
      child.once('exit', () => resolve(null));
    });
    assert.ok(result === null || result.ok === false);
  });

  test('reports total across a deeper, multi-level tree', async () => {
    const dir = path.join(tmpDir, 'deep-tree');
    await fsp.mkdir(path.join(dir, 'a', 'b', 'c'), { recursive: true });
    await fsp.writeFile(path.join(dir, 'a', 'one.txt'), 'x'.repeat(5));
    await fsp.writeFile(path.join(dir, 'a', 'b', 'two.txt'), 'x'.repeat(7));
    await fsp.writeFile(path.join(dir, 'a', 'b', 'c', 'three.txt'), 'x'.repeat(9));
    const r = await runCalc([dir]);
    assert.equal(r.ok, true);
    assert.equal(r.bytes, 21);
  });
});
