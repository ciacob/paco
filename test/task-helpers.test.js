'use strict';

/**
 * test/task-helpers.test.js
 *
 * Tests for paco/task-helpers.js using Node.js v20+ built-in test runner.
 * Covers the pure helpers; I/O-dependent functions (refreshPanel etc.) are
 * tested indirectly via the task integration tests.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const helpers = require('../paco/task-helpers');

// ─── resolvePath ─────────────────────────────────────────────────────────────

describe('resolvePath', () => {
  test('resolves a relative path to absolute', () => {
    const r = helpers.resolvePath('some/dir');
    assert.ok(require('path').isAbsolute(r));
  });

  test('passes through an already-absolute path', () => {
    const r = helpers.resolvePath('/home/user/docs');
    assert.equal(r, '/home/user/docs');
  });

  test('throws for null/undefined', () => {
    assert.throws(() => helpers.resolvePath(null),    /required/i);
    assert.throws(() => helpers.resolvePath(undefined), /required/i);
  });
});

// ─── resolveStartupPath ────────────────────────────────────────────────────────

describe('resolveStartupPath', () => {
  const fs   = require('fs');
  const fsp  = require('fs/promises');
  const path = require('path');
  const os   = require('os');

  let tmpDir;

  before(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'paco-startup-'));
  });

  after(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  test('explicit requestedPath always wins, regardless of savedPath', async () => {
    const r = await helpers.resolveStartupPath(tmpDir, '/some/other/saved/path');
    assert.equal(r, path.resolve(tmpDir));
  });

  test('falls back to savedPath when no requestedPath given', async () => {
    const r = await helpers.resolveStartupPath('', tmpDir);
    assert.equal(r, path.resolve(tmpDir));
  });

  test('falls back to home when savedPath no longer exists', async () => {
    const ghost = path.join(tmpDir, 'this-was-deleted');
    const r = await helpers.resolveStartupPath('', ghost);
    assert.equal(r, os.homedir());
  });

  test('falls back to home when savedPath is a file, not a directory', async () => {
    const filePath = path.join(tmpDir, 'just-a-file.txt');
    await fsp.writeFile(filePath, 'x');
    const r = await helpers.resolveStartupPath('', filePath);
    assert.equal(r, os.homedir());
  });

  test('falls back to home when both requestedPath and savedPath are empty', async () => {
    const r = await helpers.resolveStartupPath('', '');
    assert.equal(r, os.homedir());
  });

  test('falls back to home when savedPath is null/undefined', async () => {
    const r1 = await helpers.resolveStartupPath('', null);
    const r2 = await helpers.resolveStartupPath('', undefined);
    assert.equal(r1, os.homedir());
    assert.equal(r2, os.homedir());
  });

  test('relative requestedPath gets resolved to absolute', async () => {
    const r = await helpers.resolveStartupPath('some/relative/dir', '');
    assert.ok(path.isAbsolute(r));
  });
});

// ─── dstFor ───────────────────────────────────────────────────────────────────

describe('dstFor', () => {
  test('joins dst dir with src basename', () => {
    const r = helpers.dstFor('/home/a/foo.txt', '/home/b');
    assert.equal(r, require('path').join('/home/b', 'foo.txt'));
  });

  test('works for directories', () => {
    const r = helpers.dstFor('/home/a/mydir', '/tmp/target');
    assert.equal(r, require('path').join('/tmp/target', 'mydir'));
  });
});

// ─── makeProgressTracker ──────────────────────────────────────────────────────

describe('makeProgressTracker', () => {
  test('returns rangeStart at beginning of first item', () => {
    const track = helpers.makeProgressTracker([1000, 1000], 10, 90);
    assert.equal(track(0, 0, 1000), 10);
  });

  test('returns rangeEnd when all bytes done', () => {
    const track = helpers.makeProgressTracker([1000, 1000], 10, 90);
    // After all 2000 bytes: track(1, 1000, 1000) = 10 + (2000/2000)*80 = 90
    assert.equal(track(1, 1000, 1000), 90);
  });

  test('reports midpoint correctly for two equal-sized items', () => {
    const track = helpers.makeProgressTracker([1000, 1000], 0, 100);
    // After first item fully done (bytesDone=1000 on item 0) = 50%
    assert.equal(track(0, 1000, 1000), 50);
  });

  test('accounts for varying item sizes', () => {
    // Item 0 = 100 bytes, item 1 = 900 bytes. Total = 1000.
    const track = helpers.makeProgressTracker([100, 900], 0, 100);
    // Completing item 0 = 10%
    assert.equal(track(0, 100, 100), 10);
    // Start of item 1 = still 10%
    assert.equal(track(1, 0, 900), 10);
    // Halfway through item 1 = 10 + 45 = 55%
    assert.equal(track(1, 450, 900), 55);
    // Completing item 1 = 100%
    assert.equal(track(1, 900, 900), 100);
  });

  test('handles all-zero sizes without dividing by zero', () => {
    const track = helpers.makeProgressTracker([0, 0], 20, 80);
    // Should not throw; returns rangeStart since total is treated as 1
    assert.doesNotThrow(() => track(0, 0, 0));
    assert.equal(track(0, 0, 0), 20);
  });

  test('result is always an integer', () => {
    const track = helpers.makeProgressTracker([3, 3], 0, 100);
    for (let i = 0; i < 3; i++) {
      const pct = track(0, i, 3);
      assert.equal(pct, Math.round(pct), `pct ${pct} should be integer`);
    }
  });

  test('result is clamped within [rangeStart, rangeEnd]', () => {
    const track = helpers.makeProgressTracker([500], 15, 85);
    const pcts = [0, 100, 250, 500].map(b => track(0, b, 500));
    for (const pct of pcts) {
      assert.ok(pct >= 15 && pct <= 85, `${pct} out of range [15, 85]`);
    }
  });
});
