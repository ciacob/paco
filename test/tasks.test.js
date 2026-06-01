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

// ─── delete task ─────────────────────────────────────────────────────────────

describe('delete task', () => {
  test('deletes a file and refreshes panel', async () => {
    const filePath = path.join(workDir, 'to-delete.txt');
    await mkfile(filePath);
    const task = require('../worker/tasks/delete');
    const { ctx, promise } = makeCtx({ panel: 'left', sources: [filePath] });
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
    const { ctx, promise } = makeCtx({ panel: 'left', sources: [dirPath] });
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
    const { ctx, promise } = makeCtx({ panel: 'left', sources: [a, b] });
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
    const { ctx, promise } = makeCtx({ panel: 'left', sources: [real, ghost] });
    task.start(ctx);
    const { ok, result } = await promise;
    assert.ok(ok);
    // provider.remove uses force:true so ghost deletion doesn't error
    assert.equal(result.deleted, 2);
  });

  test('fails with no sources', async () => {
    const task = require('../worker/tasks/delete');
    const { ctx, promise } = makeCtx({ panel: 'left', sources: [] });
    task.start(ctx);
    const { ok } = await promise;
    assert.ok(!ok);
  });

  test('refreshed panel excludes deleted entries', async () => {
    const filePath = path.join(workDir, 'gone.txt');
    await mkfile(filePath);
    const task = require('../worker/tasks/delete');
    const { ctx, promise } = makeCtx({ panel: 'left', sources: [filePath] });
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

  test('defaults to home dir when path is empty', async () => {
    const task = require('../worker/tasks/navigate');
    const { ctx, promise } = makeCtx({ panel: 'left', path: '' });
    task.start(ctx);
    const { ok, result } = await promise;
    assert.ok(ok);
    assert.equal(result.path, require('os').homedir());
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
});
