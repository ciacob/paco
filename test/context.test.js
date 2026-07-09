'use strict';

/**
 * test/context.test.js
 *
 * Tests for paco/context.js using Node.js v20+ built-in test runner.
 * Uses a temp directory instead of ~/.paco so tests are isolated.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');

// ─── Test isolation: redirect PACO_DIR to a temp dir ─────────────────────────

// We monkey-patch os.homedir before requiring context so PACO_DIR resolves
// to our temp dir rather than the real ~/.paco.
let tmpDir;
let origHomedir;

function makeTmpDir() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paco-test-'));
  origHomedir = os.homedir;
  os.homedir = () => tmpDir;
}

function cleanTmpDir() {
  os.homedir = origHomedir;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  // Purge the require cache so the next require gets a fresh module
  // with the new homedir
  Object.keys(require.cache).forEach(k => {
    if (k.includes('paco/context')) delete require.cache[k];
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function freshContext() {
  // Always get a freshly-required context after patching homedir
  Object.keys(require.cache).forEach(k => {
    if (k.includes('paco/context')) delete require.cache[k];
  });
  return require('../paco/context');
}

// ─── bootstrap ────────────────────────────────────────────────────────────────

describe('bootstrap', () => {
  beforeEach(makeTmpDir);
  afterEach(cleanTmpDir);

  test('creates ~/.paco directory', () => {
    const ctx = freshContext();
    ctx.bootstrap();
    assert.ok(fs.existsSync(ctx.PACO_DIR));
  });

  test('creates all four JSON files', () => {
    const ctx = freshContext();
    ctx.bootstrap();
    for (const p of Object.values(ctx.PATHS)) {
      assert.ok(fs.existsSync(p), `Missing: ${p}`);
    }
  });

  test('is idempotent (safe to call multiple times)', () => {
    const ctx = freshContext();
    ctx.bootstrap();
    ctx.bootstrap();
    assert.ok(fs.existsSync(ctx.PACO_DIR));
  });

  test('does not overwrite existing files', () => {
    const ctx = freshContext();
    ctx.bootstrap();
    ctx.updateConfig({ theme: 'light' });
    ctx.bootstrap(); // second call
    assert.equal(ctx.readConfig().theme, 'light');
  });

  test('migrates stale state: resets tabs when version is missing', () => {
    const ctx = freshContext();
    ctx.bootstrap();
    // Manually write stale state without version and with multiple ghost tabs
    const stale = {
      activePanel: 'left',
      panels: {
        left: {
          path: '/some/path',
          selection: [],
          tabs: [
            { id: 'tab-1', path: '/a', label: null },
            { id: 'tab-2', path: '/b', label: null },
            { id: 'tab-3', path: '/c', label: null },
          ],
          activeTab: 'tab-2',
        },
        right: {
          path: '/other',
          selection: [],
          tabs: [
            { id: 'tab-4', path: '/d', label: null },
            { id: 'tab-5', path: '/e', label: null },
          ],
          activeTab: 'tab-4',
        },
      },
      // no version field — simulates pre-migration state
    };
    const fs2 = require('fs');
    fs2.writeFileSync(ctx.PATHS.state, JSON.stringify(stale), 'utf8');
    // Bootstrap should migrate
    ctx.bootstrap();
    const migrated = ctx.readState();
    assert.equal(migrated.panels.left.tabs.length, 1, 'left tabs reset to 1');
    assert.equal(migrated.panels.right.tabs.length, 1, 'right tabs reset to 1');
    assert.equal(migrated.panels.left.tabs[0].id, 'tab-default');
    assert.equal(migrated.panels.right.tabs[0].id, 'tab-default');
    // Path preserved
    assert.equal(migrated.panels.left.path, '/some/path');
    assert.equal(migrated.panels.right.path, '/other');
  });
});

// ─── config ───────────────────────────────────────────────────────────────────

describe('config', () => {
  beforeEach(makeTmpDir);
  afterEach(cleanTmpDir);

  test('readConfig returns defaults on first boot', () => {
    const ctx = freshContext();
    ctx.bootstrap();
    const cfg = ctx.readConfig();
    assert.equal(cfg.theme, 'dark');
    assert.equal(cfg.showHidden, false);
    assert.equal(cfg.sortBy, 'name');
    assert.equal(cfg.panelSplit, 0.5);
  });

  test('writeConfig persists a custom panelSplit', () => {
    const ctx = freshContext();
    ctx.bootstrap();
    ctx.writeConfig(Object.assign(ctx.readConfig(), { panelSplit: 0.35 }));
    const cfg = ctx.readConfig();
    assert.equal(cfg.panelSplit, 0.35);
  });

  test('updateConfig can update panelSplit without disturbing other keys', () => {
    const ctx = freshContext();
    ctx.bootstrap();
    ctx.updateConfig({ panelSplit: 0.7 });
    const cfg = ctx.readConfig();
    assert.equal(cfg.panelSplit, 0.7);
    assert.equal(cfg.theme, 'dark'); // unchanged default
  });

  test('readConfig fills in panelSplit default when missing from an older config file', () => {
    const ctx = freshContext();
    ctx.bootstrap();
    const raw = JSON.parse(fs.readFileSync(ctx.PATHS.config, 'utf8'));
    delete raw.panelSplit;
    fs.writeFileSync(ctx.PATHS.config, JSON.stringify(raw), 'utf8');
    const cfg = ctx.readConfig();
    assert.equal(cfg.panelSplit, 0.5);
  });

  test('readConfig defaults viewerSplit to 0.5 on first boot', () => {
    const ctx = freshContext();
    ctx.bootstrap();
    const cfg = ctx.readConfig();
    assert.equal(cfg.viewerSplit, 0.5);
  });

  test('writeConfig persists a custom viewerSplit', () => {
    const ctx = freshContext();
    ctx.bootstrap();
    ctx.writeConfig(Object.assign(ctx.readConfig(), { viewerSplit: 0.65 }));
    const cfg = ctx.readConfig();
    assert.equal(cfg.viewerSplit, 0.65);
  });

  test('updateConfig can update viewerSplit without disturbing other keys', () => {
    const ctx = freshContext();
    ctx.bootstrap();
    ctx.updateConfig({ viewerSplit: 0.3 });
    const cfg = ctx.readConfig();
    assert.equal(cfg.viewerSplit, 0.3);
    assert.equal(cfg.panelSplit, 0.5); // unchanged default
  });

  test('readConfig fills in viewerSplit default when missing from an older config file', () => {
    const ctx = freshContext();
    ctx.bootstrap();
    const raw = JSON.parse(fs.readFileSync(ctx.PATHS.config, 'utf8'));
    delete raw.viewerSplit;
    fs.writeFileSync(ctx.PATHS.config, JSON.stringify(raw), 'utf8');
    const cfg = ctx.readConfig();
    assert.equal(cfg.viewerSplit, 0.5);
  });

  test('readConfig defaults extractionTimeoutMs and calcTimeoutMs on first boot', () => {
    const ctx = freshContext();
    ctx.bootstrap();
    const cfg = ctx.readConfig();
    assert.equal(cfg.extractionTimeoutMs, 30000);
    assert.equal(cfg.calcTimeoutMs, 300000);
  });

  test('extractionTimeoutMs and calcTimeoutMs are independently overridable via updateConfig', () => {
    const ctx = freshContext();
    ctx.bootstrap();
    ctx.updateConfig({ extractionTimeoutMs: 5000 });
    const cfg = ctx.readConfig();
    assert.equal(cfg.extractionTimeoutMs, 5000);
    assert.equal(cfg.calcTimeoutMs, 300000); // unchanged default
  });

  test('writeConfig persists values', () => {
    const ctx = freshContext();
    ctx.bootstrap();
    ctx.writeConfig({ theme: 'light', showHidden: true, sortBy: 'size', sortAsc: false });
    const cfg = ctx.readConfig();
    assert.equal(cfg.theme, 'light');
    assert.equal(cfg.showHidden, true);
  });

  test('updateConfig merges with existing values', () => {
    const ctx = freshContext();
    ctx.bootstrap();
    ctx.updateConfig({ theme: 'light' });
    const cfg = ctx.readConfig();
    assert.equal(cfg.theme, 'light');
    assert.equal(cfg.showHidden, false); // unchanged default
  });

  test('readConfig merges stored values with defaults (new keys survive upgrades)', () => {
    const ctx = freshContext();
    ctx.bootstrap();
    // Simulate a config file missing a new key
    const raw = JSON.parse(fs.readFileSync(ctx.PATHS.config, 'utf8'));
    delete raw.dateFormat;
    fs.writeFileSync(ctx.PATHS.config, JSON.stringify(raw), 'utf8');
    const cfg = ctx.readConfig();
    assert.equal(cfg.dateFormat, 'locale'); // default filled in
  });
});

// ─── state ────────────────────────────────────────────────────────────────────

describe('state', () => {
  beforeEach(makeTmpDir);
  afterEach(cleanTmpDir);

  test('readState returns both panels on first boot', () => {
    const ctx = freshContext();
    ctx.bootstrap();
    const s = ctx.readState();
    assert.ok(s.panels.left);
    assert.ok(s.panels.right);
    assert.equal(s.activePanel, 'left');
  });

  test('writeState round-trips correctly', () => {
    const ctx = freshContext();
    ctx.bootstrap();
    const s = ctx.readState();
    s.activePanel = 'right';
    ctx.writeState(s);
    assert.equal(ctx.readState().activePanel, 'right');
  });

  test('updatePanel merges without touching the other panel', () => {
    const ctx = freshContext();
    ctx.bootstrap();
    ctx.updatePanel('left', { path: '/tmp/foo', selection: [] });
    const s = ctx.readState();
    assert.equal(s.panels.left.path, '/tmp/foo');
    // right panel path should still be homedir
    assert.ok(s.panels.right.path !== '/tmp/foo');
  });

  test('setActivePanel persists the change', () => {
    const ctx = freshContext();
    ctx.bootstrap();
    ctx.setActivePanel('right');
    assert.equal(ctx.readState().activePanel, 'right');
  });
});

// ─── history ──────────────────────────────────────────────────────────────────

describe('history', () => {
  beforeEach(makeTmpDir);
  afterEach(cleanTmpDir);

  test('readHistory returns empty arrays on first boot', () => {
    const ctx = freshContext();
    ctx.bootstrap();
    const h = ctx.readHistory();
    assert.deepEqual(h.left,  []);
    assert.deepEqual(h.right, []);
  });

  test('pushHistory appends a new path', () => {
    const ctx = freshContext();
    ctx.bootstrap();
    ctx.pushHistory('left', '/home/user');
    assert.deepEqual(ctx.readHistory().left, ['/home/user']);
  });

  test('pushHistory deduplicates consecutive identical entries', () => {
    const ctx = freshContext();
    ctx.bootstrap();
    ctx.pushHistory('left', '/a');
    ctx.pushHistory('left', '/a');
    assert.deepEqual(ctx.readHistory().left, ['/a']);
  });

  test('pushHistory allows non-consecutive duplicates', () => {
    const ctx = freshContext();
    ctx.bootstrap();
    ctx.pushHistory('left', '/a');
    ctx.pushHistory('left', '/b');
    ctx.pushHistory('left', '/a');
    assert.deepEqual(ctx.readHistory().left, ['/a', '/b', '/a']);
  });

  test('pushHistory does not affect the other panel', () => {
    const ctx = freshContext();
    ctx.bootstrap();
    ctx.pushHistory('left', '/a');
    assert.deepEqual(ctx.readHistory().right, []);
  });

  test('pushHistory caps at HISTORY_CAP (200)', () => {
    const ctx = freshContext();
    ctx.bootstrap();
    for (let i = 0; i < 210; i++) {
      ctx.pushHistory('left', `/path/${i}`);
    }
    const h = ctx.readHistory().left;
    assert.equal(h.length, 200);
    // Should have the most recent entries
    assert.equal(h[h.length - 1], '/path/209');
  });
});

// ─── operations ───────────────────────────────────────────────────────────────

describe('operations', () => {
  beforeEach(makeTmpDir);
  afterEach(cleanTmpDir);

  test('readOperations returns empty operations array on first boot', () => {
    const ctx = freshContext();
    ctx.bootstrap();
    assert.deepEqual(ctx.readOperations(), { operations: [] });
  });

  test('writeOperations round-trips correctly', () => {
    const ctx = freshContext();
    ctx.bootstrap();
    const ops = { operations: [{ id: 'op1', label: 'My Op', trigger: 'manual', steps: [] }] };
    ctx.writeOperations(ops);
    assert.deepEqual(ctx.readOperations(), ops);
  });
});
