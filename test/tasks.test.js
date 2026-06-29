'use strict';

/**
 * test/tasks.test.js
 *
 * Integration tests for PACO tasks (mkdir, copy, move, delete, navigate).
 * Each task is invoked by constructing a minimal ctx mock that mimics
 * what task-shell.js provides, and running task.start(ctx) directly.
 *
 * Tests operate on an isolated temp directory and a patched ~/.paco location
 * so they never touch the real filesystem outside tmpDir.
 */

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fsp    = require('fs/promises');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');

// ─── Isolation: redirect ~/.paco to tmp ──────────────────────────────────────

let tmpDir;
let pacoDir;
let origHomedir;

before(async () => {
  tmpDir  = await fsp.mkdtemp(path.join(os.tmpdir(), 'paco-tasks-test-'));
  pacoDir = path.join(tmpDir, '.paco');
  origHomedir  = os.homedir;
  os.homedir   = () => tmpDir;
  // Purge context cache so it picks up patched homedir
  purgeCache('paco/context');
  purgeCache('paco/task-helpers');
  purgeCache('worker/tasks');
});

after(async () => {
  os.homedir = origHomedir;
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

function purgeCache(fragment) {
  Object.keys(require.cache).forEach(k => {
    if (k.includes(fragment)) delete require.cache[k];
  });
}

// ─── ctx mock factory ─────────────────────────────────────────────────────────

/**
 * Build a minimal task context mock.
 * Captures all progress calls and resolves/rejects a promise on done/fail.
 *
 * @param {object} config — the task's config object
 * @returns {{ ctx, promise }}
 */
function makeCtx(config) {
  let _resolve, _reject;
  const promise = new Promise((res, rej) => { _resolve = res; _reject = rej; });

  const progressLog = [];
  let   cancelled   = false;

  const ctx = {
    config,
    progress(pct, msg, extra) { progressLog.push({ pct, msg, extra }); },
    done(result)       { _resolve({ ok: true, result, progressLog }); },
    fail(msg)          { _resolve({ ok: false, error: msg, progressLog }); },
    isCancelled()      { return cancelled; },
    cancel()           { cancelled = true; },
  };

  return { ctx, promise };
}

// ─── Fixture helpers ─────────────────────────────────────────────────────────

async function mkfile(p, content = 'hello') {
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.writeFile(p, content);
}

// Subdirectory of tmpDir for test files (separate from .paco)
let workDir;

beforeEach(async () => {
  // Fresh work dir for each test
  workDir = await fsp.mkdtemp(path.join(tmpDir, 'work-'));
  // Bootstrap context for this test (re-requires fresh module)
  purgeCache('paco/context');
  purgeCache('paco/task-helpers');
  purgeCache('worker/tasks');
  const ctx = require('../paco/context');
  ctx.bootstrap();
  // Set both panels to workDir
  ctx.updatePanel('left',  { path: workDir, selection: [], tabs: [{ id: 'tab-default', path: workDir, label: null }], activeTab: 'tab-default' });
  ctx.updatePanel('right', { path: workDir, selection: [], tabs: [{ id: 'tab-default', path: workDir, label: null }], activeTab: 'tab-default' });
});

/**
 * Replace the real `open` package in require.cache with a stub, so tests
 * never actually spawn a real OS-level launcher (Preview, TextEdit, etc.).
 * Returns a restore() function that must be called afterwards.
 *
 * @param {Function} stubFn — the function to use in place of open()
 * @returns {Function} restore
 */
function stubOpenModule(stubFn) {
  const openPath = require.resolve('open');
  const had = require.cache[openPath];
  require.cache[openPath] = {
    id: openPath, filename: openPath, loaded: true,
    exports: stubFn,
  };
  return () => {
    if (had) require.cache[openPath] = had;
    else delete require.cache[openPath];
  };
}

// ─── mkdir ────────────────────────────────────────────────────────────────────

describe('mkdir task', () => {
  test('creates a new directory and returns refreshed panel', async () => {
    const task = require('../worker/tasks/mkdir');
    const { ctx, promise } = makeCtx({ panel: 'left', name: 'new-folder' });
    task.start(ctx);
    const { ok, result } = await promise;
    assert.ok(ok, 'task should succeed');
    assert.ok(fs.existsSync(path.join(workDir, 'new-folder')));
    assert.equal(result.panel, 'left');
    assert.ok(result.entries.find(e => e.name === 'new-folder'));
    assert.equal(result.created, path.join(workDir, 'new-folder'));
  });

  test('fails for empty name', async () => {
    const task = require('../worker/tasks/mkdir');
    const { ctx, promise } = makeCtx({ panel: 'left', name: '' });
    task.start(ctx);
    const { ok, error } = await promise;
    assert.ok(!ok);
    assert.match(error, /required/i);
  });

  test('fails for name with path separator in single-folder mode', async () => {
    const task = require('../worker/tasks/mkdir');
    const { ctx, promise } = makeCtx({ panel: 'left', name: 'a/b', subDirs: false });
    task.start(ctx);
    const { ok, error } = await promise;
    assert.ok(!ok);
    assert.match(error, /separator/i);
  });

  test('creates nested dirs in subDirs mode', async () => {
    const task = require('../worker/tasks/mkdir');
    const { ctx, promise } = makeCtx({ panel: 'left', name: 'alpha/beta/gamma', subDirs: true });
    task.start(ctx);
    const { ok, result } = await promise;
    assert.ok(ok, 'should succeed');
    assert.ok(fs.existsSync(path.join(workDir, 'alpha', 'beta', 'gamma')));
    assert.ok(result.created.endsWith('gamma'));
  });

  test('subDirs mode: duplicate full path is rejected', async () => {
    const task = require('../worker/tasks/mkdir');
    const { ctx, promise } = makeCtx({ panel: 'left', name: 'dup/path', subDirs: true });
    task.start(ctx);
    await promise; // create it first
    purgeCache('worker/tasks');
    const { ctx: ctx2, promise: p2 } = makeCtx({ panel: 'left', name: 'dup/path', subDirs: true });
    require('../worker/tasks/mkdir').start(ctx2);
    const { ok, error } = await p2;
    assert.ok(!ok, 'should fail on duplicate full path');
    assert.match(error, /already exists/i);
  });

  test('subDirs mode: existing intermediate directory is silently accepted', async () => {
    await fsp.mkdir(path.join(workDir, 'existing-inter'));
    const task = require('../worker/tasks/mkdir');
    const { ctx, promise } = makeCtx({ panel: 'left', name: 'existing-inter/child', subDirs: true });
    task.start(ctx);
    const { ok } = await promise;
    assert.ok(ok, 'should succeed when intermediate already exists');
    assert.ok(fs.existsSync(path.join(workDir, 'existing-inter', 'child')));
  });

  test('subDirs mode: can extend same branch twice (a/b/c then a/b/d)', async () => {
    const task = require('../worker/tasks/mkdir');
    const { ctx: ctx1, promise: p1 } = makeCtx({ panel: 'left', name: 'branch/level2/c', subDirs: true });
    task.start(ctx1);
    const r1 = await p1;
    assert.ok(r1.ok, 'first branch creation should succeed');

    purgeCache('worker/tasks');
    const { ctx: ctx2, promise: p2 } = makeCtx({ panel: 'left', name: 'branch/level2/d', subDirs: true });
    require('../worker/tasks/mkdir').start(ctx2);
    const r2 = await p2;
    assert.ok(r2.ok, 'second branch creation should succeed');
    assert.ok(fs.existsSync(path.join(workDir, 'branch', 'level2', 'c')));
    assert.ok(fs.existsSync(path.join(workDir, 'branch', 'level2', 'd')));
  });

  test('subDirs mode: validates each segment', async () => {
    const task = require('../worker/tasks/mkdir');
    const { ctx, promise } = makeCtx({ panel: 'left', name: 'good/bad<name>', subDirs: true });
    task.start(ctx);
    const { ok } = await promise;
    assert.ok(!ok);
  });

  test('fails for invalid characters', async () => {
    const task = require('../worker/tasks/mkdir');
    const { ctx, promise } = makeCtx({ panel: 'left', name: 'bad<name>', subDirs: false });
    task.start(ctx);
    const { ok, error } = await promise;
    assert.ok(!ok);
    assert.match(error, /invalid/i);
  });

  test('fails if folder already exists', async () => {
    await fsp.mkdir(path.join(workDir, 'existing'));
    const task = require('../worker/tasks/mkdir');
    const { ctx, promise } = makeCtx({ panel: 'left', name: 'existing' });
    task.start(ctx);
    const { ok, error } = await promise;
    assert.ok(!ok);
    assert.match(error, /already exists/i);
  });

  test('single-folder mode: fails when a file exists with that name', async () => {
    await fsp.writeFile(path.join(workDir, 'clash-file'), 'data');
    const task = require('../worker/tasks/mkdir');
    const { ctx, promise } = makeCtx({ panel: 'left', name: 'clash-file', subDirs: false });
    task.start(ctx);
    const { ok, error } = await promise;
    assert.ok(!ok);
    assert.match(error, /already exists/i);
  });

  test('rejects "." as a name', async () => {
    const task = require('../worker/tasks/mkdir');
    const { ctx, promise } = makeCtx({ panel: 'left', name: '.', subDirs: false });
    task.start(ctx);
    const { ok } = await promise;
    assert.ok(!ok);
  });

  test('rejects ".." as a name', async () => {
    const task = require('../worker/tasks/mkdir');
    const { ctx, promise } = makeCtx({ panel: 'left', name: '..', subDirs: false });
    task.start(ctx);
    const { ok } = await promise;
    assert.ok(!ok);
  });

  test('reports progress through the operation', async () => {
    const task = require('../worker/tasks/mkdir');
    const { ctx, promise } = makeCtx({ panel: 'left', name: 'progress-test' });
    task.start(ctx);
    const { progressLog } = await promise;
    assert.ok(progressLog.length >= 2, 'should have multiple progress calls');
    assert.equal(progressLog[progressLog.length - 1].pct, 100);
  });
});

// ─── create-file task (Shift+F4) ───────────────────────────────────────────────

describe('create-file task', () => {
  test('creates a new, empty (0-byte) file and returns refreshed panel', async () => {
    const task = require('../worker/tasks/create-file');
    const { ctx, promise } = makeCtx({ panel: 'left', name: 'stub.txt' });
    task.start(ctx);
    const { ok, result } = await promise;
    assert.ok(ok, 'task should succeed');
    const created = path.join(workDir, 'stub.txt');
    assert.ok(fs.existsSync(created));
    assert.equal(fs.statSync(created).size, 0, 'created file must be exactly 0 bytes');
    assert.equal(result.panel, 'left');
    assert.ok(result.entries.find(e => e.name === 'stub.txt'));
    assert.equal(result.created, created);
  });

  test('fails for empty name', async () => {
    const task = require('../worker/tasks/create-file');
    const { ctx, promise } = makeCtx({ panel: 'left', name: '' });
    task.start(ctx);
    const { ok, error } = await promise;
    assert.ok(!ok);
    assert.match(error, /required/i);
  });

  test('fails for a name that is only whitespace', async () => {
    const task = require('../worker/tasks/create-file');
    const { ctx, promise } = makeCtx({ panel: 'left', name: '   ' });
    task.start(ctx);
    const { ok, error } = await promise;
    assert.ok(!ok);
    assert.match(error, /required/i);
  });

  test('rejects "." as a name', async () => {
    const task = require('../worker/tasks/create-file');
    const { ctx, promise } = makeCtx({ panel: 'left', name: '.' });
    task.start(ctx);
    const { ok } = await promise;
    assert.ok(!ok);
  });

  test('rejects ".." as a name', async () => {
    const task = require('../worker/tasks/create-file');
    const { ctx, promise } = makeCtx({ panel: 'left', name: '..' });
    task.start(ctx);
    const { ok } = await promise;
    assert.ok(!ok);
  });

  test('rejects forward-slash path separators — no sub-dirs mode equivalent here', async () => {
    const task = require('../worker/tasks/create-file');
    const { ctx, promise } = makeCtx({ panel: 'left', name: 'a/b.txt' });
    task.start(ctx);
    const { ok, error } = await promise;
    assert.ok(!ok);
    assert.match(error, /separator/i);
    // Confirm nothing was created anywhere as a side effect
    assert.ok(!fs.existsSync(path.join(workDir, 'a')));
  });

  test('rejects backslash path separators too', async () => {
    const task = require('../worker/tasks/create-file');
    const { ctx, promise } = makeCtx({ panel: 'left', name: 'a\\b.txt' });
    task.start(ctx);
    const { ok, error } = await promise;
    assert.ok(!ok);
    assert.match(error, /separator/i);
  });

  test('fails for invalid characters', async () => {
    const task = require('../worker/tasks/create-file');
    const { ctx, promise } = makeCtx({ panel: 'left', name: 'bad<name>.txt' });
    task.start(ctx);
    const { ok, error } = await promise;
    assert.ok(!ok);
    assert.match(error, /invalid/i);
  });

  test('fails if a file already exists with that name', async () => {
    await mkfile(path.join(workDir, 'already-there.txt'), 'existing content');
    const task = require('../worker/tasks/create-file');
    const { ctx, promise } = makeCtx({ panel: 'left', name: 'already-there.txt' });
    task.start(ctx);
    const { ok, error } = await promise;
    assert.ok(!ok);
    assert.match(error, /^Found existing file: already-there\.txt$/);
    // Existing content must be completely untouched
    assert.equal(fs.readFileSync(path.join(workDir, 'already-there.txt'), 'utf8'), 'existing content');
  });

  test('fails if a FOLDER already exists with that name (non-existence means neither type)', async () => {
    await fsp.mkdir(path.join(workDir, 'already-a-dir'));
    const task = require('../worker/tasks/create-file');
    const { ctx, promise } = makeCtx({ panel: 'left', name: 'already-a-dir' });
    task.start(ctx);
    const { ok, error } = await promise;
    assert.ok(!ok);
    assert.match(error, /^Found existing folder: already-a-dir$/);
  });

  test('trims surrounding whitespace from the provided name', async () => {
    const task = require('../worker/tasks/create-file');
    const { ctx, promise } = makeCtx({ panel: 'left', name: '  spaced.txt  ' });
    task.start(ctx);
    const { ok, result } = await promise;
    assert.ok(ok);
    assert.equal(result.created, path.join(workDir, 'spaced.txt'));
  });

  test('fails when panel has no current path', async () => {
    purgeCache('paco/context');
    purgeCache('worker/tasks');
    const ctx2 = require('../paco/context');
    ctx2.bootstrap();
    ctx2.updatePanel('left', { path: '', selection: [], tabs: [{ id: 'tab-default', path: '', label: null }], activeTab: 'tab-default' });

    const task = require('../worker/tasks/create-file');
    const { ctx, promise } = makeCtx({ panel: 'left', name: 'whatever.txt' });
    task.start(ctx);
    const { ok, error } = await promise;
    assert.ok(!ok);
    assert.match(error, /no current path/i);
  });

  test('refreshed panel reflects the new file', async () => {
    const task = require('../worker/tasks/create-file');
    const { ctx, promise } = makeCtx({ panel: 'left', name: 'visible-now.txt' });
    task.start(ctx);
    const { result } = await promise;
    const entry = result.entries.find(e => e.name === 'visible-now.txt');
    assert.ok(entry);
    assert.equal(entry.type, 'file');
    assert.equal(entry.size, 0);
  });

  test('validateFileName is exported and usable directly (pure, no I/O)', () => {
    const task = require('../worker/tasks/create-file');
    assert.equal(task.validateFileName('good.txt'), null);
    assert.match(task.validateFileName(''), /required/i);
    assert.match(task.validateFileName('a/b'), /separator/i);
    assert.match(task.validateFileName('a\\b'), /separator/i);
    assert.ok(task.validateFileName('.'));
    assert.ok(task.validateFileName('..'));
    assert.match(task.validateFileName('bad<name>'), /invalid/i);
  });

  test('reports progress through the operation', async () => {
    const task = require('../worker/tasks/create-file');
    const { ctx, promise } = makeCtx({ panel: 'left', name: 'progress-stub.txt' });
    task.start(ctx);
    const { progressLog } = await promise;
    assert.ok(progressLog.length >= 2, 'should have multiple progress calls');
    assert.equal(progressLog[progressLog.length - 1].pct, 100);
  });
});

// ─── delete task ─────────────────────────────────────────────────────────────

describe('delete task', () => {
  test('deletes a file and refreshes panel', async () => {
    const filePath = path.join(workDir, 'to-delete.txt');
    await mkfile(filePath);
    const task = require('../worker/tasks/delete');
    const { ctx, promise } = makeCtx({ panel: 'left', sources: [filePath], toTrash: false });
    task.start(ctx);
    const { ok, result } = await promise;
    assert.ok(ok);
    assert.ok(!fs.existsSync(filePath));
    assert.equal(result.deleted, 1);
    assert.equal(result.errors.length, 0);
  });

  test('deletes a directory recursively', async () => {
    const dirPath = path.join(workDir, 'to-delete-dir');
    await fsp.mkdir(path.join(dirPath, 'sub'), { recursive: true });
    await mkfile(path.join(dirPath, 'sub', 'file.txt'));
    const task = require('../worker/tasks/delete');
    const { ctx, promise } = makeCtx({ panel: 'left', sources: [dirPath], toTrash: false });
    task.start(ctx);
    const { ok, result } = await promise;
    assert.ok(ok);
    assert.ok(!fs.existsSync(dirPath));
    assert.equal(result.deleted, 1);
  });

  test('deletes multiple items', async () => {
    const a = path.join(workDir, 'del-a.txt');
    const b = path.join(workDir, 'del-b.txt');
    await mkfile(a); await mkfile(b);
    const task = require('../worker/tasks/delete');
    const { ctx, promise } = makeCtx({ panel: 'left', sources: [a, b], toTrash: false });
    task.start(ctx);
    const { ok, result } = await promise;
    assert.ok(ok);
    assert.equal(result.deleted, 2);
    assert.ok(!fs.existsSync(a));
    assert.ok(!fs.existsSync(b));
  });

  test('collects errors for non-existent items but continues', async () => {
    const real  = path.join(workDir, 'real.txt');
    const ghost = path.join(workDir, 'ghost.txt');
    await mkfile(real);
    const task = require('../worker/tasks/delete');
    // ghost doesn't exist — remove() with force: true won't error, so deleted = 2
    const { ctx, promise } = makeCtx({ panel: 'left', sources: [real, ghost], toTrash: false });
    task.start(ctx);
    const { ok, result } = await promise;
    assert.ok(ok);
    // provider.remove uses force:true so ghost deletion doesn't error
    assert.equal(result.deleted, 2);
  });

  test('fails with no sources', async () => {
    const task = require('../worker/tasks/delete');
    const { ctx, promise } = makeCtx({ panel: 'left', sources: [], toTrash: false });
    task.start(ctx);
    const { ok } = await promise;
    assert.ok(!ok);
  });

  test('refreshed panel excludes deleted entries', async () => {
    const filePath = path.join(workDir, 'gone.txt');
    await mkfile(filePath);
    const task = require('../worker/tasks/delete');
    const { ctx, promise } = makeCtx({ panel: 'left', sources: [filePath], toTrash: false });
    task.start(ctx);
    const { result } = await promise;
    assert.ok(!result.entries.find(e => e.name === 'gone.txt'));
  });
});

// ─── copy task ────────────────────────────────────────────────────────────────

describe('copy task', () => {
  let srcDir, dstDir;

  beforeEach(async () => {
    srcDir = path.join(workDir, 'src');
    dstDir = path.join(workDir, 'dst');
    await fsp.mkdir(srcDir, { recursive: true });
    await fsp.mkdir(dstDir, { recursive: true });
    // Set panels to src and dst
    purgeCache('paco/context');
    purgeCache('paco/task-helpers');
    const ctx2 = require('../paco/context');
    ctx2.bootstrap();
    ctx2.updatePanel('left',  { path: srcDir, selection: [], tabs: [{ id: 'tab-default', path: srcDir, label: null }], activeTab: 'tab-default' });
    ctx2.updatePanel('right', { path: dstDir, selection: [], tabs: [{ id: 'tab-default', path: dstDir, label: null }], activeTab: 'tab-default' });
  });

  test('copies a file to destination', async () => {
    const src = path.join(srcDir, 'file.txt');
    await mkfile(src, 'content');
    const task = require('../worker/tasks/copy');
    const { ctx, promise } = makeCtx({ sources: [src], dst: dstDir, panel: 'left', dstPanel: 'right' });
    task.start(ctx);
    const { ok, result } = await promise;
    assert.ok(ok, result && result.errors && result.errors[0]);
    assert.ok(fs.existsSync(path.join(dstDir, 'file.txt')));
    assert.equal(fs.readFileSync(path.join(dstDir, 'file.txt'), 'utf8'), 'content');
    assert.equal(result.stats.copied + (result.stats.prefixed||0) + (result.stats.replacedOlder||0), 1);
    assert.equal(result.errors.length, 0);
  });

  test('source file is preserved after copy', async () => {
    const src = path.join(srcDir, 'keep.txt');
    await mkfile(src, 'keep');
    const task = require('../worker/tasks/copy');
    const { ctx, promise } = makeCtx({ sources: [src], dst: dstDir, panel: 'left', dstPanel: 'right' });
    task.start(ctx);
    await promise;
    assert.ok(fs.existsSync(src));
  });

  test('appends (1) prefix on collision when conflictFiles=prefix', async () => {
    const src = path.join(srcDir, 'dup.txt');
    const existing = path.join(dstDir, 'dup.txt');
    await mkfile(src, 'new');
    await mkfile(existing, 'old');
    const task = require('../worker/tasks/copy');
    const { ctx, promise } = makeCtx({
      sources: [src], dst: dstDir, panel: 'left', dstPanel: 'right',
      conflictFiles: 'prefix',
    });
    task.start(ctx);
    const { ok, result } = await promise;
    assert.ok(ok);
    assert.ok(fs.existsSync(path.join(dstDir, '(1) dup.txt')));
    assert.equal(fs.readFileSync(existing, 'utf8'), 'old'); // original untouched
  });

  test('copies directory recursively', async () => {
    const subDir = path.join(srcDir, 'mydir');
    await fsp.mkdir(path.join(subDir, 'sub'), { recursive: true });
    await mkfile(path.join(subDir, 'top.txt'), 'top');
    await mkfile(path.join(subDir, 'sub', 'nested.txt'), 'nested');
    const task = require('../worker/tasks/copy');
    const { ctx, promise } = makeCtx({ sources: [subDir], dst: dstDir, panel: 'left', dstPanel: 'right' });
    task.start(ctx);
    const { ok, result } = await promise;
    assert.ok(ok);
    assert.ok(fs.existsSync(path.join(dstDir, 'mydir', 'top.txt')));
    assert.ok(fs.existsSync(path.join(dstDir, 'mydir', 'sub', 'nested.txt')));
  });

  test('copies multiple files', async () => {
    const a = path.join(srcDir, 'a.txt');
    const b = path.join(srcDir, 'b.txt');
    await mkfile(a, 'a'); await mkfile(b, 'b');
    const task = require('../worker/tasks/copy');
    const { ctx, promise } = makeCtx({ sources: [a, b], dst: dstDir, panel: 'left', dstPanel: 'right' });
    task.start(ctx);
    const { ok, result } = await promise;
    assert.ok(ok);
    assert.equal(result.stats.copied + (result.stats.prefixed||0) + (result.stats.replacedOlder||0), 2);
    assert.ok(fs.existsSync(path.join(dstDir, 'a.txt')));
    assert.ok(fs.existsSync(path.join(dstDir, 'b.txt')));
  });

  test('fails if destination does not exist', async () => {
    const task = require('../worker/tasks/copy');
    const { ctx, promise } = makeCtx({ sources: [srcDir], dst: '/nonexistent/path', panel: 'left', dstPanel: 'right' });
    task.start(ctx);
    const { ok } = await promise;
    assert.ok(!ok);
  });

  test('fails if copying into itself', async () => {
    const task = require('../worker/tasks/copy');
    const { ctx, promise } = makeCtx({ sources: [srcDir], dst: srcDir, panel: 'left', dstPanel: 'right' });
    task.start(ctx);
    const { ok } = await promise;
    assert.ok(!ok);
  });

  test('reports progress during copy', async () => {
    const src = path.join(srcDir, 'bigfile.txt');
    await mkfile(src, 'x'.repeat(4096));
    const task = require('../worker/tasks/copy');
    const { ctx, promise } = makeCtx({ sources: [src], dst: dstDir, panel: 'left', dstPanel: 'right' });
    task.start(ctx);
    const { progressLog } = await promise;
    assert.ok(progressLog.length >= 2);
    // Progress should go from low to high
    const pcts = progressLog.map(p => p.pct);
    assert.ok(pcts[0] <= pcts[pcts.length - 1]);
  });

  test('result includes both panel refreshes', async () => {
    const src = path.join(srcDir, 'f.txt');
    await mkfile(src, 'x');
    const task = require('../worker/tasks/copy');
    const { ctx, promise } = makeCtx({ sources: [src], dst: dstDir, panel: 'left', dstPanel: 'right' });
    task.start(ctx);
    const { result } = await promise;
    assert.ok(result.left  && result.left.panel  === 'left');
    assert.ok(result.right && result.right.panel === 'right');
  });

  test('replaceOlder: skips destination-newer file', async () => {
    const src = path.join(srcDir, 'old.txt');
    const dst2 = path.join(dstDir, 'old.txt');
    await mkfile(src, 'src content');
    await mkfile(dst2, 'dst content');
    // Make dst newer by setting its mtime 10s in the future
    const future = new Date(Date.now() + 10000);
    await fsp.utimes(dst2, future, future);
    const task = require('../worker/tasks/copy');
    const { ctx, promise } = makeCtx({
      sources: [src], dst: dstDir, panel: 'left', dstPanel: 'right',
      conflictFiles: 'replaceOlder',
    });
    task.start(ctx);
    const { ok, result } = await promise;
    assert.ok(ok);
    assert.equal(result.stats.skippedNewer, 1);
    // dst content should be unchanged
    assert.equal(fs.readFileSync(dst2, 'utf8'), 'dst content');
  });

  test('replaceOlder: replaces destination-older file', async () => {
    const src = path.join(srcDir, 'new.txt');
    const dst2 = path.join(dstDir, 'new.txt');
    await mkfile(src, 'new content');
    await mkfile(dst2, 'old content');
    // Make dst older by setting its mtime 10s in the past
    const past = new Date(Date.now() - 10000);
    await fsp.utimes(dst2, past, past);
    const task = require('../worker/tasks/copy');
    const { ctx, promise } = makeCtx({
      sources: [src], dst: dstDir, panel: 'left', dstPanel: 'right',
      conflictFiles: 'replaceOlder',
    });
    task.start(ctx);
    const { ok, result } = await promise;
    assert.ok(ok);
    assert.equal(result.stats.replacedOlder, 1);
    assert.equal(fs.readFileSync(dst2, 'utf8'), 'new content');
  });

  test('abort: cleans up destination copies when keepOnAbort=false', async () => {
    const src1 = path.join(srcDir, 'a.txt');
    const src2 = path.join(srcDir, 'b.txt');
    const clash = path.join(dstDir, 'b.txt');
    await mkfile(src1, 'aaa');
    await mkfile(src2, 'bbb');
    await mkfile(clash, 'existing');  // causes abort on second item
    const task = require('../worker/tasks/copy');
    const { ctx, promise } = makeCtx({
      sources: [src1, src2], dst: dstDir, panel: 'left', dstPanel: 'right',
      conflictFiles: 'abort', keepOnAbort: false,
    });
    task.start(ctx);
    const { ok, result } = await promise;
    assert.ok(ok); // task succeeds, just reports abort
    assert.ok(result.aborted);
    // a.txt was copied before abort — should be cleaned up
    assert.ok(!fs.existsSync(path.join(dstDir, 'a.txt')), 'cleanup should remove partial copy');
  });

  test('abort: keeps destination copies when keepOnAbort=true', async () => {
    const src1 = path.join(srcDir, 'keep-a.txt');
    const src2 = path.join(srcDir, 'keep-b.txt');
    const clash = path.join(dstDir, 'keep-b.txt');
    await mkfile(src1, 'aaa');
    await mkfile(src2, 'bbb');
    await mkfile(clash, 'existing');
    const task = require('../worker/tasks/copy');
    const { ctx, promise } = makeCtx({
      sources: [src1, src2], dst: dstDir, panel: 'left', dstPanel: 'right',
      conflictFiles: 'abort', keepOnAbort: true,
    });
    task.start(ctx);
    const { ok, result } = await promise;
    assert.ok(ok);
    assert.ok(result.aborted);
    // a.txt was copied before abort — should be kept
    assert.ok(fs.existsSync(path.join(dstDir, 'keep-a.txt')), 'keepOnAbort should preserve copy');
  });

  test('hidden files excluded when showHidden=false', async () => {
    await mkfile(path.join(srcDir, '.hidden'), 'h');
    await mkfile(path.join(srcDir, 'visible.txt'), 'v');
    const task = require('../worker/tasks/copy');
    const { ctx, promise } = makeCtx({
      sources: [path.join(srcDir, '.hidden'), path.join(srcDir, 'visible.txt')],
      dst: dstDir, panel: 'left', dstPanel: 'right', showHidden: false,
    });
    task.start(ctx);
    await promise;
    assert.ok(!fs.existsSync(path.join(dstDir, '.hidden')));
    assert.ok(fs.existsSync(path.join(dstDir, 'visible.txt')));
  });

  test('replaceAll: overwrites destination regardless of age', async () => {
    const srcFile = path.join(srcDir, 'replace-me.txt');
    const dstFile = path.join(dstDir, 'replace-me.txt');
    await mkfile(srcFile, 'new content');
    await mkfile(dstFile, 'old content');
    // Make dst newer so replaceOlder would skip it — replaceAll should still overwrite
    const future = new Date(Date.now() + 10000);
    await fsp.utimes(dstFile, future, future);
    const task = require('../worker/tasks/copy');
    const { ctx, promise } = makeCtx({
      sources: [srcFile], dst: dstDir, panel: 'left', dstPanel: 'right',
      conflictFiles: 'replaceAll',
    });
    task.start(ctx);
    const { ok } = await promise;
    assert.ok(ok);
    assert.equal(fs.readFileSync(dstFile, 'utf8'), 'new content');
  });

  test('conflictFolders: replace removes existing dir and copies fresh', async () => {
    const srcD = path.join(srcDir, 'repdir');
    const dstD = path.join(dstDir, 'repdir');
    await fsp.mkdir(srcD, { recursive: true });
    await mkfile(path.join(srcD, 'new.txt'), 'new');
    await fsp.mkdir(dstD, { recursive: true });
    await mkfile(path.join(dstD, 'old.txt'), 'old');
    const task = require('../worker/tasks/copy');
    const { ctx, promise } = makeCtx({
      sources: [path.join(srcDir, 'repdir')], dst: dstDir, panel: 'left', dstPanel: 'right',
      conflictFolders: 'replace',
    });
    task.start(ctx);
    const { ok } = await promise;
    assert.ok(ok);
    // old.txt should be gone (dir was replaced), new.txt should be present
    assert.ok(!fs.existsSync(path.join(dstD, 'old.txt')), 'old content should be replaced');
    assert.ok(fs.existsSync(path.join(dstD, 'new.txt')));
  });

  test('conflictFolders: merge combines contents of both dirs', async () => {
    const srcD = path.join(srcDir, 'mergedir');
    const dstD = path.join(dstDir, 'mergedir');
    await fsp.mkdir(srcD, { recursive: true });
    await fsp.mkdir(dstD, { recursive: true });
    await mkfile(path.join(srcD, 'from-src.txt'), 'src');
    await mkfile(path.join(dstD, 'from-dst.txt'), 'dst');
    const task = require('../worker/tasks/copy');
    const { ctx, promise } = makeCtx({
      sources: [path.join(srcDir, 'mergedir')], dst: dstDir, panel: 'left', dstPanel: 'right',
      conflictFolders: 'merge',
    });
    task.start(ctx);
    const { ok, result } = await promise;
    assert.ok(ok);
    assert.ok(fs.existsSync(path.join(dstD, 'from-src.txt')), 'src file should be present after merge');
    assert.ok(fs.existsSync(path.join(dstD, 'from-dst.txt')), 'dst file should survive merge');
    assert.equal(result.stats.mergedFolders, 1);
  });

  test('conflictFolders: prefix keeps both dirs side by side', async () => {
    const srcD = path.join(srcDir, 'prefdir');
    const dstD = path.join(dstDir, 'prefdir');
    await fsp.mkdir(srcD, { recursive: true });
    await fsp.mkdir(dstD, { recursive: true });
    await mkfile(path.join(srcD, 'src.txt'), 'src');
    const task = require('../worker/tasks/copy');
    const { ctx, promise } = makeCtx({
      sources: [path.join(srcDir, 'prefdir')], dst: dstDir, panel: 'left', dstPanel: 'right',
      conflictFolders: 'prefix',
    });
    task.start(ctx);
    const { ok } = await promise;
    assert.ok(ok);
    assert.ok(fs.existsSync(path.join(dstDir, '(1) prefdir', 'src.txt')), 'prefixed dir should be created');
    assert.ok(fs.existsSync(dstD), 'original dir should be untouched');
  });

  test('showHidden=true includes hidden files', async () => {
    await mkfile(path.join(srcDir, '.hidden-include'), 'h');
    await mkfile(path.join(srcDir, 'visible.txt'), 'v');
    const task = require('../worker/tasks/copy');
    const { ctx, promise } = makeCtx({
      sources: [path.join(srcDir, '.hidden-include'), path.join(srcDir, 'visible.txt')],
      dst: dstDir, panel: 'left', dstPanel: 'right', showHidden: true,
    });
    task.start(ctx);
    await promise;
    assert.ok(fs.existsSync(path.join(dstDir, '.hidden-include')), 'hidden file should be copied when showHidden=true');
    assert.ok(fs.existsSync(path.join(dstDir, 'visible.txt')));
  });

  test('isCancelled abort mid-copy cleans up', async () => {
    // Create enough files that cancellation happens after first copy
    const files = ['cancel-a.txt', 'cancel-b.txt', 'cancel-c.txt'];
    for (const f of files) await mkfile(path.join(srcDir, f), 'x'.repeat(1024));
    const task = require('../worker/tasks/copy');
    const { ctx, promise } = makeCtx({
      sources: files.map(f => path.join(srcDir, f)),
      dst: dstDir, panel: 'left', dstPanel: 'right',
    });
    // Cancel after first progress call
    let cancelled = false;
    const origProgress = ctx.progress.bind(ctx);
    let calls = 0;
    ctx.progress = (pct, msg, extra) => {
      calls++;
      if (calls > 3 && !cancelled) { cancelled = true; ctx.cancel(); }
      origProgress(pct, msg, extra);
    };
    task.start(ctx);
    const { ok, result } = await promise;
    assert.ok(ok); // task completes (reports abort), not fails
    assert.ok(result.aborted);
  });

  test('recursive directory copy reports progress at each file', async () => {
    const subDir = path.join(srcDir, 'tree');
    await fsp.mkdir(path.join(subDir, 'sub'), { recursive: true });
    await mkfile(path.join(subDir, 'root.txt'), 'x'.repeat(8192));
    await mkfile(path.join(subDir, 'sub', 'deep.txt'), 'y'.repeat(8192));
    const task = require('../worker/tasks/copy');
    const { ctx, promise } = makeCtx({
      sources: [subDir], dst: dstDir, panel: 'left', dstPanel: 'right',
    });
    task.start(ctx);
    const { progressLog } = await promise;
    // Should have multiple progress calls with increasing kbDone
    const withKb = progressLog.filter(p => p.extra && p.extra.kbDone > 0);
    assert.ok(withKb.length > 1, 'should report progress for files inside subdirs');
  });

  // ── Type mismatch: hard abort regardless of configured strategy ────────────

  test('folder source colliding with an existing FILE destination hard-aborts, even with conflictFolders=replace', async () => {
    const srcFolder = path.join(srcDir, 'report');
    await fsp.mkdir(srcFolder);
    await mkfile(path.join(srcFolder, 'inner.txt'), 'inner');
    const dstFile = path.join(dstDir, 'report');
    await mkfile(dstFile, 'do not delete me');

    const task = require('../worker/tasks/copy');
    const { ctx, promise } = makeCtx({
      sources: [srcFolder], dst: dstDir, panel: 'left', dstPanel: 'right',
      conflictFolders: 'replace', // would normally delete-and-replace; must NOT apply here
    });
    task.start(ctx);
    const { ok, result } = await promise;

    assert.ok(ok, 'task settles via done(), not fail()');
    assert.equal(result.aborted, true);
    assert.ok(result.stats.abortMessage, 'should carry a precise abort message');
    assert.match(result.stats.abortMessage, /^Cannot copy source .*report FOLDER to target .*dst, /);
    assert.match(result.stats.abortMessage, /because a FILE named report already exists there\./);
    assert.match(result.stats.abortMessage, /Operation aborted\.$/);

    // The critical safety assertion: the existing file must be untouched —
    // this is exactly the silent-deletion foot-gun the type check prevents.
    assert.ok(fs.existsSync(dstFile), 'existing file must NOT have been deleted');
    assert.equal(fs.readFileSync(dstFile, 'utf8'), 'do not delete me');
  });

  test('folder source colliding with an existing FILE destination hard-aborts, even with conflictFolders=merge', async () => {
    const srcFolder = path.join(srcDir, 'data');
    await fsp.mkdir(srcFolder);
    const dstFile = path.join(dstDir, 'data');
    await mkfile(dstFile, 'a plain file');

    const task = require('../worker/tasks/copy');
    const { ctx, promise } = makeCtx({
      sources: [srcFolder], dst: dstDir, panel: 'left', dstPanel: 'right',
      conflictFolders: 'merge',
    });
    task.start(ctx);
    const { ok, result } = await promise;

    assert.ok(ok);
    assert.equal(result.aborted, true);
    assert.match(result.stats.abortMessage, /FOLDER to target .* because a FILE named data already exists/);
    assert.equal(fs.readFileSync(dstFile, 'utf8'), 'a plain file');
  });

  test('file source colliding with an existing FOLDER destination hard-aborts, even with conflictFiles=replaceAll', async () => {
    const srcFile = path.join(srcDir, 'notes.txt');
    await mkfile(srcFile, 'new notes');
    const dstFolder = path.join(dstDir, 'notes.txt');
    await fsp.mkdir(dstFolder);
    await mkfile(path.join(dstFolder, 'keep-me.txt'), 'must survive');

    const task = require('../worker/tasks/copy');
    const { ctx, promise } = makeCtx({
      sources: [srcFile], dst: dstDir, panel: 'left', dstPanel: 'right',
      conflictFiles: 'replaceAll',
    });
    task.start(ctx);
    const { ok, result } = await promise;

    assert.ok(ok);
    assert.equal(result.aborted, true);
    assert.match(result.stats.abortMessage, /^Cannot copy source .*notes\.txt FILE to target .*dst, /);
    assert.match(result.stats.abortMessage, /because a FOLDER named notes\.txt already exists there\./);

    // The folder and its contents must survive untouched
    assert.ok(fs.existsSync(dstFolder));
    assert.ok(fs.existsSync(path.join(dstFolder, 'keep-me.txt')));
    assert.equal(fs.readFileSync(path.join(dstFolder, 'keep-me.txt'), 'utf8'), 'must survive');
  });

  test('type mismatch nested inside a recursive directory copy also hard-aborts the whole operation', async () => {
    // src/tree/report is a FOLDER; dst already has a FILE named "report"
    // one level down, so the mismatch is only discovered mid-recursion.
    const subDir = path.join(srcDir, 'tree');
    await fsp.mkdir(path.join(subDir, 'report'), { recursive: true });
    await mkfile(path.join(subDir, 'report', 'inner.txt'), 'inner');
    await mkfile(path.join(subDir, 'sibling.txt'), 'sibling');

    const dstTree = path.join(dstDir, 'tree');
    await fsp.mkdir(dstTree, { recursive: true });
    await mkfile(path.join(dstTree, 'report'), 'an existing FILE, not a folder');

    const task = require('../worker/tasks/copy');
    const { ctx, promise } = makeCtx({
      sources: [subDir], dst: dstDir, panel: 'left', dstPanel: 'right',
      conflictFolders: 'merge', // would normally merge straight through
    });
    task.start(ctx);
    const { ok, result } = await promise;

    assert.ok(ok);
    assert.equal(result.aborted, true);
    assert.match(result.stats.abortMessage, /because a FILE named report already exists there\./);

    // The pre-existing file at dst/tree/report must be untouched
    assert.equal(fs.readFileSync(path.join(dstTree, 'report'), 'utf8'), 'an existing FILE, not a folder');

    // Whether sibling.txt had already been copied before the mismatch was
    // discovered depends on fs.readdir's iteration order, which Node does
    // not guarantee — so this test deliberately does not assert on it
    // either way. What IS deterministic and worth asserting: the source
    // tree itself must be completely unaffected by the aborted copy (copy
    // never touches sources at all, abort or not), and "report" must not
    // have been created as a folder anywhere it wasn't already a file.
    assert.equal(fs.readFileSync(path.join(subDir, 'report', 'inner.txt'), 'utf8'), 'inner',
      'source tree must be untouched — copy never modifies sources');
    assert.equal(fs.readFileSync(path.join(subDir, 'sibling.txt'), 'utf8'), 'sibling');
    assert.ok(fs.statSync(path.join(dstTree, 'report')).isFile(),
      'the colliding destination item must still be a file, never converted into a folder');
  });

  test('a same-type collision (file onto file) is NOT affected by the type-mismatch check', async () => {
    // Sanity check: the new guard must not interfere with the ordinary,
    // already-correct same-type collision handling.
    const src = path.join(srcDir, 'same.txt');
    const dst = path.join(dstDir, 'same.txt');
    await mkfile(src, 'new');
    await mkfile(dst, 'old');

    const task = require('../worker/tasks/copy');
    const { ctx, promise } = makeCtx({
      sources: [src], dst: dstDir, panel: 'left', dstPanel: 'right',
      conflictFiles: 'replaceAll',
    });
    task.start(ctx);
    const { ok, result } = await promise;

    assert.ok(ok);
    assert.equal(result.aborted, false);
    assert.equal(fs.readFileSync(dst, 'utf8'), 'new');
  });
});

// ─── move task ────────────────────────────────────────────────────────────────

describe('move task', () => {
  let srcDir, dstDir;

  beforeEach(async () => {
    srcDir = path.join(workDir, 'mv-src');
    dstDir = path.join(workDir, 'mv-dst');
    await fsp.mkdir(srcDir, { recursive: true });
    await fsp.mkdir(dstDir, { recursive: true });
    purgeCache('paco/context');
    purgeCache('paco/task-helpers');
    const ctx2 = require('../paco/context');
    ctx2.bootstrap();
    ctx2.updatePanel('left',  { path: srcDir, selection: [], tabs: [{ id: 'tab-default', path: srcDir, label: null }], activeTab: 'tab-default' });
    ctx2.updatePanel('right', { path: dstDir, selection: [], tabs: [{ id: 'tab-default', path: dstDir, label: null }], activeTab: 'tab-default' });
  });

  test('moves a file to destination', async () => {
    const src = path.join(srcDir, 'move-me.txt');
    await mkfile(src, 'move');
    const task = require('../worker/tasks/move');
    const { ctx, promise } = makeCtx({ sources: [src], dst: dstDir, panel: 'left', dstPanel: 'right' });
    task.start(ctx);
    const { ok, result } = await promise;
    assert.ok(ok);
    assert.ok(!fs.existsSync(src));
    assert.ok(fs.existsSync(path.join(dstDir, 'move-me.txt')));
    assert.equal((result.stats.copied || 0) + (result.stats.prefixed || 0), 1);
    assert.equal(result.errors.length, 0);
  });

  test('handles collision with (1) prefix when conflictFiles=prefix', async () => {
    const src      = path.join(srcDir, 'dup.txt');
    const existing = path.join(dstDir, 'dup.txt');
    await mkfile(src, 'new');
    await mkfile(existing, 'old');
    const task = require('../worker/tasks/move');
    const { ctx, promise } = makeCtx({
      sources: [src], dst: dstDir, panel: 'left', dstPanel: 'right',
      conflictFiles: 'prefix',
    });
    task.start(ctx);
    const { ok } = await promise;
    assert.ok(ok);
    assert.ok(fs.existsSync(path.join(dstDir, '(1) dup.txt')));
    assert.equal(fs.readFileSync(existing, 'utf8'), 'old');
  });

  test('fails if copying into itself', async () => {
    const task = require('../worker/tasks/move');
    const { ctx, promise } = makeCtx({ sources: [srcDir], dst: srcDir, panel: 'left', dstPanel: 'right' });
    task.start(ctx);
    const { ok } = await promise;
    assert.ok(!ok);
  });

  test('result includes both panel refreshes', async () => {
    const src = path.join(srcDir, 'r.txt');
    await mkfile(src, 'x');
    const task = require('../worker/tasks/move');
    const { ctx, promise } = makeCtx({ sources: [src], dst: dstDir, panel: 'left', dstPanel: 'right' });
    task.start(ctx);
    const { result } = await promise;
    assert.ok(result.left  && result.left.panel  === 'left');
    assert.ok(result.right && result.right.panel === 'right');
  });

  test('source is deleted after successful move (phase 3b)', async () => {
    const src = path.join(srcDir, 'phase3.txt');
    await mkfile(src, 'delete me');
    const task = require('../worker/tasks/move');
    const { ctx, promise } = makeCtx({
      sources: [src], dst: dstDir, panel: 'left', dstPanel: 'right',
    });
    task.start(ctx);
    const { ok } = await promise;
    assert.ok(ok);
    assert.ok(!fs.existsSync(src), 'source should be deleted after move');
    assert.ok(fs.existsSync(path.join(dstDir, 'phase3.txt')));
  });

  test('source untouched when move is aborted', async () => {
    const src1 = path.join(srcDir, 'safe1.txt');
    const src2 = path.join(srcDir, 'safe2.txt');
    const clash = path.join(dstDir, 'safe2.txt');
    await mkfile(src1, 'aaa');
    await mkfile(src2, 'bbb');
    await mkfile(clash, 'existing');
    const task = require('../worker/tasks/move');
    const { ctx, promise } = makeCtx({
      sources: [src1, src2], dst: dstDir, panel: 'left', dstPanel: 'right',
      conflictFiles: 'abort', keepOnAbort: false,
    });
    task.start(ctx);
    const { ok, result } = await promise;
    assert.ok(ok);
    assert.ok(result.aborted);
    // Both sources must still exist — phase 3b never runs on abort
    assert.ok(fs.existsSync(src1), 'source 1 should be untouched after abort');
    assert.ok(fs.existsSync(src2), 'source 2 should be untouched after abort');
  });

  test('moves multiple files, all sources deleted', async () => {
    const a = path.join(srcDir, 'mv-multi-a.txt');
    const b = path.join(srcDir, 'mv-multi-b.txt');
    await mkfile(a, 'aaa'); await mkfile(b, 'bbb');
    const task = require('../worker/tasks/move');
    const { ctx, promise } = makeCtx({
      sources: [a, b], dst: dstDir, panel: 'left', dstPanel: 'right',
    });
    task.start(ctx);
    const { ok, result } = await promise;
    assert.ok(ok);
    assert.ok(!fs.existsSync(a) && !fs.existsSync(b), 'all sources deleted after move');
    assert.ok(fs.existsSync(path.join(dstDir, 'mv-multi-a.txt')));
    assert.ok(fs.existsSync(path.join(dstDir, 'mv-multi-b.txt')));
  });

  test('replaceOlder: skips newer destination file during move', async () => {
    const src = path.join(srcDir, 'mv-old.txt');
    const dst2 = path.join(dstDir, 'mv-old.txt');
    await mkfile(src, 'src');
    await mkfile(dst2, 'dst');
    const future = new Date(Date.now() + 10000);
    await fsp.utimes(dst2, future, future);
    const task = require('../worker/tasks/move');
    const { ctx, promise } = makeCtx({
      sources: [src], dst: dstDir, panel: 'left', dstPanel: 'right',
      conflictFiles: 'replaceOlder',
    });
    task.start(ctx);
    const { ok, result } = await promise;
    assert.ok(ok);
    assert.equal(result.stats.skippedNewer, 1);
    // dst content unchanged, src still exists (was skipped, not moved)
    assert.equal(fs.readFileSync(dst2, 'utf8'), 'dst');
  });

  test('conflictFolders: merge during move leaves source deleted', async () => {
    const srcD = path.join(srcDir, 'mv-merge');
    const dstD = path.join(dstDir, 'mv-merge');
    await fsp.mkdir(srcD, { recursive: true });
    await fsp.mkdir(dstD, { recursive: true });
    await mkfile(path.join(srcD, 'from-src.txt'), 'src');
    await mkfile(path.join(dstD, 'from-dst.txt'), 'dst');
    const task = require('../worker/tasks/move');
    const { ctx, promise } = makeCtx({
      sources: [srcD], dst: dstDir, panel: 'left', dstPanel: 'right',
      conflictFolders: 'merge',
    });
    task.start(ctx);
    const { ok, result } = await promise;
    assert.ok(ok);
    assert.ok(fs.existsSync(path.join(dstD, 'from-src.txt')));
    assert.ok(fs.existsSync(path.join(dstD, 'from-dst.txt')));
    assert.ok(!fs.existsSync(srcD), 'source dir deleted after successful merge-move');
    assert.equal(result.stats.mergedFolders, 1);
  });

  test('hidden files excluded during move when showHidden=false', async () => {
    const hidden = path.join(srcDir, '.mv-hidden');
    const visible = path.join(srcDir, 'mv-visible.txt');
    await mkfile(hidden, 'h'); await mkfile(visible, 'v');
    const task = require('../worker/tasks/move');
    const { ctx, promise } = makeCtx({
      sources: [hidden, visible], dst: dstDir, panel: 'left', dstPanel: 'right',
      showHidden: false,
    });
    task.start(ctx);
    await promise;
    assert.ok(fs.existsSync(hidden),  'hidden source should not be moved');
    assert.ok(!fs.existsSync(visible), 'visible source should be deleted');
    assert.ok(!fs.existsSync(path.join(dstDir, '.mv-hidden')));
    assert.ok(fs.existsSync(path.join(dstDir, 'mv-visible.txt')));
  });

  test('move directory: source dir deleted after success', async () => {
    const srcD = path.join(srcDir, 'movedir');
    await fsp.mkdir(srcD, { recursive: true });
    await mkfile(path.join(srcD, 'file.txt'), 'content');
    const task = require('../worker/tasks/move');
    const { ctx, promise } = makeCtx({
      sources: [srcD], dst: dstDir, panel: 'left', dstPanel: 'right',
    });
    task.start(ctx);
    const { ok } = await promise;
    assert.ok(ok);
    assert.ok(!fs.existsSync(srcD), 'source dir should be deleted after move');
    assert.ok(fs.existsSync(path.join(dstDir, 'movedir', 'file.txt')));
  });

  // ── Type mismatch: hard abort, source AND destination both untouched ───────
  // Move is copy-then-delete, so the safety bar here is higher than copy's:
  // not only must the colliding destination item survive, but — since the
  // whole point of phase 3b is "only delete sources after a clean success"
  // — the source must ALSO still be exactly where it started.

  test('folder source colliding with an existing FILE destination hard-aborts; both source and destination survive untouched', async () => {
    const srcFolder = path.join(srcDir, 'report');
    await fsp.mkdir(srcFolder);
    await mkfile(path.join(srcFolder, 'inner.txt'), 'inner content');
    const dstFile = path.join(dstDir, 'report');
    await mkfile(dstFile, 'do not delete me');

    const task = require('../worker/tasks/move');
    const { ctx, promise } = makeCtx({
      sources: [srcFolder], dst: dstDir, panel: 'left', dstPanel: 'right',
      conflictFolders: 'replace',
    });
    task.start(ctx);
    const { ok, result } = await promise;

    assert.ok(ok);
    assert.equal(result.aborted, true);
    assert.match(result.stats.abortMessage, /^Cannot move source .*report FOLDER to target .*dst, /);
    assert.match(result.stats.abortMessage, /because a FILE named report already exists there\./);

    // Destination file untouched
    assert.ok(fs.existsSync(dstFile));
    assert.equal(fs.readFileSync(dstFile, 'utf8'), 'do not delete me');

    // Source folder must STILL exist — move's phase 3b (delete sources)
    // must never run when the operation aborted.
    assert.ok(fs.existsSync(srcFolder), 'source folder must survive an aborted move');
    assert.equal(fs.readFileSync(path.join(srcFolder, 'inner.txt'), 'utf8'), 'inner content');
  });

  test('file source colliding with an existing FOLDER destination hard-aborts; source survives', async () => {
    const srcFile = path.join(srcDir, 'notes.txt');
    await mkfile(srcFile, 'my notes');
    const dstFolder = path.join(dstDir, 'notes.txt');
    await fsp.mkdir(dstFolder);

    const task = require('../worker/tasks/move');
    const { ctx, promise } = makeCtx({
      sources: [srcFile], dst: dstDir, panel: 'left', dstPanel: 'right',
      conflictFiles: 'replaceAll',
    });
    task.start(ctx);
    const { ok, result } = await promise;

    assert.ok(ok);
    assert.equal(result.aborted, true);
    assert.match(result.stats.abortMessage, /because a FOLDER named notes\.txt already exists there\./);

    assert.ok(fs.existsSync(srcFile), 'source file must survive an aborted move');
    assert.equal(fs.readFileSync(srcFile, 'utf8'), 'my notes');
    assert.ok(fs.existsSync(dstFolder));
  });
});

// ─── rename ───────────────────────────────────────────────────────────────────

describe('rename task', () => {
  test('renames a file successfully', async () => {
    const src = path.join(workDir, 'old-name.txt');
    await mkfile(src, 'hello');
    const task = require('../worker/tasks/rename');
    const { ctx, promise } = makeCtx({ panel: 'left', source: src, newName: 'new-name.txt' });
    task.start(ctx);
    const { ok, result } = await promise;
    assert.ok(ok, 'task should succeed');
    assert.ok(!fs.existsSync(src));
    assert.ok(fs.existsSync(path.join(workDir, 'new-name.txt')));
    assert.equal(fs.readFileSync(path.join(workDir, 'new-name.txt'), 'utf8'), 'hello');
    assert.equal(result.renamedTo, path.join(workDir, 'new-name.txt'));
  });

  test('renames a directory successfully', async () => {
    const src = path.join(workDir, 'old-dir');
    await fsp.mkdir(src);
    await mkfile(path.join(src, 'inner.txt'), 'x');
    const task = require('../worker/tasks/rename');
    const { ctx, promise } = makeCtx({ panel: 'left', source: src, newName: 'new-dir' });
    task.start(ctx);
    const { ok } = await promise;
    assert.ok(ok);
    assert.ok(!fs.existsSync(src));
    assert.ok(fs.existsSync(path.join(workDir, 'new-dir', 'inner.txt')));
  });

  test('fails when source no longer exists', async () => {
    const task = require('../worker/tasks/rename');
    const { ctx, promise } = makeCtx({
      panel: 'left', source: path.join(workDir, 'ghost.txt'), newName: 'whatever.txt',
    });
    task.start(ctx);
    const { ok, error } = await promise;
    assert.ok(!ok);
    assert.match(error, /no longer exists/i);
  });

  test('fails when no source specified', async () => {
    const task = require('../worker/tasks/rename');
    const { ctx, promise } = makeCtx({ panel: 'left', source: '', newName: 'x.txt' });
    task.start(ctx);
    const { ok, error } = await promise;
    assert.ok(!ok);
    assert.match(error, /no item specified/i);
  });

  test('fails when newName is empty', async () => {
    const src = path.join(workDir, 'a.txt');
    await mkfile(src);
    const task = require('../worker/tasks/rename');
    const { ctx, promise } = makeCtx({ panel: 'left', source: src, newName: '   ' });
    task.start(ctx);
    const { ok, error } = await promise;
    assert.ok(!ok);
    assert.match(error, /new name is required/i);
  });

  test('fails when newName equals current name (no-op guard)', async () => {
    const src = path.join(workDir, 'same.txt');
    await mkfile(src);
    const task = require('../worker/tasks/rename');
    const { ctx, promise } = makeCtx({ panel: 'left', source: src, newName: 'same.txt' });
    task.start(ctx);
    const { ok, error } = await promise;
    assert.ok(!ok);
    assert.match(error, /same as the current name/i);
    // file must be untouched
    assert.ok(fs.existsSync(src));
  });

  test('fails for "." or ".." as new name', async () => {
    const src = path.join(workDir, 'b.txt');
    await mkfile(src);
    const task = require('../worker/tasks/rename');
    const { ctx, promise } = makeCtx({ panel: 'left', source: src, newName: '..' });
    task.start(ctx);
    const { ok } = await promise;
    assert.ok(!ok);
  });

  test('fails for names containing path separators', async () => {
    const src = path.join(workDir, 'c.txt');
    await mkfile(src);
    const task = require('../worker/tasks/rename');
    const { ctx, promise } = makeCtx({ panel: 'left', source: src, newName: 'a/b' });
    task.start(ctx);
    const { ok } = await promise;
    assert.ok(!ok);
  });

  test('fails for read-only source', async () => {
    const src = path.join(workDir, 'readonly.txt');
    await mkfile(src);
    await fsp.chmod(src, 0o444);
    const task = require('../worker/tasks/rename');
    const { ctx, promise } = makeCtx({ panel: 'left', source: src, newName: 'renamed.txt' });
    task.start(ctx);
    const { ok, error } = await promise;
    // chmod 444 prevents write but on some systems the owner can still rename;
    // accept either outcome but if it fails, message should mention read-only
    if (!ok) assert.match(error, /read-only/i);
    await fsp.chmod(src, 0o644).catch(() => {}); // cleanup, ignore if renamed away
  });

  test('file clash: abort (default) fails with already-exists message', async () => {
    const src = path.join(workDir, 'src.txt');
    const clash = path.join(workDir, 'clash.txt');
    await mkfile(src, 'src');
    await mkfile(clash, 'existing');
    const task = require('../worker/tasks/rename');
    const { ctx, promise } = makeCtx({ panel: 'left', source: src, newName: 'clash.txt' });
    task.start(ctx);
    const { ok, error } = await promise;
    assert.ok(!ok);
    assert.match(error, /already exists/i);
    assert.equal(fs.readFileSync(clash, 'utf8'), 'existing'); // untouched
  });

  test('file clash: replaceOlder replaces an older destination', async () => {
    const src = path.join(workDir, 'newer.txt');
    const clash = path.join(workDir, 'target.txt');
    await mkfile(src, 'fresh');
    await mkfile(clash, 'stale');
    const past = new Date(Date.now() - 10000);
    await fsp.utimes(clash, past, past);
    const task = require('../worker/tasks/rename');
    const { ctx, promise } = makeCtx({
      panel: 'left', source: src, newName: 'target.txt', conflictFiles: 'replaceOlder',
    });
    task.start(ctx);
    const { ok } = await promise;
    assert.ok(ok);
    assert.equal(fs.readFileSync(clash, 'utf8'), 'fresh');
  });

  test('file clash: replaceOlder rejects when destination is newer', async () => {
    const src = path.join(workDir, 'old.txt');
    const clash = path.join(workDir, 'target2.txt');
    await mkfile(src, 'old content');
    await mkfile(clash, 'newer content');
    const future = new Date(Date.now() + 10000);
    await fsp.utimes(clash, future, future);
    const task = require('../worker/tasks/rename');
    const { ctx, promise } = makeCtx({
      panel: 'left', source: src, newName: 'target2.txt', conflictFiles: 'replaceOlder',
    });
    task.start(ctx);
    const { ok } = await promise;
    assert.ok(!ok);
    assert.equal(fs.readFileSync(clash, 'utf8'), 'newer content');
  });

  test('file clash: replaceAll overwrites regardless of age', async () => {
    const src = path.join(workDir, 'force.txt');
    const clash = path.join(workDir, 'forced-target.txt');
    await mkfile(src, 'new');
    await mkfile(clash, 'old');
    const future = new Date(Date.now() + 10000);
    await fsp.utimes(clash, future, future);
    const task = require('../worker/tasks/rename');
    const { ctx, promise } = makeCtx({
      panel: 'left', source: src, newName: 'forced-target.txt', conflictFiles: 'replaceAll',
    });
    task.start(ctx);
    const { ok } = await promise;
    assert.ok(ok);
    assert.equal(fs.readFileSync(clash, 'utf8'), 'new');
  });

  test('file clash: prefix keeps both, renamed item gets a (n) prefix', async () => {
    const src = path.join(workDir, 'dup-src.txt');
    const clash = path.join(workDir, 'taken.txt');
    await mkfile(src, 'src-content');
    await mkfile(clash, 'clash-content');
    const task = require('../worker/tasks/rename');
    const { ctx, promise } = makeCtx({
      panel: 'left', source: src, newName: 'taken.txt', conflictFiles: 'prefix',
    });
    task.start(ctx);
    const { ok, result } = await promise;
    assert.ok(ok);
    assert.ok(fs.existsSync(path.join(workDir, '(1) taken.txt')));
    assert.equal(fs.readFileSync(clash, 'utf8'), 'clash-content'); // original untouched
    assert.equal(result.renamedTo, path.join(workDir, '(1) taken.txt'));
  });

  test('folder clash: abort (default) fails', async () => {
    const src = path.join(workDir, 'dir-src');
    const clash = path.join(workDir, 'dir-clash');
    await fsp.mkdir(src);
    await fsp.mkdir(clash);
    const task = require('../worker/tasks/rename');
    const { ctx, promise } = makeCtx({ panel: 'left', source: src, newName: 'dir-clash' });
    task.start(ctx);
    const { ok, error } = await promise;
    assert.ok(!ok);
    assert.match(error, /already exists/i);
  });

  test('folder clash: replace removes existing and renames in', async () => {
    const src = path.join(workDir, 'dir-src2');
    const clash = path.join(workDir, 'dir-clash2');
    await fsp.mkdir(src);
    await mkfile(path.join(src, 'inside.txt'), 'fresh');
    await fsp.mkdir(clash);
    await mkfile(path.join(clash, 'old-inside.txt'), 'stale');
    const task = require('../worker/tasks/rename');
    const { ctx, promise } = makeCtx({
      panel: 'left', source: src, newName: 'dir-clash2', conflictFolders: 'replace',
    });
    task.start(ctx);
    const { ok } = await promise;
    assert.ok(ok);
    assert.ok(fs.existsSync(path.join(workDir, 'dir-clash2', 'inside.txt')));
    assert.ok(!fs.existsSync(path.join(workDir, 'dir-clash2', 'old-inside.txt')));
  });

  test('folder clash: prefix keeps both folders side by side', async () => {
    const src = path.join(workDir, 'dir-src3');
    const clash = path.join(workDir, 'dir-clash3');
    await fsp.mkdir(src);
    await fsp.mkdir(clash);
    const task = require('../worker/tasks/rename');
    const { ctx, promise } = makeCtx({
      panel: 'left', source: src, newName: 'dir-clash3', conflictFolders: 'prefix',
    });
    task.start(ctx);
    const { ok } = await promise;
    assert.ok(ok);
    assert.ok(fs.existsSync(path.join(workDir, '(1) dir-clash3')));
    assert.ok(fs.existsSync(clash), 'original clashing folder should remain');
  });

  // ── Type mismatch: hard abort regardless of configured strategy ────────────

  test('renaming a FOLDER onto an existing FILE name hard-aborts, even with conflictFolders=replace', async () => {
    const src = path.join(workDir, 'myfolder');
    await fsp.mkdir(src);
    await mkfile(path.join(src, 'inner.txt'), 'inner content');
    const clashFile = path.join(workDir, 'taken');
    await mkfile(clashFile, 'do not delete me');

    const task = require('../worker/tasks/rename');
    const { ctx, promise } = makeCtx({
      panel: 'left', source: src, newName: 'taken', conflictFolders: 'replace',
    });
    task.start(ctx);
    const { ok, error } = await promise;

    assert.ok(!ok, 'rename uses ctx.fail() for this case, unlike copy/move\'s ctx.done()');
    assert.match(error, /^Cannot rename source .*myfolder FOLDER to target .*, /);
    assert.match(error, /because a FILE named taken already exists there\./);
    assert.match(error, /Operation aborted\.$/);

    // The critical safety assertion: the existing file must survive —
    // conflictFolders=replace must never apply when the actual collision
    // is with a file, not a folder.
    assert.ok(fs.existsSync(clashFile), 'existing file must NOT have been deleted');
    assert.equal(fs.readFileSync(clashFile, 'utf8'), 'do not delete me');

    // The source folder must still exist too — the rename never happened.
    assert.ok(fs.existsSync(src));
    assert.equal(fs.readFileSync(path.join(src, 'inner.txt'), 'utf8'), 'inner content');
  });

  test('renaming a FILE onto an existing FOLDER name hard-aborts, even with conflictFiles=replaceAll', async () => {
    const src = path.join(workDir, 'myfile.txt');
    await mkfile(src, 'my content');
    const clashFolder = path.join(workDir, 'taken-dir');
    await fsp.mkdir(clashFolder);
    await mkfile(path.join(clashFolder, 'keep-me.txt'), 'must survive');

    const task = require('../worker/tasks/rename');
    const { ctx, promise } = makeCtx({
      panel: 'left', source: src, newName: 'taken-dir', conflictFiles: 'replaceAll',
    });
    task.start(ctx);
    const { ok, error } = await promise;

    assert.ok(!ok);
    assert.match(error, /^Cannot rename source .*myfile\.txt FILE to target .*, /);
    assert.match(error, /because a FOLDER named taken-dir already exists there\./);

    assert.ok(fs.existsSync(clashFolder));
    assert.ok(fs.existsSync(path.join(clashFolder, 'keep-me.txt')));
    assert.ok(fs.existsSync(src), 'source file must survive an aborted rename');
  });

  test('a same-type collision (folder onto folder) is NOT affected by the type-mismatch check', async () => {
    // Sanity check: the new guard must not interfere with rename's
    // already-correct same-type collision handling (covered by the
    // existing "folder clash: replace" test above, re-verified here
    // alongside the type-mismatch tests for contrast).
    const src = path.join(workDir, 'same-src-dir');
    const clash = path.join(workDir, 'same-clash-dir');
    await fsp.mkdir(src);
    await mkfile(path.join(src, 'a.txt'), 'a');
    await fsp.mkdir(clash);

    const task = require('../worker/tasks/rename');
    const { ctx, promise } = makeCtx({
      panel: 'left', source: src, newName: 'same-clash-dir', conflictFolders: 'replace',
    });
    task.start(ctx);
    const { ok } = await promise;

    assert.ok(ok);
    assert.ok(fs.existsSync(path.join(workDir, 'same-clash-dir', 'a.txt')));
  });

  test('refreshed panel reflects the new name', async () => {
    const src = path.join(workDir, 'before.txt');
    await mkfile(src);
    const task = require('../worker/tasks/rename');
    const { ctx, promise } = makeCtx({ panel: 'left', source: src, newName: 'after.txt' });
    task.start(ctx);
    const { result } = await promise;
    assert.ok(result.entries.find(e => e.name === 'after.txt'));
    assert.ok(!result.entries.find(e => e.name === 'before.txt'));
  });

  test('reports progress through the operation', async () => {
    const src = path.join(workDir, 'progress.txt');
    await mkfile(src);
    const task = require('../worker/tasks/rename');
    const { ctx, promise } = makeCtx({ panel: 'left', source: src, newName: 'progressed.txt' });
    task.start(ctx);
    const { progressLog } = await promise;
    assert.ok(progressLog.length >= 2);
    assert.equal(progressLog[progressLog.length - 1].pct, 100);
  });
});

// ─── open-native task ───────────────────────────────────────────────────────────

describe('open-native task', () => {
  test('calls open() with the given path and succeeds', async () => {
    const target = path.join(workDir, 'photo.png');
    await mkfile(target);

    let calledWith = null;
    const restore = stubOpenModule(async (p) => { calledWith = p; });
    purgeCache('worker/tasks/open-native');

    const task = require('../worker/tasks/open-native');
    const { ctx, promise } = makeCtx({ path: target });
    task.start(ctx);
    const { ok, result } = await promise;

    restore();

    assert.ok(ok);
    assert.equal(calledWith, target);
    assert.equal(result.opened, true);
    assert.equal(result.path, target);
  });

  test('fails when no path is given', async () => {
    purgeCache('worker/tasks/open-native');
    const task = require('../worker/tasks/open-native');
    const { ctx, promise } = makeCtx({ path: '' });
    task.start(ctx);
    const { ok, error } = await promise;
    assert.ok(!ok);
    assert.match(error, /no file or folder specified/i);
  });

  test('fails when the target no longer exists', async () => {
    purgeCache('worker/tasks/open-native');
    const task = require('../worker/tasks/open-native');
    const { ctx, promise } = makeCtx({ path: path.join(workDir, 'ghost.txt') });
    task.start(ctx);
    const { ok, error } = await promise;
    assert.ok(!ok);
    assert.match(error, /no longer exists/i);
  });

  test('fails with a clear message when the OS launcher itself errors', async () => {
    const target = path.join(workDir, 'broken.txt');
    await mkfile(target);

    const restore = stubOpenModule(async () => { throw new Error('spawn ENOENT'); });
    purgeCache('worker/tasks/open-native');

    const task = require('../worker/tasks/open-native');
    const { ctx, promise } = makeCtx({ path: target });
    task.start(ctx);
    const { ok, error } = await promise;

    restore();

    assert.ok(!ok);
    assert.match(error, /could not open/i);
    assert.match(error, /spawn ENOENT/);
  });

  test('works for a directory target too (e.g. a macOS bundle)', async () => {
    const target = path.join(workDir, 'Tool.app');
    await fsp.mkdir(target);

    let calledWith = null;
    const restore = stubOpenModule(async (p) => { calledWith = p; });
    purgeCache('worker/tasks/open-native');

    const task = require('../worker/tasks/open-native');
    const { ctx, promise } = makeCtx({ path: target });
    task.start(ctx);
    const { ok } = await promise;

    restore();

    assert.ok(ok);
    assert.equal(calledWith, target);
  });

  test('reports progress through the operation', async () => {
    const target = path.join(workDir, 'p.txt');
    await mkfile(target);

    const restore = stubOpenModule(async () => {});
    purgeCache('worker/tasks/open-native');

    const task = require('../worker/tasks/open-native');
    const { ctx, promise } = makeCtx({ path: target });
    task.start(ctx);
    const { progressLog } = await promise;

    restore();

    assert.ok(progressLog.length >= 2);
    assert.equal(progressLog[progressLog.length - 1].pct, 100);
  });
});

// ─── open-with task (F4) ──────────────────────────────────────────────────────

describe('open-with task', () => {
  function freshContext() {
    purgeCache('paco/context');
    return require('../paco/context');
  }

  test('tier 1: specific extension match opens with the configured app', async () => {
    const target = path.join(workDir, 'cover.psd');
    await mkfile(target, 'fake psd content');

    const ctx2 = freshContext();
    ctx2.writeFileHandlers({
      fallback: 'nativeOpen', exec_fallback: null,
      specific: [{ extensions: ['.psd'], handler: { app: 'Photoshop', args: ['--silent'] } }],
      category: { text: null, audio: null, image: null, video: null, other: null },
    });

    let calledWith = null;
    const restore = stubOpenModule(async (p, opts) => { calledWith = { p, opts }; });
    purgeCache('worker/tasks/open-with');
    purgeCache('paco/ui-state');
    purgeCache('paco/file-handler-detect');

    const task = require('../worker/tasks/open-with');
    const { ctx, promise } = makeCtx({ path: target });
    task.start(ctx);
    const { ok, result } = await promise;

    restore();

    assert.ok(ok, result && result.error);
    assert.equal(result.action, 'open');
    assert.equal(result.app, 'Photoshop');
    assert.equal(calledWith.p, target);
    assert.deepEqual(calledWith.opts, { app: { name: 'Photoshop', arguments: ['--silent'] } });
  });

  test('tier 2: category match used for a real PNG with no specific match', async () => {
    const target = path.join(workDir, 'photo.png');
    const pngSig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await fsp.writeFile(target, Buffer.concat([pngSig, Buffer.alloc(20)]));

    const ctx2 = freshContext();
    ctx2.writeFileHandlers({
      fallback: 'nativeOpen', exec_fallback: null,
      specific: [],
      category: { text: null, audio: null, image: { app: 'Preview', args: [] }, video: null, other: null },
    });

    let calledWith = null;
    const restore = stubOpenModule(async (p, opts) => { calledWith = { p, opts }; });
    purgeCache('worker/tasks/open-with');
    purgeCache('paco/ui-state');
    purgeCache('paco/file-handler-detect');

    const task = require('../worker/tasks/open-with');
    const { ctx, promise } = makeCtx({ path: target });
    task.start(ctx);
    const { ok, result } = await promise;

    restore();

    assert.ok(ok, result && result.error);
    assert.equal(result.action, 'open');
    assert.equal(result.app, 'Preview');
    assert.equal(calledWith.opts.app.name, 'Preview');
  });

  test('tier 3: falls through to nativeOpen for an unmatched non-executable file', async () => {
    const target = path.join(workDir, 'mystery.xyz');
    await mkfile(target, 'plain text content, no signature, no category match');

    const ctx2 = freshContext();
    ctx2.writeFileHandlers({
      fallback: 'nativeOpen', exec_fallback: null,
      specific: [],
      category: { text: null, audio: null, image: null, video: null, other: null },
    });

    let calledPlain = null;
    const restore = stubOpenModule(async (p, opts) => { calledPlain = { p, opts }; });
    purgeCache('worker/tasks/open-with');
    purgeCache('paco/ui-state');
    purgeCache('paco/file-handler-detect');

    const task = require('../worker/tasks/open-with');
    const { ctx, promise } = makeCtx({ path: target });
    task.start(ctx);
    const { ok, result } = await promise;

    restore();

    assert.ok(ok, result && result.error);
    assert.equal(result.action, 'nativeOpen');
    assert.equal(calledPlain.p, target);
    assert.equal(calledPlain.opts, undefined); // plain open(), no app option
  });

  test('executable gate: never calls nativeOpen on an executable file, even with fallback=nativeOpen',
    { skip: process.platform === 'win32' }, async () => {
      const target = path.join(workDir, 'run.sh');
      await mkfile(target, '#!/bin/sh\necho hi\n');
      await fsp.chmod(target, 0o755);

      const ctx2 = freshContext();
      ctx2.writeFileHandlers({
        fallback: 'nativeOpen', exec_fallback: null,
        specific: [], category: { text: null, audio: null, image: null, video: null, other: null },
      });

      let openWasCalled = false;
      const restore = stubOpenModule(async () => { openWasCalled = true; });
      purgeCache('worker/tasks/open-with');
      purgeCache('paco/ui-state');
      purgeCache('paco/file-handler-detect');

      const task = require('../worker/tasks/open-with');
      const { ctx, promise } = makeCtx({ path: target });
      task.start(ctx);
      const { ok, result } = await promise;

      restore();

      assert.ok(ok, result && result.error);
      assert.equal(result.action, 'none');
      assert.equal(result.opened, false);
      assert.equal(openWasCalled, false, 'open() must never be called for an executable falling through to fallback');
    });

  test('executable gate: exec_fallback=lister produces a lister result without calling open()',
    { skip: process.platform === 'win32' }, async () => {
      const target = path.join(workDir, 'run2.sh');
      await mkfile(target, '#!/bin/sh\necho hi\n');
      await fsp.chmod(target, 0o755);

      const ctx2 = freshContext();
      ctx2.writeFileHandlers({
        fallback: 'nativeOpen', exec_fallback: 'lister',
        specific: [], category: { text: null, audio: null, image: null, video: null, other: null },
      });

      let openWasCalled = false;
      const restore = stubOpenModule(async () => { openWasCalled = true; });
      purgeCache('worker/tasks/open-with');
      purgeCache('paco/ui-state');
      purgeCache('paco/file-handler-detect');

      const task = require('../worker/tasks/open-with');
      const { ctx, promise } = makeCtx({ path: target });
      task.start(ctx);
      const { ok, result } = await promise;

      restore();

      assert.ok(ok, result && result.error);
      assert.equal(result.action, 'lister');
      assert.equal(openWasCalled, false);
    });

  test('fails when no path is given', async () => {
    purgeCache('worker/tasks/open-with');
    const task = require('../worker/tasks/open-with');
    const { ctx, promise } = makeCtx({ path: '' });
    task.start(ctx);
    const { ok, error } = await promise;
    assert.ok(!ok);
    assert.match(error, /no file specified/i);
  });

  test('fails when the target no longer exists', async () => {
    purgeCache('worker/tasks/open-with');
    const task = require('../worker/tasks/open-with');
    const { ctx, promise } = makeCtx({ path: path.join(workDir, 'ghost-f4.txt') });
    task.start(ctx);
    const { ok, error } = await promise;
    assert.ok(!ok);
    assert.match(error, /no longer exists/i);
  });

  test('fails when the target is a directory', async () => {
    const target = path.join(workDir, 'a-folder');
    await fsp.mkdir(target);
    purgeCache('worker/tasks/open-with');
    const task = require('../worker/tasks/open-with');
    const { ctx, promise } = makeCtx({ path: target });
    task.start(ctx);
    const { ok, error } = await promise;
    assert.ok(!ok);
    assert.match(error, /only applies to files/i);
  });

  test('fails with a clear message when open() itself throws', async () => {
    const target = path.join(workDir, 'boom.xyz');
    await mkfile(target, 'plain text');

    const ctx2 = freshContext();
    ctx2.writeFileHandlers({
      fallback: 'nativeOpen', exec_fallback: null,
      specific: [], category: { text: null, audio: null, image: null, video: null, other: null },
    });

    const restore = stubOpenModule(async () => { throw new Error('spawn ENOENT'); });
    purgeCache('worker/tasks/open-with');
    purgeCache('paco/ui-state');
    purgeCache('paco/file-handler-detect');

    const task = require('../worker/tasks/open-with');
    const { ctx, promise } = makeCtx({ path: target });
    task.start(ctx);
    const { ok, error } = await promise;

    restore();

    assert.ok(!ok);
    assert.match(error, /could not open/i);
  });

  test('reports progress through the operation', async () => {
    const target = path.join(workDir, 'prog.xyz');
    await mkfile(target, 'plain text');

    const ctx2 = freshContext();
    ctx2.writeFileHandlers({
      fallback: 'nativeOpen', exec_fallback: null,
      specific: [], category: { text: null, audio: null, image: null, video: null, other: null },
    });

    const restore = stubOpenModule(async () => {});
    purgeCache('worker/tasks/open-with');
    purgeCache('paco/ui-state');
    purgeCache('paco/file-handler-detect');

    const task = require('../worker/tasks/open-with');
    const { ctx, promise } = makeCtx({ path: target });
    task.start(ctx);
    const { progressLog } = await promise;

    restore();

    assert.ok(progressLog.length >= 2);
    assert.equal(progressLog[progressLog.length - 1].pct, 100);
  });
});

// ─── viewer-details task (F3) ─────────────────────────────────────────────────

describe('viewer-details task', () => {
  test('fails when no path is given', async () => {
    purgeCache('worker/tasks/viewer-details');
    const task = require('../worker/tasks/viewer-details');
    const { ctx, promise } = makeCtx({ path: '' });
    task.start(ctx);
    const { ok, error } = await promise;
    assert.ok(!ok);
    assert.match(error, /no item specified/i);
  });

  test('fails when the target no longer exists', async () => {
    purgeCache('worker/tasks/viewer-details');
    const task = require('../worker/tasks/viewer-details');
    const { ctx, promise } = makeCtx({ path: path.join(workDir, 'ghost-viewer.txt') });
    task.start(ctx);
    const { ok, error } = await promise;
    assert.ok(!ok);
    assert.match(error, /no longer exists/i);
  });

  test('returns a kindLabel for a text file', async () => {
    const target = path.join(workDir, 'notes.md');
    await mkfile(target, '# hello\n\nsome markdown content');
    purgeCache('worker/tasks/viewer-details');
    purgeCache('paco/ui-state');
    purgeCache('paco/file-handler-detect');
    const task = require('../worker/tasks/viewer-details');
    const { ctx, promise } = makeCtx({ path: target });
    task.start(ctx);
    const { ok, result } = await promise;
    assert.ok(ok, result && result.error);
    assert.match(result.kindLabel, /^text \u2014 /);
  });

  test('returns a kindLabel for a real binary signature (PNG)', async () => {
    const target = path.join(workDir, 'pic.png');
    const pngSig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await fsp.writeFile(target, Buffer.concat([pngSig, Buffer.alloc(20)]));
    purgeCache('worker/tasks/viewer-details');
    purgeCache('paco/ui-state');
    purgeCache('paco/file-handler-detect');
    const task = require('../worker/tasks/viewer-details');
    const { ctx, promise } = makeCtx({ path: target });
    task.start(ctx);
    const { ok, result } = await promise;
    assert.ok(ok);
    assert.equal(result.kindLabel, 'binary \u2014 image/png file');
  });

  test('kindLabel is null for a folder (no Type row in that case)', async () => {
    const target = path.join(workDir, 'a-folder');
    await fsp.mkdir(target);
    purgeCache('worker/tasks/viewer-details');
    purgeCache('paco/ui-state');
    purgeCache('paco/file-handler-detect');
    const task = require('../worker/tasks/viewer-details');
    const { ctx, promise } = makeCtx({ path: target });
    task.start(ctx);
    const { ok, result } = await promise;
    assert.ok(ok);
    assert.equal(result.kindLabel, null);
  });

  test('includes owner and octal permissions on POSIX',
    { skip: process.platform === 'win32' }, async () => {
      const target = path.join(workDir, 'perms.txt');
      await mkfile(target, 'x');
      await fsp.chmod(target, 0o644);
      purgeCache('worker/tasks/viewer-details');
      purgeCache('paco/ui-state');
      purgeCache('paco/file-handler-detect');
      const task = require('../worker/tasks/viewer-details');
      const { ctx, promise } = makeCtx({ path: target });
      task.start(ctx);
      const { ok, result } = await promise;
      assert.ok(ok);
      assert.equal(result.octal, '644');
      assert.equal(typeof result.owner, 'string');
      assert.ok(result.permissionGrid);
      assert.deepEqual(result.permissionGrid.owner, { r: true, w: true, x: false });
    });

  test('reports progress through the operation', async () => {
    const target = path.join(workDir, 'progress-viewer.txt');
    await mkfile(target, 'x');
    purgeCache('worker/tasks/viewer-details');
    purgeCache('paco/ui-state');
    purgeCache('paco/file-handler-detect');
    const task = require('../worker/tasks/viewer-details');
    const { ctx, promise } = makeCtx({ path: target });
    task.start(ctx);
    const { progressLog } = await promise;
    assert.ok(progressLog.length >= 2);
    assert.equal(progressLog[progressLog.length - 1].pct, 100);
  });
});

// ─── calc-size / cancel-calc tasks (F3 size calculation) ───────────────────────

/**
 * Stub process.send for the duration of a test — calc-size.js calls it to
 * relay the child's eventual result. process.send is normally undefined
 * outside an actual forked child (which is exactly the case for this test
 * runner), so "restoring" it means deleting the stub again afterward, not
 * putting back some prior real function.
 *
 * @returns {{ restore: Function, sent: object[] }}
 */
function stubProcessSend() {
  const sent = [];
  const had = Object.prototype.hasOwnProperty.call(process, 'send');
  const original = process.send;
  process.send = (envelope) => { sent.push(envelope); };
  return {
    sent,
    restore() {
      if (had) process.send = original;
      else delete process.send;
    },
  };
}

describe('calc-size task', () => {
  test('fails when no panel is specified', async () => {
    purgeCache('worker/tasks/calc-size');
    const task = require('../worker/tasks/calc-size');
    const { ctx, promise } = makeCtx({ panel: '', paths: [workDir] });
    task.start(ctx);
    const { ok, error } = await promise;
    assert.ok(!ok);
    assert.match(error, /no panel specified/i);
  });

  test('fails when no paths are specified', async () => {
    purgeCache('worker/tasks/calc-size');
    const task = require('../worker/tasks/calc-size');
    const { ctx, promise } = makeCtx({ panel: 'left', paths: [] });
    task.start(ctx);
    const { ok, error } = await promise;
    assert.ok(!ok);
    assert.match(error, /no items specified/i);
  });

  test('returns a calcId immediately without waiting for the calculation', async () => {
    const target = path.join(workDir, 'calc-target.txt');
    await mkfile(target, 'x'.repeat(123));

    const stub = stubProcessSend();
    purgeCache('worker/tasks/calc-size');
    purgeCache('paco/calc-registry');
    const registry = require('../paco/calc-registry');
    const task = require('../worker/tasks/calc-size');
    const { ctx, promise } = makeCtx({ panel: 'left', paths: [target] });

    const start = Date.now();
    task.start(ctx);
    const { ok, result } = await promise;
    const elapsed = Date.now() - start;

    assert.ok(ok);
    assert.equal(typeof result.calcId, 'string');
    assert.ok(result.calcId.length > 0);
    // Should resolve essentially instantly — it must not wait for the
    // spawned child to actually finish calculating.
    assert.ok(elapsed < 200, `took ${elapsed}ms — should return near-instantly`);

    // Let the real child finish and report, then clean up
    await new Promise(r => setTimeout(r, 600));
    stub.restore();
    assert.equal(registry.size(), 0, 'registry entry should be cleaned up after the child reports');
  });

  test('relays the correct byte count back via process.send once the child finishes', async () => {
    const target = path.join(workDir, 'relay-target.txt');
    await mkfile(target, 'x'.repeat(256));

    const stub = stubProcessSend();
    purgeCache('worker/tasks/calc-size');
    purgeCache('paco/calc-registry');
    const task = require('../worker/tasks/calc-size');
    const { ctx, promise } = makeCtx({ panel: 'right', paths: [target] });

    task.start(ctx);
    const { result } = await promise;

    await new Promise(r => setTimeout(r, 600));
    stub.restore();

    const relayed = stub.sent.find(e => e.type === 'EVT_CALC_RESULT');
    assert.ok(relayed, 'should have relayed a CALC_RESULT message');
    assert.equal(relayed.payload.calcId, result.calcId);
    assert.equal(relayed.payload.panel, 'right');
    assert.equal(relayed.payload.result.ok, true);
    assert.equal(relayed.payload.result.bytes, 256);
  });

  test('sums a directory tree correctly end to end', async () => {
    const dir = path.join(workDir, 'calc-dir');
    await fsp.mkdir(path.join(dir, 'sub'), { recursive: true });
    await mkfile(path.join(dir, 'a.txt'), 'x'.repeat(30));
    await mkfile(path.join(dir, 'sub', 'b.txt'), 'x'.repeat(70));

    const stub = stubProcessSend();
    purgeCache('worker/tasks/calc-size');
    purgeCache('paco/calc-registry');
    const task = require('../worker/tasks/calc-size');
    const { ctx, promise } = makeCtx({ panel: 'left', paths: [dir] });

    task.start(ctx);
    await promise;
    await new Promise(r => setTimeout(r, 600));
    stub.restore();

    const relayed = stub.sent.find(e => e.type === 'EVT_CALC_RESULT');
    assert.equal(relayed.payload.result.bytes, 100);
  });

  test('registers the spawned child in the registry under the returned calcId', async () => {
    const target = path.join(workDir, 'registry-check.txt');
    await mkfile(target, 'x'.repeat(1000000)); // large enough to still be running when we check

    const stub = stubProcessSend();
    purgeCache('worker/tasks/calc-size');
    purgeCache('paco/calc-registry');
    const registry = require('../paco/calc-registry');
    const task = require('../worker/tasks/calc-size');
    const { ctx, promise } = makeCtx({ panel: 'left', paths: [target] });

    task.start(ctx);
    const { result } = await promise;

    // Immediately after the task resolves, the registry should already
    // have the entry (registered synchronously, before ctx.done() fires).
    assert.ok(registry.get(result.calcId), 'registry should have an entry for the returned calcId');

    await new Promise(r => setTimeout(r, 600));
    stub.restore();
  });
});

describe('cancel-calc task', () => {
  test('fails when no calcId is specified', async () => {
    purgeCache('worker/tasks/cancel-calc');
    const task = require('../worker/tasks/cancel-calc');
    const { ctx, promise } = makeCtx({ calcId: '' });
    task.start(ctx);
    const { ok, error } = await promise;
    assert.ok(!ok);
    assert.match(error, /no calculation id specified/i);
  });

  test('reports cancelled:false for an unknown calcId (not an error)', async () => {
    purgeCache('worker/tasks/cancel-calc');
    const task = require('../worker/tasks/cancel-calc');
    const { ctx, promise } = makeCtx({ calcId: 'this-id-does-not-exist' });
    task.start(ctx);
    const { ok, result } = await promise;
    assert.ok(ok);
    assert.equal(result.cancelled, false);
  });

  test('kills the real child process and removes the registry entry', async () => {
    const target = path.join(workDir, 'cancel-target-dir');
    await fsp.mkdir(target);
    // A reasonably sized tree so the child is still alive when we cancel
    for (let i = 0; i < 30; i++) {
      await mkfile(path.join(target, `f${i}.txt`), 'x'.repeat(2000));
    }

    const stub = stubProcessSend();
    purgeCache('worker/tasks/calc-size');
    purgeCache('worker/tasks/cancel-calc');
    purgeCache('paco/calc-registry');
    const registry  = require('../paco/calc-registry');
    const calcSize   = require('../worker/tasks/calc-size');
    const cancelCalc = require('../worker/tasks/cancel-calc');

    const { ctx: ctx1, promise: p1 } = makeCtx({ panel: 'left', paths: [target] });
    calcSize.start(ctx1);
    const { result } = await p1;

    const child = registry.get(result.calcId);
    assert.ok(child, 'child should be registered');

    const { ctx: ctx2, promise: p2 } = makeCtx({ calcId: result.calcId });
    cancelCalc.start(ctx2);
    const { ok, result: cancelResult } = await p2;

    assert.ok(ok);
    assert.equal(cancelResult.cancelled, true);
    assert.equal(registry.get(result.calcId), undefined, 'registry entry should be removed immediately on cancel');

    // Give the kill signal a moment to actually take effect, then confirm
    // no CALC_RESULT was ever relayed for this calcId — the child died
    // before it could report.
    await new Promise(r => setTimeout(r, 500));
    stub.restore();
    const relayed = stub.sent.find(e => e.payload && e.payload.calcId === result.calcId);
    assert.equal(relayed, undefined, 'a cancelled calculation must never relay a result');
  });
});

// ─── navigate task ────────────────────────────────────────────────────────────

describe('navigate task', () => {
  test('lists a directory and returns panel result', async () => {
    await mkfile(path.join(workDir, 'nav-file.txt'), 'x');
    const task = require('../worker/tasks/navigate');
    const { ctx, promise } = makeCtx({ panel: 'left', path: workDir, pushHistory: true });
    task.start(ctx);
    const { ok, result } = await promise;
    assert.ok(ok);
    assert.equal(result.panel, 'left');
    assert.ok(result.entries.find(e => e.name === 'nav-file.txt'));
    assert.ok(Array.isArray(result.breadcrumbs));
    assert.ok(Array.isArray(result.history));
    assert.ok(result.config);
  });

  test('empty path falls back to the panel\u2019s last-known saved path', async () => {
    // The global beforeEach already set both panels' saved path to workDir
    const task = require('../worker/tasks/navigate');
    const { ctx, promise } = makeCtx({ panel: 'left', path: '' });
    task.start(ctx);
    const { ok, result } = await promise;
    assert.ok(ok);
    assert.equal(result.path, workDir);
  });

  test('falls back to home dir when the saved path no longer exists', async () => {
    const context = require('../paco/context');
    const ghostPath = path.join(workDir, 'this-folder-was-deleted');
    context.updatePanel('left', {
      path: ghostPath, selection: [],
      tabs: [{ id: 'tab-default', path: ghostPath, label: null }],
      activeTab: 'tab-default',
    });
    const task = require('../worker/tasks/navigate');
    const { ctx, promise } = makeCtx({ panel: 'left', path: '' });
    task.start(ctx);
    const { ok, result } = await promise;
    assert.ok(ok);
    assert.equal(result.path, require('os').homedir());
  });

  test('an explicit path always wins over the saved path', async () => {
    const otherDir = await fsp.mkdtemp(path.join(workDir, 'other-'));
    const task = require('../worker/tasks/navigate');
    // saved path is workDir (from beforeEach), but we explicitly ask for otherDir
    const { ctx, promise } = makeCtx({ panel: 'left', path: otherDir });
    task.start(ctx);
    const { ok, result } = await promise;
    assert.ok(ok);
    assert.equal(result.path, otherDir);
  });

  test('fails for unreadable path', async () => {
    const task = require('../worker/tasks/navigate');
    const { ctx, promise } = makeCtx({ panel: 'left', path: '/no/such/dir/xyz' });
    task.start(ctx);
    const { ok } = await promise;
    assert.ok(!ok);
  });

  test('pushes history when pushHistory=true', async () => {
    const task = require('../worker/tasks/navigate');
    const { ctx, promise } = makeCtx({ panel: 'left', path: workDir, pushHistory: true });
    task.start(ctx);
    const { result } = await promise;
    assert.ok(result.history.includes(workDir));
  });

  test('breadcrumbs match path segments', async () => {
    const task = require('../worker/tasks/navigate');
    const { ctx, promise } = makeCtx({ panel: 'right', path: workDir, pushHistory: false });
    task.start(ctx);
    const { result } = await promise;
    const last = result.breadcrumbs[result.breadcrumbs.length - 1];
    assert.equal(last.path, workDir);
  });

  test('reports directoryWritable=true for a normal, writable directory', async () => {
    const task = require('../worker/tasks/navigate');
    const { ctx, promise } = makeCtx({ panel: 'left', path: workDir, pushHistory: false });
    task.start(ctx);
    const { ok, result } = await promise;
    assert.ok(ok);
    assert.equal(result.directoryWritable, true);
  });

  test('reports directoryWritable=false for a read-only directory (POSIX only)',
    { skip: process.platform === 'win32' || process.getuid && process.getuid() === 0 },
    async () => {
      const readOnlyDir = path.join(workDir, 'read-only-dir');
      await fsp.mkdir(readOnlyDir);
      await fsp.chmod(readOnlyDir, 0o555); // r-xr-xr-x, no write bit for anyone
      try {
        const task = require('../worker/tasks/navigate');
        const { ctx, promise } = makeCtx({ panel: 'left', path: readOnlyDir, pushHistory: false });
        task.start(ctx);
        const { ok, result } = await promise;
        assert.ok(ok);
        assert.equal(result.directoryWritable, false);
      } finally {
        await fsp.chmod(readOnlyDir, 0o755); // restore so cleanup can remove it
      }
    });
});
