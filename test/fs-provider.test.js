'use strict';

/**
 * test/fs-provider.test.js
 *
 * Tests for paco/fs-provider.js using Node.js v20+ built-in test runner.
 * Covers the pure helpers (breadcrumbs, parentDir, sort) and the async
 * list/stat/mkdir/rename/remove functions against a real temp directory.
 */

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('fs');
const fsp  = require('fs/promises');
const path = require('path');
const os   = require('os');
const provider = require('../paco/fs-provider');

// ─── Temp dir fixture ─────────────────────────────────────────────────────────

let tmpDir;

before(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'paco-fs-test-'));
});

after(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

// ─── breadcrumbs ─────────────────────────────────────────────────────────────

describe('breadcrumbs', () => {
  test('root returns single crumb', () => {
    const c = provider.breadcrumbs('/');
    assert.equal(c.length, 1);
    assert.equal(c[0].label, '/');
    assert.equal(c[0].path, '/');
  });

  test('three-level unix path', () => {
    const c = provider.breadcrumbs('/home/user/docs');
    assert.equal(c.length, 4);
    assert.equal(c[0].label, '/');
    assert.equal(c[1].label, 'home');
    assert.equal(c[2].label, 'user');
    assert.equal(c[3].label, 'docs');
    assert.equal(c[3].path, '/home/user/docs');
  });

  test('each crumb path is navigable prefix', () => {
    const c = provider.breadcrumbs('/a/b/c');
    assert.equal(c[1].path, '/a');
    assert.equal(c[2].path, '/a/b');
    assert.equal(c[3].path, '/a/b/c');
  });

  test('windows-style path (windows only)', { skip: process.platform !== 'win32' }, () => {
    const c = provider.breadcrumbs('C:\\Users\\foo');
    assert.ok(c.length >= 2);
    assert.equal(c[0].label, 'C:\\');
  });
});

// ─── parentDir ────────────────────────────────────────────────────────────────

describe('parentDir', () => {
  test('returns parent for normal path', () => {
    const p = provider.parentDir('/home/user/docs');
    assert.equal(p, '/home/user');
  });

  test('at root returns root', () => {
    assert.equal(provider.parentDir('/'), '/');
  });
});

// ─── list ─────────────────────────────────────────────────────────────────────

describe('list', () => {
  beforeEach(async () => {
    // Clear and repopulate temp dir for each test
    const existing = await fsp.readdir(tmpDir);
    for (const f of existing) {
      await fsp.rm(path.join(tmpDir, f), { recursive: true, force: true });
    }
  });

  test('returns entries for a populated directory', async () => {
    await fsp.writeFile(path.join(tmpDir, 'file.txt'), 'hello');
    await fsp.mkdir(path.join(tmpDir, 'subdir'));
    const entries = await provider.list(tmpDir);
    assert.ok(entries.length >= 2);
  });

  test('dirs come before files', async () => {
    await fsp.writeFile(path.join(tmpDir, 'aaa.txt'), '');
    await fsp.mkdir(path.join(tmpDir, 'zzz-dir'));
    const entries = await provider.list(tmpDir, { sortBy: 'name', sortAsc: true });
    const dirIdx  = entries.findIndex(e => e.type === 'dir');
    const fileIdx = entries.findIndex(e => e.type === 'file');
    assert.ok(dirIdx < fileIdx, 'dirs should come before files');
  });

  test('entries have expected shape', async () => {
    await fsp.writeFile(path.join(tmpDir, 'shape.txt'), 'data');
    const entries = await provider.list(tmpDir);
    const e = entries.find(x => x.name === 'shape.txt');
    assert.ok(e, 'entry not found');
    assert.equal(e.type, 'file');
    assert.equal(e.size, 4);
    assert.ok(typeof e.mtime === 'number');
    assert.ok(typeof e.hidden === 'boolean');
    assert.ok(typeof e.readable === 'boolean');
  });

  test('hidden files excluded by default (dot files)', async () => {
    await fsp.writeFile(path.join(tmpDir, '.hidden'), '');
    await fsp.writeFile(path.join(tmpDir, 'visible.txt'), '');
    const entries = await provider.list(tmpDir, { showHidden: false });
    assert.ok(!entries.find(e => e.name === '.hidden'));
    assert.ok(entries.find(e => e.name === 'visible.txt'));
  });

  test('hidden files included when showHidden=true', async () => {
    await fsp.writeFile(path.join(tmpDir, '.dotfile'), '');
    const entries = await provider.list(tmpDir, { showHidden: true });
    assert.ok(entries.find(e => e.name === '.dotfile'));
  });

  test('sort by name ascending', async () => {
    await fsp.writeFile(path.join(tmpDir, 'charlie.txt'), '');
    await fsp.writeFile(path.join(tmpDir, 'alpha.txt'), '');
    await fsp.writeFile(path.join(tmpDir, 'bravo.txt'), '');
    const entries = await provider.list(tmpDir, { sortBy: 'name', sortAsc: true });
    const names = entries.map(e => e.name);
    assert.deepEqual(names, [...names].sort((a,b) => a.localeCompare(b, undefined, { sensitivity: 'base' })));
  });

  test('sort by name descending', async () => {
    await fsp.writeFile(path.join(tmpDir, 'charlie.txt'), '');
    await fsp.writeFile(path.join(tmpDir, 'alpha.txt'), '');
    const entries = await provider.list(tmpDir, { sortBy: 'name', sortAsc: false });
    const names = entries.map(e => e.name);
    const sorted = [...names].sort((a,b) => b.localeCompare(a, undefined, { sensitivity: 'base' }));
    assert.deepEqual(names, sorted);
  });

  test('sort by size', async () => {
    await fsp.writeFile(path.join(tmpDir, 'big.txt'),   'x'.repeat(500));
    await fsp.writeFile(path.join(tmpDir, 'small.txt'), 'x'.repeat(10));
    const entries = await provider.list(tmpDir, { sortBy: 'size', sortAsc: true });
    const sizes = entries.filter(e => e.type === 'file').map(e => e.size);
    assert.deepEqual(sizes, [...sizes].sort((a, b) => a - b));
  });

  test('returns empty array for empty directory', async () => {
    const emptyDir = await fsp.mkdtemp(path.join(tmpDir, 'empty-'));
    const entries = await provider.list(emptyDir);
    assert.equal(entries.length, 0);
  });
});

// ─── stat ─────────────────────────────────────────────────────────────────────

describe('stat', () => {
  test('returns FsEntry for a file', async () => {
    const p = path.join(tmpDir, 'stat-test.txt');
    await fsp.writeFile(p, 'hello world');
    const e = await provider.stat(p);
    assert.equal(e.type, 'file');
    assert.equal(e.name, 'stat-test.txt');
    assert.equal(e.size, 11);
  });

  test('includes a created (birthtime) field', async () => {
    const p = path.join(tmpDir, 'stat-created.txt');
    await fsp.writeFile(p, 'x');
    const e = await provider.stat(p);
    assert.equal(typeof e.created, 'number');
    assert.ok(e.created > 0);
  });

  test('returns FsEntry for a directory', async () => {
    const p = path.join(tmpDir, 'stat-dir');
    await fsp.mkdir(p, { recursive: true });
    const e = await provider.stat(p);
    assert.equal(e.type, 'dir');
    assert.equal(e.size, 0);
  });

  test('returns null for non-existent path', async () => {
    const e = await provider.stat(path.join(tmpDir, 'does-not-exist'));
    assert.equal(e, null);
  });
});

// ─── statDetails ──────────────────────────────────────────────────────────────

describe('statDetails', () => {
  test('returns null for a non-existent path', async () => {
    const r = await provider.statDetails(path.join(tmpDir, 'ghost-details.txt'));
    assert.equal(r, null);
  });

  test('returns octal permissions for a real file',
    { skip: process.platform === 'win32' }, async () => {
      const p = path.join(tmpDir, 'perms-644.txt');
      await fsp.writeFile(p, 'x');
      await fsp.chmod(p, 0o644);
      const r = await provider.statDetails(p);
      assert.equal(r.octal, '644');
      assert.equal(r.mode, 0o644);
    });

  test('octal reflects a different mode correctly',
    { skip: process.platform === 'win32' }, async () => {
      const p = path.join(tmpDir, 'perms-755.txt');
      await fsp.writeFile(p, 'x');
      await fsp.chmod(p, 0o755);
      const r = await provider.statDetails(p);
      assert.equal(r.octal, '755');
    });

  test('resolves an owner name on POSIX (falls back to numeric uid if unresolvable)',
    { skip: process.platform === 'win32' }, async () => {
      const p = path.join(tmpDir, 'owner-test.txt');
      await fsp.writeFile(p, 'x');
      const r = await provider.statDetails(p);
      assert.equal(typeof r.owner, 'string');
      assert.ok(r.owner.length > 0);
    });

  test('owner is null on Windows (no meaningful POSIX owner concept)',
    { skip: process.platform !== 'win32' }, async () => {
      const p = path.join(tmpDir, 'owner-win-test.txt');
      await fsp.writeFile(p, 'x');
      const r = await provider.statDetails(p);
      assert.equal(r.owner, null);
    });

  test('isReadOnly is false by default on POSIX (meaningless there; octal is authoritative)',
    { skip: process.platform === 'win32' }, async () => {
      const p = path.join(tmpDir, 'readonly-posix-test.txt');
      await fsp.writeFile(p, 'x');
      const r = await provider.statDetails(p);
      assert.equal(r.isReadOnly, false);
    });

  test('isExecutable reflects the real X_OK bit on POSIX',
    { skip: process.platform === 'win32' || (process.getuid && process.getuid() === 0) },
    async () => {
      const p = path.join(tmpDir, 'exec-test.sh');
      await fsp.writeFile(p, '#!/bin/sh\necho hi\n');
      await fsp.chmod(p, 0o644); // explicitly NOT executable
      const r1 = await provider.statDetails(p);
      assert.equal(r1.isExecutable, false);
      await fsp.chmod(p, 0o755);
      const r2 = await provider.statDetails(p);
      assert.equal(r2.isExecutable, true);
    });

  test('works for a directory too', async () => {
    const p = path.join(tmpDir, 'details-dir');
    await fsp.mkdir(p);
    const r = await provider.statDetails(p);
    assert.ok(r);
    assert.equal(typeof r.octal, 'string');
  });
});

// ─── mkdir ────────────────────────────────────────────────────────────────────

describe('mkdir', () => {
  test('creates a directory', async () => {
    const p = path.join(tmpDir, 'new-dir');
    await provider.mkdir(p);
    assert.ok(fs.existsSync(p));
    assert.ok(fs.statSync(p).isDirectory());
  });

  test('creates nested directories (recursive)', async () => {
    const p = path.join(tmpDir, 'a', 'b', 'c');
    await provider.mkdir(p);
    assert.ok(fs.existsSync(p));
  });

  test('is idempotent (no error if already exists)', async () => {
    const p = path.join(tmpDir, 'idempotent-dir');
    await provider.mkdir(p);
    await assert.doesNotReject(() => provider.mkdir(p));
  });
});

// ─── rename ───────────────────────────────────────────────────────────────────

describe('rename', () => {
  test('renames a file', async () => {
    const src = path.join(tmpDir, 'rename-src.txt');
    const dst = path.join(tmpDir, 'rename-dst.txt');
    await fsp.writeFile(src, 'data');
    await provider.rename(src, dst);
    assert.ok(!fs.existsSync(src));
    assert.ok(fs.existsSync(dst));
  });
});

// ─── copy ─────────────────────────────────────────────────────────────────────

describe('copy', () => {
  test('copies a file and preserves content', async () => {
    const src = path.join(tmpDir, 'copy-src.txt');
    const dst = path.join(tmpDir, 'copy-dst.txt');
    await fsp.writeFile(src, 'hello copy');
    await provider.copy(src, dst);
    assert.ok(fs.existsSync(dst));
    assert.equal(fs.readFileSync(dst, 'utf8'), 'hello copy');
  });

  test('source is not removed after copy', async () => {
    const src = path.join(tmpDir, 'copy-src2.txt');
    const dst = path.join(tmpDir, 'copy-dst2.txt');
    await fsp.writeFile(src, 'keep me');
    await provider.copy(src, dst);
    assert.ok(fs.existsSync(src));
  });

  test('calls onProgress at least once', async () => {
    const src = path.join(tmpDir, 'progress-src.txt');
    const dst = path.join(tmpDir, 'progress-dst.txt');
    await fsp.writeFile(src, 'x'.repeat(1024));
    let called = false;
    await provider.copy(src, dst, () => { called = true; });
    assert.ok(called);
  });

  test('copies a directory recursively', async () => {
    const srcDir = path.join(tmpDir, 'copy-dir-src');
    const dstDir = path.join(tmpDir, 'copy-dir-dst');
    await fsp.mkdir(path.join(srcDir, 'sub'), { recursive: true });
    await fsp.writeFile(path.join(srcDir, 'top.txt'), 'top');
    await fsp.writeFile(path.join(srcDir, 'sub', 'nested.txt'), 'nested');
    await provider.copy(srcDir, dstDir);
    assert.ok(fs.existsSync(path.join(dstDir, 'top.txt')));
    assert.ok(fs.existsSync(path.join(dstDir, 'sub', 'nested.txt')));
  });
});

// ─── remove ───────────────────────────────────────────────────────────────────

describe('remove', () => {
  test('removes a file', async () => {
    const p = path.join(tmpDir, 'remove-me.txt');
    await fsp.writeFile(p, 'bye');
    await provider.remove(p);
    assert.ok(!fs.existsSync(p));
  });

  test('removes a directory recursively', async () => {
    const d = path.join(tmpDir, 'remove-dir');
    await fsp.mkdir(path.join(d, 'sub'), { recursive: true });
    await fsp.writeFile(path.join(d, 'sub', 'file.txt'), 'x');
    await provider.remove(d);
    assert.ok(!fs.existsSync(d));
  });

  test('does not throw for non-existent path (force)', async () => {
    await assert.doesNotReject(() => provider.remove(path.join(tmpDir, 'ghost')));
  });
});

// ─── move ─────────────────────────────────────────────────────────────────────

describe('move', () => {
  test('moves a file (same volume)', async () => {
    const src = path.join(tmpDir, 'move-src.txt');
    const dst = path.join(tmpDir, 'move-dst.txt');
    await fsp.writeFile(src, 'move me');
    await provider.move(src, dst);
    assert.ok(!fs.existsSync(src));
    assert.ok(fs.existsSync(dst));
    assert.equal(fs.readFileSync(dst, 'utf8'), 'move me');
  });
});
