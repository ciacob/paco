'use strict';

/**
 * test/ui-state.test.js
 *
 * Tests for paco/ui-state.js using Node.js v20+ built-in test runner.
 * Run with:  node --test test/ui-state.test.js
 *            node --test (runs all *.test.js files)
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const S = require('../paco/ui-state');

// ─── makeAppState / makePanelState ────────────────────────────────────────────

describe('makeAppState', () => {
  test('produces expected defaults', () => {
    const s = S.makeAppState();
    assert.equal(s.activePanel, 'left');
    assert.equal(s.busy, false);
    assert.equal(s.bootPhase, 'idle');
    assert.equal(s.viewerOpen, false);
    assert.ok(s.panels.left);
    assert.ok(s.panels.right);
    assert.equal(s.config.theme, 'dark');
  });

  test('overrides are applied shallowly', () => {
    const s = S.makeAppState({ activePanel: 'right', busy: true });
    assert.equal(s.activePanel, 'right');
    assert.equal(s.busy, true);
  });

  test('viewerOpen can be overridden too', () => {
    const s = S.makeAppState({ viewerOpen: true });
    assert.equal(s.viewerOpen, true);
  });
});

describe('makePanelState', () => {
  test('default path is empty string', () => {
    const p = S.makePanelState();
    assert.equal(p.path, '');
    assert.equal(p.selection.length, 0);
    assert.equal(p.tabs.length, 1);
    assert.equal(p.tabs[0].id, 'tab-default');
  });

  test('accepts a default path', () => {
    const p = S.makePanelState('/home/user');
    assert.equal(p.path, '/home/user');
    assert.equal(p.tabs[0].path, '/home/user');
  });

  test('directoryWritable defaults to true (optimistic) before any navigate result', () => {
    const p = S.makePanelState();
    assert.equal(p.directoryWritable, true);
  });
});

// ─── nextBootAction ───────────────────────────────────────────────────────────

describe('nextBootAction', () => {
  test('idle phase + idle worker → navigate-left', () => {
    const r = S.nextBootAction('idle', { state: 'idle' });
    assert.equal(r.action, 'navigate-left');
  });

  test('booting-left + done(left) → navigate-right', () => {
    const r = S.nextBootAction('booting-left', {
      state: 'done',
      result: { panel: 'left', entries: [] },
    });
    assert.equal(r.action, 'navigate-right');
  });

  test('booting-left + done(right) → none (unexpected result)', () => {
    const r = S.nextBootAction('booting-left', {
      state: 'done',
      result: { panel: 'right', entries: [] },
    });
    assert.equal(r.action, 'none');
  });

  test('idle + done(left) → navigate-right (page reload recovery)', () => {
    const r = S.nextBootAction('idle', {
      state: 'done',
      result: { panel: 'left', entries: [] },
    });
    assert.equal(r.action, 'navigate-right');
  });

  test('idle + done(right) → none (page reload recovery, right panel already done)', () => {
    const r = S.nextBootAction('idle', {
      state: 'done',
      result: { panel: 'right', entries: [] },
    });
    assert.equal(r.action, 'none');
  });

  test('booting-right + done(right) → none (caller sets ready)', () => {
    const r = S.nextBootAction('booting-right', {
      state: 'done',
      result: { panel: 'right', entries: [] },
    });
    assert.equal(r.action, 'none');
  });

  test('ready phase → always none', () => {
    const r = S.nextBootAction('ready', { state: 'done', result: { panel: 'left' } });
    assert.equal(r.action, 'none');
  });

  test('null ws → none', () => {
    assert.equal(S.nextBootAction('idle', null).action, 'none');
  });

  test('booting-left + running → none (wait for done)', () => {
    const r = S.nextBootAction('booting-left', { state: 'running', percent: 50 });
    assert.equal(r.action, 'none');
  });
});

// ─── advanceBootPhase ─────────────────────────────────────────────────────────

describe('advanceBootPhase', () => {
  test('navigate-left → booting-left', () => {
    assert.equal(S.advanceBootPhase('idle', 'navigate-left'), 'booting-left');
  });

  test('navigate-right → booting-right', () => {
    assert.equal(S.advanceBootPhase('booting-left', 'navigate-right'), 'booting-right');
  });

  test('none while booting-right → ready', () => {
    assert.equal(S.advanceBootPhase('booting-right', 'none'), 'ready');
  });

  test('none while idle → stays idle', () => {
    assert.equal(S.advanceBootPhase('idle', 'none'), 'idle');
  });

  test('none while booting-left → stays booting-left', () => {
    assert.equal(S.advanceBootPhase('booting-left', 'none'), 'booting-left');
  });
});

// ─── busyStateFrom ────────────────────────────────────────────────────────────

describe('busyStateFrom', () => {
  test('running state returns msg + pct', () => {
    const r = S.busyStateFrom({ state: 'running', message: 'Reading…', percent: 42 });
    assert.deepEqual(r, { msg: 'Reading…', pct: 42 });
  });

  test('running with no percent defaults to 0', () => {
    const r = S.busyStateFrom({ state: 'running' });
    assert.equal(r.pct, 0);
  });

  test('running with no message uses fallback', () => {
    const r = S.busyStateFrom({ state: 'running' });
    assert.equal(r.msg, 'Working…');
  });

  test('done state → null', () => {
    assert.equal(S.busyStateFrom({ state: 'done' }), null);
  });

  test('idle state → null', () => {
    assert.equal(S.busyStateFrom({ state: 'idle' }), null);
  });

  test('null → null', () => {
    assert.equal(S.busyStateFrom(null), null);
  });
});

// ─── applyNavigateResult ──────────────────────────────────────────────────────

describe('applyNavigateResult', () => {
  function makePanels() {
    return {
      left:  S.makePanelState('/old/left'),
      right: S.makePanelState('/old/right'),
    };
  }

  test('updates the correct panel', () => {
    const panels = makePanels();
    const result = {
      panel:    'left',
      path:     '/new/path',
      entries:  [{ name: 'foo', path: '/new/path/foo', type: 'file', size: 100, mtime: 0 }],
      history:  ['/old/left', '/new/path'],
      volumes:  ['/'],
    };
    const next = S.applyNavigateResult(panels, result);
    assert.equal(next.left.path, '/new/path');
    assert.equal(next.left.entries.length, 1);
    assert.deepEqual(next.left.selection, []);
    // right panel unchanged
    assert.equal(next.right.path, '/old/right');
  });

  test('clears selection on navigation', () => {
    const panels = makePanels();
    panels.left.selection = ['/old/left/file.txt'];
    const result = { panel: 'left', path: '/new', entries: [], history: ['/new'] };
    const next = S.applyNavigateResult(panels, result);
    assert.deepEqual(next.left.selection, []);
  });

  test('preserves right panel when updating left', () => {
    const panels = makePanels();
    panels.right.selection = ['/some/file'];
    const result = { panel: 'left', path: '/x', entries: [], history: ['/x'] };
    const next = S.applyNavigateResult(panels, result);
    assert.deepEqual(next.right.selection, ['/some/file']);
  });

  test('null result → panels unchanged', () => {
    const panels = makePanels();
    const next = S.applyNavigateResult(panels, null);
    assert.equal(next, panels);
  });

  test('result without panel field → panels unchanged', () => {
    const panels = makePanels();
    const next = S.applyNavigateResult(panels, { path: '/x' });
    assert.equal(next, panels);
  });

  test('updates volumes', () => {
    const panels = makePanels();
    const result = { panel: 'right', path: '/mnt', entries: [], history: ['/mnt'], volumes: ['/', '/mnt'] };
    const next = S.applyNavigateResult(panels, result);
    assert.deepEqual(next.right.volumes, ['/', '/mnt']);
  });

  test('carries directoryWritable through from the result', () => {
    const panels = makePanels();
    const result = { panel: 'left', path: '/ro', entries: [], history: ['/ro'], directoryWritable: false };
    const next = S.applyNavigateResult(panels, result);
    assert.equal(next.left.directoryWritable, false);
  });

  test('directoryWritable: true is carried through explicitly too, not just falsy-skipped', () => {
    const panels = makePanels();
    panels.left.directoryWritable = false; // simulate a stale prior value
    const result = { panel: 'left', path: '/rw', entries: [], history: ['/rw'], directoryWritable: true };
    const next = S.applyNavigateResult(panels, result);
    assert.equal(next.left.directoryWritable, true);
  });

  test('defaults directoryWritable to true when the result omits it entirely', () => {
    const panels = makePanels();
    panels.left.directoryWritable = false; // simulate a stale prior value
    const result = { panel: 'left', path: '/x', entries: [], history: ['/x'] }; // no directoryWritable field
    const next = S.applyNavigateResult(panels, result);
    assert.equal(next.left.directoryWritable, true);
  });

  test('new tab survives navigate result (UI is authoritative for tabs)', () => {
    const panels = makePanels();
    // UI has two tabs in memory
    panels.left.tabs = [
      { id: 'tab-default', path: '/old/left', label: null },
      { id: 'tab-new',     path: '/old/left', label: null },
    ];
    panels.left.activeTab = 'tab-new';
    const result = {
      panel: 'left',
      path: '/new/path',
      entries: [],
      history: ['/new/path'],
      // result no longer carries panelState.tabs — UI owns tab structure
    };
    const next = S.applyNavigateResult(panels, result);
    // Both in-memory tabs must survive untouched
    assert.equal(next.left.tabs.length, 2);
    assert.ok(next.left.tabs.find(t => t.id === 'tab-default'));
    assert.ok(next.left.tabs.find(t => t.id === 'tab-new'));
    // Active tab path updated to navigated path
    const active = next.left.tabs.find(t => t.id === 'tab-new');
    assert.equal(active.path, '/new/path');
  });

  test('closed tab does not reappear after navigate result', () => {
    const panels = makePanels();
    // UI already closed tab-2 — only tab-default remains in memory
    panels.left.tabs = [{ id: 'tab-default', path: '/a', label: null }];
    panels.left.activeTab = 'tab-default';
    const result = {
      panel: 'left',
      path: '/a',
      entries: [],
      history: ['/a'],
      // result carries no tab info — UI is authoritative
    };
    const next = S.applyNavigateResult(panels, result);
    // tab-2 must NOT reappear — UI's tab list is the source of truth
    assert.equal(next.left.tabs.length, 1);
    assert.ok(next.left.tabs.find(t => t.id === 'tab-default'));
  });
});

// ─── parentPath ───────────────────────────────────────────────────────────────

describe('parentPath', () => {
  test('unix: /a/b/c → /a/b', () => {
    assert.equal(S.parentPath('/a/b/c'), '/a/b');
  });

  test('unix: /a/b → /a', () => {
    assert.equal(S.parentPath('/a/b'), '/a');
  });

  test('unix: /a → /', () => {
    assert.equal(S.parentPath('/a'), '/');
  });

  test('unix: / → /', () => {
    assert.equal(S.parentPath('/'), '/');
  });

  test('unix: /home/user/docs → /home/user', () => {
    assert.equal(S.parentPath('/home/user/docs'), '/home/user');
  });

  test('empty string → empty string', () => {
    assert.equal(S.parentPath(''), '');
  });

  test('windows: C:\\Users\\foo → C:\\Users', () => {
    assert.equal(S.parentPath('C:\\Users\\foo'), 'C:\\Users');
  });

  test('windows: C:\\Users → C:', () => {
    // one segment below drive root
    assert.equal(S.parentPath('C:\\Users'), 'C:');
  });
});


// ─── Copy dialog helpers ─────────────────────────────────────────────────────

describe('copyDialogHeader', () => {
  test('single item uses filename', () => {
    const h = S.copyDialogHeader(['/home/user/doc.txt'], '/dst');
    assert.ok(h.includes('"doc.txt"'));
    assert.ok(h.includes('/dst'));
  });
  test('multiple items uses count', () => {
    const h = S.copyDialogHeader(['/a', '/b', '/c'], '/dst');
    assert.ok(h.includes('3 items'));
  });
});

describe('copyReport', () => {
  test('abort with reason', () => {
    const r = S.copyReport({ aborted: 1, abortReason: 'file.txt' }, '/dst');
    assert.ok(r.includes('aborted'), 'should say aborted');
    assert.ok(r.includes('"file.txt"'), 'should include filename');
    assert.ok(r.startsWith('Copy'), 'default mode is copy');
  });

  test('abort with reason, move mode', () => {
    const r = S.copyReport({ aborted: 1, abortReason: 'file.txt' }, '/dst', 'move');
    assert.ok(r.startsWith('Move aborted'), 'should say Move aborted');
  });

  test('abort message is clean with no extra fields', () => {
    const r = S.copyReport({ aborted: 1, abortReason: 'x' }, '/dst', 'move');
    assert.ok(r.startsWith('Move aborted'));
    assert.ok(!r.includes('undefined'));
  });

  test('a precise abortMessage (e.g. type mismatch) overrides the generic abort wording', () => {
    const precise = S.typeMismatchMessage('copy', '/a/x.txt', 'file', '/b', 'dir', 'x.txt');
    const r = S.copyReport({ aborted: 1, abortReason: 'x.txt', abortMessage: precise }, '/b');
    assert.equal(r, precise);
    assert.ok(!r.includes('already exists because')); // not the generic phrasing
  });

  test('simple copy', () => {
    const r = S.copyReport({ copied: 3 }, '/dst/folder');
    assert.ok(r.includes('3 items'));
    assert.ok(r.includes('folder'));
  });
  test('copy with prefixed and replaced', () => {
    const r = S.copyReport({ copied: 2, prefixed: 1, replacedOlder: 1 }, '/dst');
    assert.ok(r.includes('4 items'));
    assert.ok(r.includes('renamed with a prefix'));
    assert.ok(r.includes('replaced older'));
  });
  test('merged folders appended', () => {
    const r = S.copyReport({ copied: 1, mergedFolders: 2 }, '/dst');
    assert.ok(r.includes('Merged 2 folders'));
  });
  test('security skips appended', () => {
    const r = S.copyReport({ copied: 1, skippedSecurity: 1 }, '/dst');
    assert.ok(r.includes('permission'));
  });
  test('nothing copied', () => {
    const r = S.copyReport({ copied: 0 }, '/dst');
    assert.ok(r.toLowerCase().includes('nothing'));
  });
});

describe('prefixedName', () => {
  test('returns name unchanged if not in set', () => {
    assert.equal(S.prefixedName('file.txt', new Set()), 'file.txt');
  });
  test('returns (1) prefix on first clash', () => {
    assert.equal(S.prefixedName('file.txt', new Set(['file.txt'])), '(1) file.txt');
  });
  test('increments until free', () => {
    const taken = new Set(['file.txt', '(1) file.txt', '(2) file.txt']);
    assert.equal(S.prefixedName('file.txt', taken), '(3) file.txt');
  });
  test('works for directories (no extension)', () => {
    assert.equal(S.prefixedName('MyDir', new Set(['MyDir'])), '(1) MyDir');
  });
});

// ─── toggleSelection ─────────────────────────────────────────────────────────

describe('toggleSelection', () => {
  test('adds path when not selected', () => {
    const sel = S.toggleSelection([], '/a/b');
    assert.deepEqual(sel, ['/a/b']);
  });

  test('removes path when already selected', () => {
    const sel = S.toggleSelection(['/a/b', '/a/c'], '/a/b');
    assert.deepEqual(sel, ['/a/c']);
  });

  test('does not mutate input array', () => {
    const orig = ['/a/b'];
    S.toggleSelection(orig, '/a/c');
    assert.deepEqual(orig, ['/a/b']);
  });

  test('add and remove round-trip', () => {
    const a = S.toggleSelection([], '/x');
    const b = S.toggleSelection(a, '/x');
    assert.deepEqual(b, []);
  });
});

// ─── selectAllPaths ───────────────────────────────────────────────────────────

describe('selectAllPaths', () => {
  const entries = [
    { name: '..', path: '/parent', type: 'dir' },
    { name: 'foo', path: '/dir/foo', type: 'file' },
    { name: 'bar', path: '/dir/bar', type: 'dir' },
  ];

  test('excludes .. entry', () => {
    const sel = S.selectAllPaths(entries);
    assert.ok(!sel.includes('/parent'));
  });

  test('includes all real entries', () => {
    const sel = S.selectAllPaths(entries);
    assert.deepEqual(sel, ['/dir/foo', '/dir/bar']);
  });

  test('empty entries → empty array', () => {
    assert.deepEqual(S.selectAllPaths([]), []);
  });
});

// ─── addTab ───────────────────────────────────────────────────────────────────

describe('addTab', () => {
  test('appends a tab and makes it active', () => {
    const p    = S.makePanelState('/home');
    const next = S.addTab(p, 'tab-2');
    assert.equal(next.tabs.length, 2);
    assert.equal(next.activeTab, 'tab-2');
    assert.equal(next.tabs[1].path, '/home');
  });

  test('clears selection', () => {
    const p    = { ...S.makePanelState('/home'), selection: ['/home/file'] };
    const next = S.addTab(p, 'tab-2');
    assert.deepEqual(next.selection, []);
  });

  test('does not mutate original', () => {
    const p = S.makePanelState('/home');
    S.addTab(p, 'tab-new');
    assert.equal(p.tabs.length, 1);
  });
});

// ─── closeTab ─────────────────────────────────────────────────────────────────

describe('closeTab', () => {
  function twoTabPanel() {
    let p = S.makePanelState('/a');
    p = S.addTab(p, 'tab-2');
    // manually set second tab path
    p = { ...p, tabs: p.tabs.map(t => t.id === 'tab-2' ? { ...t, path: '/b' } : t) };
    p = { ...p, activeTab: 'tab-2' };
    return p;
  }

  test('refuses to close the last tab', () => {
    const p = S.makePanelState('/a');
    const { panel: next, navigateTo } = S.closeTab(p, 'tab-default');
    assert.equal(next.tabs.length, 1);
    assert.equal(navigateTo, null);
  });

  test('closes active tab and switches to previous', () => {
    const p = twoTabPanel();
    const { panel: next, navigateTo } = S.closeTab(p, 'tab-2');
    assert.equal(next.tabs.length, 1);
    assert.equal(next.activeTab, 'tab-default');
    assert.equal(navigateTo, '/a');
  });

  test('closes inactive tab without navigation', () => {
    const p = twoTabPanel();
    const { panel: next, navigateTo } = S.closeTab(p, 'tab-default');
    assert.equal(next.tabs.length, 1);
    assert.equal(next.activeTab, 'tab-2');
    assert.equal(navigateTo, null);
  });
});

// ─── switchTab ────────────────────────────────────────────────────────────────

describe('switchTab', () => {
  test('switches and returns navigate path', () => {
    let p = S.makePanelState('/a');
    p = S.addTab(p, 'tab-2');
    p = { ...p, tabs: p.tabs.map(t => t.id === 'tab-2' ? { ...t, path: '/b' } : t) };

    const { panel: next, navigateTo } = S.switchTab(p, 'tab-default');
    assert.equal(next.activeTab, 'tab-default');
    assert.equal(navigateTo, '/a');
  });

  test('switching to already-active tab is a no-op', () => {
    const p = S.makePanelState('/a');
    const { panel: next, navigateTo } = S.switchTab(p, 'tab-default');
    assert.equal(next, p);
    assert.equal(navigateTo, null);
  });
});

// ─── nextSortState ────────────────────────────────────────────────────────────

describe('nextSortState', () => {
  test('same column toggles direction', () => {
    const next = S.nextSortState({ sortBy: 'name', sortAsc: true }, 'name');
    assert.deepEqual(next, { sortBy: 'name', sortAsc: false });
  });

  test('toggle back to ascending', () => {
    const next = S.nextSortState({ sortBy: 'name', sortAsc: false }, 'name');
    assert.deepEqual(next, { sortBy: 'name', sortAsc: true });
  });

  test('different column resets to ascending', () => {
    const next = S.nextSortState({ sortBy: 'name', sortAsc: false }, 'size');
    assert.deepEqual(next, { sortBy: 'size', sortAsc: true });
  });
});

// ─── fmtSize ──────────────────────────────────────────────────────────────────

describe('fmtSize', () => {
  test('0 → "0 B" (a genuinely empty file, e.g. a Shift+F4 stub, not blank)', () => {
    assert.equal(S.fmtSize(0), '0 B');
  });
  test('null/undefined → empty string (no size at all, e.g. caller has nothing to show)', () => {
    assert.equal(S.fmtSize(null), '');
    assert.equal(S.fmtSize(undefined), '');
  });
  test('bytes', ()    => assert.equal(S.fmtSize(512), '512 B'));
  test('kilobytes', ()=> assert.equal(S.fmtSize(2048), '2.0 K'));
  test('megabytes', ()=> assert.equal(S.fmtSize(2 * 1024 * 1024), '2.0 M'));
  test('gigabytes', ()=> assert.equal(S.fmtSize(2 * 1024 * 1024 * 1024), '2.00 G'));
  test('boundary: 1023 bytes', () => assert.equal(S.fmtSize(1023), '1023 B'));
  test('boundary: 1024 bytes = 1.0 K', () => assert.equal(S.fmtSize(1024), '1.0 K'));
});

// ─── fmtSizeVerbose ───────────────────────────────────────────────────────────

describe('fmtSizeVerbose', () => {
  test('bytes — no unit conversion, still shows the parenthesized exact count', () => {
    assert.equal(S.fmtSizeVerbose(512), '512 Bytes');
  });

  test('kilobytes', () => {
    assert.equal(S.fmtSizeVerbose(2048), '2.0 Kb (2,048 Bytes)');
  });

  test('megabytes', () => {
    assert.equal(S.fmtSizeVerbose(2 * 1024 * 1024), '2.0 Mb (2,097,152 Bytes)');
  });

  test('gigabytes', () => {
    assert.equal(S.fmtSizeVerbose(2 * 1024 * 1024 * 1024), '2.0 Gb (2,147,483,648 Bytes)');
  });

  test('null/undefined → empty string', () => {
    assert.equal(S.fmtSizeVerbose(null), '');
    assert.equal(S.fmtSizeVerbose(undefined), '');
  });

  test('zero bytes', () => {
    assert.equal(S.fmtSizeVerbose(0), '0 Bytes');
  });

  test('boundary: 1023 bytes stays in Bytes', () => {
    assert.equal(S.fmtSizeVerbose(1023), '1023 Bytes');
  });

  test('boundary: 1024 bytes crosses into Kb', () => {
    assert.equal(S.fmtSizeVerbose(1024), '1.0 Kb (1,024 Bytes)');
  });

  test('large byte counts get thousands separators in the exact count', () => {
    const r = S.fmtSizeVerbose(123456789);
    assert.match(r, /\(123,456,789 Bytes\)$/);
  });
});

// ─── formatFileTooLargeError ───────────────────────────────────────────────────

describe('formatFileTooLargeError', () => {
  test('formats both the actual size and the limit via fmtSize, with the "File too large:" prefix', () => {
    assert.equal(
      S.formatFileTooLargeError(27384126, 5242880),
      'File too large: 26.1 M exceeds the 5.0 M limit.'
    );
  });

  test('small sizes stay in bytes, matching fmtSize\'s own behavior', () => {
    assert.equal(
      S.formatFileTooLargeError(800, 512),
      'File too large: 800 B exceeds the 512 B limit.'
    );
  });

  test('uses fmtSize, not fmtSizeVerbose — compact units, no parenthesized exact byte count', () => {
    const msg = S.formatFileTooLargeError(27384126, 5242880);
    assert.doesNotMatch(msg, /Bytes/);
    assert.doesNotMatch(msg, /\(/);
  });
});

// ─── fmtDate ──────────────────────────────────────────────────────────────────

describe('fmtDate', () => {
  test('0 → empty string', () => assert.equal(S.fmtDate(0), ''));
  test('null → empty string', () => assert.equal(S.fmtDate(null), ''));
  test('valid timestamp returns non-empty string', () => {
    const s = S.fmtDate(Date.UTC(2024, 0, 15, 10, 30));
    assert.ok(typeof s === 'string' && s.length > 0);
  });
});

// ─── shortenPath ─────────────────────────────────────────────────────────────

describe('shortenPath', () => {
  test('returns last segment', ()  => assert.equal(S.shortenPath('/home/user/docs'), 'docs'));
  test('root → /', ()              => assert.equal(S.shortenPath('/'), '/'));
  test('empty → em-dash', ()       => assert.equal(S.shortenPath(''), '—'));
  test('null → em-dash', ()        => assert.equal(S.shortenPath(null), '—'));
  test('windows path', ()          => assert.equal(S.shortenPath('C:\\Users\\foo'), 'foo'));
});

// ─── basenameSelectionEnd ─────────────────────────────────────────────────────

describe('basenameSelectionEnd', () => {
  test('simple extension: selects up to the dot', () => {
    assert.equal(S.basenameSelectionEnd('photo.png'), 5);
  });

  test('multiple dots: stops at the LAST dot', () => {
    assert.equal(S.basenameSelectionEnd('archive.tar.gz'), 11);
  });

  test('no dot at all: selects nothing', () => {
    assert.equal(S.basenameSelectionEnd('README'), 0);
  });

  test('dot file (leading dot only): selects nothing', () => {
    assert.equal(S.basenameSelectionEnd('.gitignore'), 0);
  });

  test('dot file with a second dot: last dot still wins (not position 0)', () => {
    // '.tar.gz' -> lastIndexOf('.') is the second dot (index 4), which is > 0
    assert.equal(S.basenameSelectionEnd('.tar.gz'), 4);
  });

  test('trailing dot: selects everything before it', () => {
    assert.equal(S.basenameSelectionEnd('weird.'), 5);
  });

  test('empty string: selects nothing', () => {
    assert.equal(S.basenameSelectionEnd(''), 0);
  });

  test('null/undefined: selects nothing', () => {
    assert.equal(S.basenameSelectionEnd(null), 0);
    assert.equal(S.basenameSelectionEnd(undefined), 0);
  });

  test('folder name with a dot is treated the same as a file', () => {
    // basenameSelectionEnd has no concept of file vs folder — caller decides
    // whether to even call it (e.g. only for files, or for both — by design
    // here it always applies, since "dot files get no special treatment"
    // only refers to a *leading* dot with nothing before it).
    assert.equal(S.basenameSelectionEnd('my.folder'), 2);
  });
});

// ─── escHtml ─────────────────────────────────────────────────────────────────

describe('escHtml', () => {
  test('escapes ampersand', () => assert.equal(S.escHtml('a&b'), 'a&amp;b'));
  test('escapes less-than', () => assert.equal(S.escHtml('<tag>'), '&lt;tag&gt;'));
  test('escapes quote', ()     => assert.equal(S.escHtml('"hi"'), '&quot;hi&quot;'));
  test('no specials unchanged',() => assert.equal(S.escHtml('hello'), 'hello'));
  test('coerces number',       () => assert.equal(S.escHtml(42), '42'));
});

// ─── fkeyEnabledState ────────────────────────────────────────────────────────

describe('fkeyEnabledState', () => {
  test('no selection → view/edit/copy/move/delete all disabled', () => {
    const r = S.fkeyEnabledState([], false);
    assert.equal(r.view,   false);
    assert.equal(r.edit,   false);
    assert.equal(r.copy,   false);
    assert.equal(r.move,   false);
    assert.equal(r.delete, false);
    assert.equal(r.mkdir,  true);
  });

  test('with selection → action keys enabled', () => {
    const r = S.fkeyEnabledState(['/a/file'], false);
    assert.equal(r.view,   true);
    assert.equal(r.copy,   true);
    assert.equal(r.delete, true);
    assert.equal(r.mkdir,  true);
  });

  test('busy → all disabled including mkdir', () => {
    const r = S.fkeyEnabledState(['/a/file'], true);
    assert.equal(r.view,   false);
    assert.equal(r.mkdir,  false);
    assert.equal(r.delete, false);
  });
});

// ─── canRename ────────────────────────────────────────────────────────────────

describe('canRename', () => {
  const entries = [
    { path: '/a/writable.txt', writable: true },
    { path: '/a/readonly.txt', writable: false },
    { path: '/a/unknown.txt' }, // writable not explicitly set
  ];

  test('false when busy', () => {
    assert.equal(S.canRename(['/a/writable.txt'], entries, true), false);
  });

  test('false when no selection', () => {
    assert.equal(S.canRename([], entries, false), false);
  });

  test('false when multiple selected', () => {
    assert.equal(S.canRename(['/a/writable.txt', '/a/readonly.txt'], entries, false), false);
  });

  test('true for a single writable entry', () => {
    assert.equal(S.canRename(['/a/writable.txt'], entries, false), true);
  });

  test('false for a single read-only entry', () => {
    assert.equal(S.canRename(['/a/readonly.txt'], entries, false), false);
  });

  test('true when writable is not explicitly false (defaults to writable)', () => {
    assert.equal(S.canRename(['/a/unknown.txt'], entries, false), true);
  });

  test('false when selected path is not found in entries', () => {
    assert.equal(S.canRename(['/a/missing.txt'], entries, false), false);
  });
});

// ─── canOpenWith ──────────────────────────────────────────────────────────────

describe('canOpenWith', () => {
  const entries = [
    { path: '/a/file.txt', type: 'file' },
    { path: '/a/folder',   type: 'dir' },
    { path: '/a/link',     type: 'symlink' },
  ];

  test('false when busy', () => {
    assert.equal(S.canOpenWith(['/a/file.txt'], entries, true), false);
  });

  test('false when no selection', () => {
    assert.equal(S.canOpenWith([], entries, false), false);
  });

  test('false when multiple selected', () => {
    assert.equal(S.canOpenWith(['/a/file.txt', '/a/folder'], entries, false), false);
  });

  test('true for a single file', () => {
    assert.equal(S.canOpenWith(['/a/file.txt'], entries, false), true);
  });

  test('false for a single folder — F4 has no meaning for directories', () => {
    assert.equal(S.canOpenWith(['/a/folder'], entries, false), false);
  });

  test('false for a symlink (consistent with other entry-type gates in this module)', () => {
    assert.equal(S.canOpenWith(['/a/link'], entries, false), false);
  });

  test('false when selected path is not found in entries', () => {
    assert.equal(S.canOpenWith(['/a/missing.txt'], entries, false), false);
  });
});

// ─── canCreateFile ────────────────────────────────────────────────────────────

describe('canCreateFile', () => {
  test('false when busy, even if writable', () => {
    assert.equal(S.canCreateFile(true, true), false);
  });

  test('true when writable and not busy', () => {
    assert.equal(S.canCreateFile(true, false), true);
  });

  test('false when not writable', () => {
    assert.equal(S.canCreateFile(false, false), false);
  });

  test('false when both not writable and busy', () => {
    assert.equal(S.canCreateFile(false, true), false);
  });

  test('treats undefined writability as writable (optimistic default)', () => {
    assert.equal(S.canCreateFile(undefined, false), true);
  });

  test('does not depend on selection at all — only busy + writability', () => {
    // No selection-related params exist in this function's signature;
    // this test exists mainly as living documentation of that fact.
    assert.equal(S.canCreateFile.length, 2);
  });
});

describe('createFileDialogHeader', () => {
  test('includes the directory path', () => {
    const h = S.createFileDialogHeader('/Users/ciacob/Documents');
    assert.match(h, /\/Users\/ciacob\/Documents/);
  });

  test('reads as a sensible header, not just a bare path', () => {
    const h = S.createFileDialogHeader('/tmp');
    assert.match(h, /^New File in /);
  });
});

// ─── renameDialogHeader / renameErrorMessage ─────────────────────────────────

describe('renameDialogHeader', () => {
  test('wraps the current name in quotes', () => {
    assert.equal(S.renameDialogHeader('photo.png'), 'Rename "photo.png"');
  });
});

describe('renameErrorMessage', () => {
  test('returns the given reason', () => {
    assert.equal(S.renameErrorMessage('Folder already exists'), 'Folder already exists');
  });
  test('falls back to a default when no reason given', () => {
    assert.equal(S.renameErrorMessage(), 'Rename failed');
    assert.equal(S.renameErrorMessage(''), 'Rename failed');
  });
});

// ─── typeMismatchMessage ──────────────────────────────────────────────────────

describe('typeMismatchMessage', () => {
  test('matches the exact worked example: file source colliding with a folder destination', () => {
    const msg = S.typeMismatchMessage(
      'copy',
      '/Users/ciacob/test.app', 'file',
      '/Users/ciacob/projects/simulcast', 'dir',
      'test.app'
    );
    assert.equal(
      msg,
      'Cannot copy source /Users/ciacob/test.app FILE to target /Users/ciacob/projects/simulcast, ' +
      'because a FOLDER named test.app already exists there.\n\n' +
      'Please rename either the source or the target in order to proceed.\n\n' +
      'Operation aborted.'
    );
  });

  test('the reverse: folder source colliding with a file destination', () => {
    const msg = S.typeMismatchMessage(
      'move',
      '/src/reports', 'dir',
      '/dst', 'file',
      'reports'
    );
    assert.match(msg, /^Cannot move source \/src\/reports FOLDER to target \/dst, /);
    assert.match(msg, /because a FILE named reports already exists there\./);
  });

  test('works for the rename action wording too', () => {
    const msg = S.typeMismatchMessage(
      'rename',
      '/dir/old.txt', 'file',
      '/dir', 'dir',
      'newname'
    );
    assert.match(msg, /^Cannot rename source \/dir\/old\.txt FILE to target \/dir, /);
  });

  test('always ends with the same two trailer paragraphs', () => {
    const msg = S.typeMismatchMessage('copy', '/a', 'file', '/b', 'dir', 'a');
    assert.ok(msg.endsWith(
      'Please rename either the source or the target in order to proceed.\n\nOperation aborted.'
    ));
  });

  test('a symlink source is labelled FILE, not something else (FILE|FOLDER is the only enum)', () => {
    const msg = S.typeMismatchMessage('copy', '/a/link', 'symlink', '/b', 'dir', 'link');
    assert.match(msg, /\/a\/link FILE to target/);
  });

  test('an "other" dest type is labelled FILE too', () => {
    const msg = S.typeMismatchMessage('copy', '/a/x', 'dir', '/b', 'other', 'x');
    assert.match(msg, /because a FILE named x already exists/);
  });
});

// ─── isMacBundleDir ───────────────────────────────────────────────────────────

describe('isMacBundleDir', () => {
  test('recognises .app bundles', () => {
    assert.equal(S.isMacBundleDir('Safari.app'), true);
  });

  test('recognises other known bundle extensions', () => {
    assert.equal(S.isMacBundleDir('MyTool.workflow'), true);
    assert.equal(S.isMacBundleDir('Foo.framework'), true);
    assert.equal(S.isMacBundleDir('Bar.prefPane'), true);
    assert.equal(S.isMacBundleDir('Baz.qlgenerator'), true);
  });

  test('is case-insensitive on the extension', () => {
    assert.equal(S.isMacBundleDir('Safari.APP'), true);
    assert.equal(S.isMacBundleDir('Safari.App'), true);
  });

  test('rejects an unrelated dotted folder name', () => {
    assert.equal(S.isMacBundleDir('My.Project'), false);
  });

  test('rejects a plain folder with no extension', () => {
    assert.equal(S.isMacBundleDir('Documents'), false);
  });

  test('rejects a dotfile-style folder (leading dot, nothing before it)', () => {
    assert.equal(S.isMacBundleDir('.config'), false);
  });

  test('rejects empty/null/undefined', () => {
    assert.equal(S.isMacBundleDir(''), false);
    assert.equal(S.isMacBundleDir(null), false);
    assert.equal(S.isMacBundleDir(undefined), false);
  });

  test('rejects an extension that merely contains a known one as substring', () => {
    // ".apple" should NOT match ".app" — this guards against a careless
    // implementation using .includes() instead of an exact extension match
    assert.equal(S.isMacBundleDir('Something.apple'), false);
  });
});

// ─── decideEnterAction ────────────────────────────────────────────────────────

describe('decideEnterAction', () => {
  const entries = [
    { path: '/p/Documents',   name: 'Documents',   type: 'dir' },
    { path: '/p/My.Project',  name: 'My.Project',  type: 'dir' },
    { path: '/p/Safari.app',  name: 'Safari.app',  type: 'dir' },
    { path: '/p/photo.png',   name: 'photo.png',   type: 'file' },
    { path: '/p/README',      name: 'README',      type: 'file' },
    { path: '/p/.gitignore',  name: '.gitignore',  type: 'file' },
    { path: '/p/link',        name: 'link',        type: 'symlink' },
  ];

  test('zero selection → none', () => {
    assert.deepEqual(S.decideEnterAction([], entries, 'darwin'), { action: 'none', path: null });
  });

  test('multiple selection → none', () => {
    assert.deepEqual(
      S.decideEnterAction(['/p/Documents', '/p/photo.png'], entries, 'darwin'),
      { action: 'none', path: null }
    );
  });

  test('selected path not found in entries → none', () => {
    assert.deepEqual(S.decideEnterAction(['/p/ghost'], entries, 'darwin'), { action: 'none', path: null });
  });

  test('regular folder → navigate', () => {
    assert.deepEqual(
      S.decideEnterAction(['/p/Documents'], entries, 'darwin'),
      { action: 'navigate', path: '/p/Documents' }
    );
  });

  test('dotted-but-not-a-bundle folder → navigate, even on macOS', () => {
    assert.deepEqual(
      S.decideEnterAction(['/p/My.Project'], entries, 'darwin'),
      { action: 'navigate', path: '/p/My.Project' }
    );
  });

  test('.app bundle on macOS → open', () => {
    assert.deepEqual(
      S.decideEnterAction(['/p/Safari.app'], entries, 'darwin'),
      { action: 'open', path: '/p/Safari.app' }
    );
  });

  test('.app bundle on a non-macOS platform → navigate (bundle rule is macOS-only)', () => {
    assert.deepEqual(
      S.decideEnterAction(['/p/Safari.app'], entries, 'other'),
      { action: 'navigate', path: '/p/Safari.app' }
    );
    assert.deepEqual(
      S.decideEnterAction(['/p/Safari.app'], entries, 'win32'),
      { action: 'navigate', path: '/p/Safari.app' }
    );
  });

  test('file with an extension → open, regardless of platform', () => {
    assert.deepEqual(
      S.decideEnterAction(['/p/photo.png'], entries, 'darwin'),
      { action: 'open', path: '/p/photo.png' }
    );
    assert.deepEqual(
      S.decideEnterAction(['/p/photo.png'], entries, 'other'),
      { action: 'open', path: '/p/photo.png' }
    );
  });

  test('file with no extension → none', () => {
    assert.deepEqual(S.decideEnterAction(['/p/README'], entries, 'darwin'), { action: 'none', path: null });
  });

  test('dotfile (leading dot, no real extension) → none', () => {
    assert.deepEqual(S.decideEnterAction(['/p/.gitignore'], entries, 'darwin'), { action: 'none', path: null });
  });

  test('symlink → none (consistent with existing double-click behaviour)', () => {
    assert.deepEqual(S.decideEnterAction(['/p/link'], entries, 'darwin'), { action: 'none', path: null });
  });
});

// ─── classifyMime ─────────────────────────────────────────────────────────────

describe('classifyMime', () => {
  test('text/* → text', () => {
    assert.equal(S.classifyMime('text/html', false), 'text');
    assert.equal(S.classifyMime('text/plain', false), 'text');
  });

  test('audio/* → audio', () => {
    assert.equal(S.classifyMime('audio/mpeg', false), 'audio');
  });

  test('image/* → image', () => {
    assert.equal(S.classifyMime('image/png', false), 'image');
  });

  test('video/* → video', () => {
    assert.equal(S.classifyMime('video/mp4', false), 'video');
  });

  test('an unrecognised MIME prefix → other', () => {
    assert.equal(S.classifyMime('application/pdf', false), 'other');
    assert.equal(S.classifyMime('application/zip', false), 'other');
  });

  test('null mime + looksTextual=true → text (the file-type-has-no-signature case)', () => {
    assert.equal(S.classifyMime(null, true), 'text');
  });

  test('null mime + looksTextual=false → other', () => {
    assert.equal(S.classifyMime(null, false), 'other');
  });

  test('undefined mime is treated the same as null', () => {
    assert.equal(S.classifyMime(undefined, true), 'text');
    assert.equal(S.classifyMime(undefined, false), 'other');
  });
});

// ─── extOf ────────────────────────────────────────────────────────────────────

describe('extOf', () => {
  test('returns the lower-cased extension including the dot', () => {
    assert.equal(S.extOf('Photo.PNG'), '.png');
    assert.equal(S.extOf('archive.tar.gz'), '.gz');
  });

  test('no extension → empty string', () => {
    assert.equal(S.extOf('README'), '');
  });

  test('dot file with nothing before the dot → empty string', () => {
    assert.equal(S.extOf('.gitignore'), '');
  });

  test('empty/null/undefined → empty string', () => {
    assert.equal(S.extOf(''), '');
    assert.equal(S.extOf(null), '');
    assert.equal(S.extOf(undefined), '');
  });
});

// ─── resolveFileHandler ───────────────────────────────────────────────────────

describe('resolveFileHandler', () => {
  function makeConfig(overrides = {}) {
    return Object.assign({
      fallback: 'nativeOpen',
      exec_fallback: null,
      specific: [],
      category: { text: null, audio: null, image: null, video: null, other: null },
    }, overrides);
  }

  test('tier 1: specific extension match wins, even with a category handler set', () => {
    const config = makeConfig({
      specific: [{ extensions: ['.psd', '.ai'], handler: { app: 'Photoshop', args: ['--silent'] } }],
      category: { image: { app: 'Preview', args: [] }, text: null, audio: null, video: null, other: null },
    });
    const r = S.resolveFileHandler(config, 'cover.psd', 'image/vnd.adobe.photoshop', false, false);
    assert.deepEqual(r, { action: 'open', app: 'Photoshop', args: ['--silent'] });
  });

  test('tier 1 match is case-insensitive on the extension', () => {
    const config = makeConfig({
      specific: [{ extensions: ['.psd'], handler: { app: 'Photoshop' } }],
    });
    const r = S.resolveFileHandler(config, 'cover.PSD', null, false, false);
    assert.equal(r.action, 'open');
    assert.equal(r.app, 'Photoshop');
  });

  test('tier 1 handler with no args defaults to an empty array', () => {
    const config = makeConfig({
      specific: [{ extensions: ['.txt'], handler: { app: 'Notepad' } }],
    });
    const r = S.resolveFileHandler(config, 'a.txt', null, true, false);
    assert.deepEqual(r.args, []);
  });

  test('tier 2: category match used when no specific match exists', () => {
    const config = makeConfig({
      category: { image: { app: 'Preview', args: [] }, text: null, audio: null, video: null, other: null },
    });
    const r = S.resolveFileHandler(config, 'photo.png', 'image/png', false, false);
    assert.deepEqual(r, { action: 'open', app: 'Preview', args: [] });
  });

  test('tier 2 falls through to fallback when the matched category is null', () => {
    const config = makeConfig({ fallback: 'nativeOpen' });
    const r = S.resolveFileHandler(config, 'photo.png', 'image/png', false, false);
    assert.equal(r.action, 'nativeOpen');
  });

  test('tier 2 routes a no-signature, textual file into the text bucket', () => {
    const config = makeConfig({
      category: { text: { app: 'TextEdit', args: [] }, audio: null, image: null, video: null, other: null },
    });
    const r = S.resolveFileHandler(config, 'notes.md', null, true, false);
    assert.deepEqual(r, { action: 'open', app: 'TextEdit', args: [] });
  });

  test('tier 3: fallback nativeOpen, non-executable file', () => {
    const config = makeConfig({ fallback: 'nativeOpen' });
    const r = S.resolveFileHandler(config, 'whatever.xyz', null, false, false);
    assert.deepEqual(r, { action: 'nativeOpen' });
  });

  test('tier 3: fallback lister', () => {
    const config = makeConfig({ fallback: 'lister' });
    const r = S.resolveFileHandler(config, 'whatever.xyz', null, false, false);
    assert.deepEqual(r, { action: 'lister' });
  });

  test('tier 3: fallback null → none', () => {
    const config = makeConfig({ fallback: null });
    const r = S.resolveFileHandler(config, 'whatever.xyz', null, false, false);
    assert.deepEqual(r, { action: 'none' });
  });

  test('tier 3: missing fallback key defaults to nativeOpen', () => {
    const config = { specific: [], category: { text: null, audio: null, image: null, video: null, other: null } };
    const r = S.resolveFileHandler(config, 'whatever.xyz', null, false, false);
    assert.deepEqual(r, { action: 'nativeOpen' });
  });

  test('executable gate: nativeOpen fallback is REPLACED by exec_fallback for an executable file', () => {
    const config = makeConfig({ fallback: 'nativeOpen', exec_fallback: null });
    const r = S.resolveFileHandler(config, 'installer.sh', null, false, true);
    assert.deepEqual(r, { action: 'none' }); // never nativeOpen, even though fallback says so
  });

  test('executable gate: exec_fallback lister is honoured', () => {
    const config = makeConfig({ fallback: 'nativeOpen', exec_fallback: 'lister' });
    const r = S.resolveFileHandler(config, 'installer.sh', null, false, true);
    assert.deepEqual(r, { action: 'lister' });
  });

  test('executable gate: a misconfigured exec_fallback of "nativeOpen" is still refused', () => {
    const config = makeConfig({ exec_fallback: 'nativeOpen' });
    const r = S.resolveFileHandler(config, 'installer.sh', null, false, true);
    assert.notEqual(r.action, 'nativeOpen');
    assert.deepEqual(r, { action: 'none' });
  });

  test('executable gate does NOT block a specific-tier match', () => {
    const config = makeConfig({
      specific: [{ extensions: ['.sh'], handler: { app: 'BBEdit', args: [] } }],
      exec_fallback: null,
    });
    const r = S.resolveFileHandler(config, 'installer.sh', null, false, true);
    assert.deepEqual(r, { action: 'open', app: 'BBEdit', args: [] });
  });

  test('executable gate does NOT block a category-tier match', () => {
    const config = makeConfig({
      category: { text: { app: 'BBEdit', args: [] }, audio: null, image: null, video: null, other: null },
      exec_fallback: null,
    });
    const r = S.resolveFileHandler(config, 'installer.sh', null, true, true);
    assert.deepEqual(r, { action: 'open', app: 'BBEdit', args: [] });
  });

  test('missing/empty config object defaults sensibly (nativeOpen, non-executable)', () => {
    const r = S.resolveFileHandler(undefined, 'whatever.xyz', null, false, false);
    assert.deepEqual(r, { action: 'nativeOpen' });
  });

  test('missing/empty config object, executable → none, never nativeOpen', () => {
    const r = S.resolveFileHandler({}, 'whatever.sh', null, false, true);
    assert.deepEqual(r, { action: 'none' });
  });
});

// ─── opConfirmMessage ────────────────────────────────────────────────────────

describe('opConfirmMessage', () => {
  test('copy singular', () => {
    assert.equal(S.opConfirmMessage('copy', 1, '/dst'), 'Copy 1 item to:\n/dst');
  });
  test('copy plural', () => {
    assert.equal(S.opConfirmMessage('copy', 3, '/dst'), 'Copy 3 items to:\n/dst');
  });
  test('move', () => {
    assert.equal(S.opConfirmMessage('move', 2, '/dst'), 'Move 2 items to:\n/dst');
  });
});

// ─── describeViewerSelection ──────────────────────────────────────────────────

describe('describeViewerSelection', () => {
  const fileA  = { path: '/L/a.txt', name: 'a.txt', type: 'file', size: 100, mtime: 300, created: 100 };
  const fileB  = { path: '/L/b.txt', name: 'b.txt', type: 'file', size: 200, mtime: 100, created: 300 };
  const dirC   = { path: '/L/c',     name: 'c',     type: 'dir',  size: 0,   mtime: 200, created: 200 };
  const fileD  = { path: '/R/d.txt', name: 'd.txt', type: 'file', size: 50,  mtime: 50,  created: 50  };
  const fileE  = { path: '/R/e.txt', name: 'e.txt', type: 'file', size: 60,  mtime: 60,  created: 60  };

  function makePanels(leftSel, rightSel) {
    return {
      left:  { selection: leftSel,  entries: [fileA, fileB, dirC] },
      right: { selection: rightSel, entries: [fileD, fileE] },
    };
  }

  test('no selection in either panel → empty mode', () => {
    const r = S.describeViewerSelection(makePanels([], []));
    assert.deepEqual(r, { mode: 'empty' });
  });

  test('single item selected in one panel → one column, kind single', () => {
    const r = S.describeViewerSelection(makePanels(['/L/a.txt'], []));
    assert.equal(r.mode, 'columns');
    assert.equal(r.columns.length, 1);
    assert.equal(r.columns[0].side, 'left');
    assert.equal(r.columns[0].kind, 'single');
    assert.equal(r.columns[0].entry.name, 'a.txt');
  });

  test('multiple items selected in one panel → one column, kind multi', () => {
    const r = S.describeViewerSelection(makePanels(['/L/a.txt', '/L/c'], []));
    assert.equal(r.columns.length, 1);
    assert.equal(r.columns[0].kind, 'multi');
    assert.equal(r.columns[0].entries.length, 2);
  });

  test('selection in both panels → two columns, left first then right', () => {
    const r = S.describeViewerSelection(makePanels(['/L/a.txt'], ['/R/d.txt']));
    assert.equal(r.columns.length, 2);
    assert.equal(r.columns[0].side, 'left');
    assert.equal(r.columns[1].side, 'right');
  });

  test('one single column + one multi column simultaneously', () => {
    const r = S.describeViewerSelection(makePanels(['/L/a.txt'], ['/R/d.txt', '/R/e.txt']));
    assert.equal(r.columns[0].kind, 'single');
    assert.equal(r.columns[1].kind, 'multi');
  });

  test('multi column reports correct file/folder/total counts', () => {
    const r = S.describeViewerSelection(makePanels(['/L/a.txt', '/L/b.txt', '/L/c'], []));
    assert.deepEqual(r.columns[0].counts, { files: 2, folders: 1, total: 3 });
  });

  test('multi column recentCreated is sorted newest-first, top 3', () => {
    const r = S.describeViewerSelection(makePanels(['/L/a.txt', '/L/b.txt', '/L/c'], []));
    const names = r.columns[0].recentCreated.map(e => e.name);
    // created: b=300, c=200, a=100 → newest first
    assert.deepEqual(names, ['b.txt', 'c', 'a.txt']);
  });

  test('multi column recentModified is sorted newest-first, top 3', () => {
    const r = S.describeViewerSelection(makePanels(['/L/a.txt', '/L/b.txt', '/L/c'], []));
    const names = r.columns[0].recentModified.map(e => e.name);
    // mtime: a=300, c=200, b=100 → newest first
    assert.deepEqual(names, ['a.txt', 'c', 'b.txt']);
  });

  test('recent lists cap at 3 even with more items selected', () => {
    const manyEntries = Array.from({ length: 5 }, (_, i) => ({
      path: `/L/f${i}.txt`, name: `f${i}.txt`, type: 'file', size: 1, mtime: i, created: i,
    }));
    const panels = {
      left:  { selection: manyEntries.map(e => e.path), entries: manyEntries },
      right: { selection: [], entries: [] },
    };
    const r = S.describeViewerSelection(panels);
    assert.equal(r.columns[0].recentCreated.length, 3);
    assert.equal(r.columns[0].recentModified.length, 3);
  });

  test('selection referencing a path no longer in entries is silently dropped', () => {
    const r = S.describeViewerSelection(makePanels(['/L/a.txt', '/L/ghost.txt'], []));
    // Only a.txt actually matches a live entry — single column despite 2 selected paths
    assert.equal(r.columns[0].kind, 'single');
    assert.equal(r.columns[0].entry.name, 'a.txt');
  });

  test('symlinks count as "files" in the multi counts summary', () => {
    const link = { path: '/L/lnk', name: 'lnk', type: 'symlink', size: 0, mtime: 1, created: 1 };
    const panels = {
      left:  { selection: ['/L/a.txt', '/L/lnk'], entries: [fileA, link] },
      right: { selection: [], entries: [] },
    };
    const r = S.describeViewerSelection(panels);
    assert.deepEqual(r.columns[0].counts, { files: 2, folders: 0, total: 2 });
  });
});

// ─── viewerKindLabel ──────────────────────────────────────────────────────────

describe('viewerKindLabel', () => {
  test('textual file with a real MIME match', () => {
    assert.equal(S.viewerKindLabel(true, 'text/html', '.html'), 'text \u2014 text/html file');
  });

  test('binary file with a real MIME match', () => {
    assert.equal(S.viewerKindLabel(false, 'image/png', '.png'), 'binary \u2014 image/png file');
  });

  test('binary file with no MIME match falls back to the uppercased extension', () => {
    assert.equal(S.viewerKindLabel(false, null, '.xyz'), 'binary \u2014 XYZ file');
  });

  test('textual file with no MIME match (the common case — file-type never detects text)', () => {
    assert.equal(S.viewerKindLabel(true, null, '.md'), 'text \u2014 MD file');
  });

  test('no extension at all and no MIME match → "unknown"', () => {
    assert.equal(S.viewerKindLabel(true, null, ''), 'text \u2014 unknown file');
  });

  test('a vnd.-namespace MIME with an extension available prefers the extension — the actual bug report', () => {
    assert.equal(
      S.viewerKindLabel(false, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.docx'),
      'binary \u2014 DOCX file'
    );
  });

  test('other common Office vnd. MIME types also resolve to their extension', () => {
    assert.equal(S.viewerKindLabel(false, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xlsx'), 'binary \u2014 XLSX file');
    assert.equal(S.viewerKindLabel(false, 'application/vnd.oasis.opendocument.text', '.odt'), 'binary \u2014 ODT file');
    assert.equal(S.viewerKindLabel(false, 'application/vnd.ms-excel', '.xls'), 'binary \u2014 XLS file');
  });

  test('an x-namespace MIME (e.g. a camera raw format) also prefers the extension', () => {
    assert.equal(S.viewerKindLabel(false, 'image/x-canon-cr2', '.cr2'), 'binary \u2014 CR2 file');
  });

  test('a vnd./x- MIME with NO extension available falls back to the raw mime — better than nothing', () => {
    assert.equal(S.viewerKindLabel(false, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ''), 'binary \u2014 application/vnd.openxmlformats-officedocument.wordprocessingml.document file');
  });

  test('an excessively long mime not matching vnd./x- is ALSO treated as ugly (defensive length catch-all)', () => {
    const longMime = 'application/x' + 'y'.repeat(40); // 40+ chars, no vnd./x- match at the subtype boundary itself
    assert.equal(S.viewerKindLabel(false, longMime, '.foo'), 'binary \u2014 FOO file');
  });

  test('a clean, standard MIME is still preferred over the extension when both are available', () => {
    // Precision matters here: "image/jpeg" is more informative than a
    // bare "JPG"/"JPEG" (which don't even reliably agree with each
    // other), so a non-vendor mime should win, not just be a fallback.
    assert.equal(S.viewerKindLabel(false, 'image/jpeg', '.jpg'), 'binary \u2014 image/jpeg file');
  });
});

// ─── viewerPermissionGrid ─────────────────────────────────────────────────────

describe('viewerPermissionGrid', () => {
  test('0o644 — owner rw, group r, other r', () => {
    const g = S.viewerPermissionGrid(0o644);
    assert.deepEqual(g, {
      owner: { r: true,  w: true,  x: false },
      group: { r: true,  w: false, x: false },
      other: { r: true,  w: false, x: false },
    });
  });

  test('0o755 — owner rwx, group rx, other rx', () => {
    const g = S.viewerPermissionGrid(0o755);
    assert.deepEqual(g, {
      owner: { r: true, w: true,  x: true },
      group: { r: true, w: false, x: true },
      other: { r: true, w: false, x: true },
    });
  });

  test('0o000 — nothing set anywhere', () => {
    const g = S.viewerPermissionGrid(0o000);
    assert.deepEqual(g, {
      owner: { r: false, w: false, x: false },
      group: { r: false, w: false, x: false },
      other: { r: false, w: false, x: false },
    });
  });

  test('0o777 — everything set everywhere', () => {
    const g = S.viewerPermissionGrid(0o777);
    assert.deepEqual(g, {
      owner: { r: true, w: true, x: true },
      group: { r: true, w: true, x: true },
      other: { r: true, w: true, x: true },
    });
  });

  test('0o600 — only owner has any access', () => {
    const g = S.viewerPermissionGrid(0o600);
    assert.equal(g.owner.r, true);
    assert.equal(g.owner.w, true);
    assert.equal(g.group.r, false);
    assert.equal(g.other.r, false);
  });
});

// ─── viewerRendererClassification / orderRendererTabsForDisplay / siblingMediaRendererName ──

describe('viewerRendererClassification', () => {
  test('textual file: fileMode "text", binaryCategory null', () => {
    const c = S.viewerRendererClassification('single', true, null, 'notes.md');
    assert.deepEqual(c, { selectionType: 'single', fileMode: 'text', binaryCategory: null, fileType: 'md' });
  });

  test('binary file with a detected image mime', () => {
    const c = S.viewerRendererClassification('single', false, 'image/png', 'photo.png');
    assert.deepEqual(c, { selectionType: 'single', fileMode: 'binary', binaryCategory: 'image', fileType: 'png' });
  });

  test('binary file with a detected mime outside text/audio/image/video -> "other"', () => {
    const c = S.viewerRendererClassification('single', false, 'application/pdf', 'report.pdf');
    assert.equal(c.binaryCategory, 'other');
    assert.equal(c.fileMode, 'binary');
  });

  test('binary file with no detected mime at all -> "other" (not "text")', () => {
    const c = S.viewerRendererClassification('single', false, null, 'archive.zip');
    assert.equal(c.binaryCategory, 'other');
  });

  test('a name with no extension yields fileType null', () => {
    const c = S.viewerRendererClassification('single', true, null, 'README');
    assert.equal(c.fileType, null);
  });

  test('multi selectionType is passed through unchanged', () => {
    const c = S.viewerRendererClassification('multi', true, null, 'a.md');
    assert.equal(c.selectionType, 'multi');
  });
});

describe('orderRendererTabsForDisplay', () => {
  const base = { name: 'Raw binary', abilities: { selection_type: 'single', file_mode: 'binary' } };
  const specific = { name: 'Thumbnail', abilities: { selection_type: 'single', file_mode: 'binary', binary_category: 'image', file_type: 'png' } };
  const familySpecific = { name: 'Formatted text', abilities: { selection_type: 'single', file_mode: 'binary', binary_category: 'other', file_type: ['docx', 'pdf'] } };

  test('base renderer moves to the front, specific tab(s) after', () => {
    const ordered = S.orderRendererTabsForDisplay([specific, base]);
    assert.deepEqual(ordered.map(t => t.name), ['Raw binary', 'Thumbnail']);
  });

  test('already-correct order is left as-is', () => {
    const ordered = S.orderRendererTabsForDisplay([base, specific]);
    assert.deepEqual(ordered.map(t => t.name), ['Raw binary', 'Thumbnail']);
  });

  test('a renderer with an array file_type is treated as specific, not base', () => {
    const ordered = S.orderRendererTabsForDisplay([familySpecific, base]);
    assert.deepEqual(ordered.map(t => t.name), ['Raw binary', 'Formatted text']);
  });

  test('a single-tab list (no specific match) is unchanged', () => {
    const ordered = S.orderRendererTabsForDisplay([base]);
    assert.deepEqual(ordered.map(t => t.name), ['Raw binary']);
  });

  test('an empty list stays empty', () => {
    assert.deepEqual(S.orderRendererTabsForDisplay([]), []);
  });
});

describe('siblingMediaRendererName', () => {
  test('Filmstrip -> Waveform', () => {
    assert.equal(S.siblingMediaRendererName('Filmstrip'), 'Waveform');
  });

  test('Waveform -> Filmstrip', () => {
    assert.equal(S.siblingMediaRendererName('Waveform'), 'Filmstrip');
  });

  test('any other name -> null', () => {
    assert.equal(S.siblingMediaRendererName('Thumbnail'), null);
    assert.equal(S.siblingMediaRendererName('Raw binary'), null);
    assert.equal(S.siblingMediaRendererName(''), null);
  });
});

describe('composeIframeDocument', () => {
  test('wraps the fragment in a full document with a charset meta and a CSP meta', () => {
    const doc = S.composeIframeDocument('<p>hello</p>');
    assert.match(doc, /^<!DOCTYPE html>/);
    assert.match(doc, /<meta charset="utf-8">/);
    assert.match(doc, /Content-Security-Policy/);
    assert.match(doc, /<body><p>hello<\/p><\/body>/);
  });

  test('CSP has no connect-src/media-src/frame-src, and script-src is unsafe-inline only', () => {
    const doc = S.composeIframeDocument('<p>x</p>');
    assert.match(doc, /default-src 'none'/);
    assert.match(doc, /script-src 'unsafe-inline'/);
    assert.match(doc, /style-src 'unsafe-inline'/);
    assert.match(doc, /img-src data:/);
    assert.doesNotMatch(doc, /connect-src/);
    assert.doesNotMatch(doc, /frame-src/);
  });

  test('a null/undefined body does not throw and yields an empty body', () => {
    assert.match(S.composeIframeDocument(null), /<body><\/body>/);
    assert.match(S.composeIframeDocument(undefined), /<body><\/body>/);
  });

  test('does not escape or alter the fragment — the extractor is the trust boundary, not this function', () => {
    const doc = S.composeIframeDocument('<script>1</script>');
    assert.match(doc, /<body><script>1<\/script><\/body>/);
  });

  test('with a textStyle, emits a body style rule with the given color/font-family/font-size', () => {
    const doc = S.composeIframeDocument('<p>x</p>', { color: 'rgb(201, 205, 212)', fontFamily: 'Arial, sans-serif', fontSize: '13px' });
    assert.match(doc, /<style>body\{color:rgb\(201, 205, 212\);font-family:Arial, sans-serif;font-size:13px;\}<\/style>/);
  });

  test('the style block appears before </head>, after the CSP meta', () => {
    const doc = S.composeIframeDocument('<p>x</p>', { color: 'red', fontFamily: 'monospace', fontSize: '12px' });
    const cspIndex = doc.indexOf('Content-Security-Policy');
    const styleIndex = doc.indexOf('<style>');
    const headCloseIndex = doc.indexOf('</head>');
    assert.ok(cspIndex < styleIndex, 'style block should come after the CSP meta');
    assert.ok(styleIndex < headCloseIndex, 'style block should still be inside <head>');
  });

  test('the base html,body height:100% rule is always emitted, with or without a textStyle', () => {
    const withTextStyle = S.composeIframeDocument('<p>x</p>', { color: 'red', fontFamily: 'monospace', fontSize: '12px' });
    const withoutTextStyle = S.composeIframeDocument('<p>x</p>');
    assert.match(withTextStyle, /<style>html,body\{height:100%;margin:0;\}<\/style>/);
    assert.match(withoutTextStyle, /<style>html,body\{height:100%;margin:0;\}<\/style>/);
  });

  test('without a textStyle, no THEME (color/font) style rule is emitted — only the always-present base rule', () => {
    const doc = S.composeIframeDocument('<p>x</p>');
    assert.doesNotMatch(doc, /color:/);
    assert.doesNotMatch(doc, /font-family:/);
  });

  test('a textStyle missing any one of color/fontFamily/fontSize is treated as absent — no partial theme style rule', () => {
    const doc1 = S.composeIframeDocument('<p>x</p>', { color: 'red', fontFamily: 'monospace' }); // no fontSize
    const doc2 = S.composeIframeDocument('<p>x</p>', { fontFamily: 'monospace', fontSize: '12px' }); // no color
    assert.doesNotMatch(doc1, /color:/);
    assert.doesNotMatch(doc2, /color:/);
  });

  test('null textStyle behaves the same as omitting it', () => {
    const doc = S.composeIframeDocument('<p>x</p>', null);
    assert.doesNotMatch(doc, /color:/);
    assert.doesNotMatch(doc, /font-family:/);
  });

  test('with a selectionStyle, emits a ::selection rule with the given background-color/color', () => {
    const doc = S.composeIframeDocument('<p>x</p>', null, { backgroundColor: 'rgb(42, 58, 92)', color: 'rgb(201, 205, 212)' });
    assert.match(doc, /<style>::selection\{background-color:rgb\(42, 58, 92\);color:rgb\(201, 205, 212\);\}<\/style>/);
  });

  test('without a selectionStyle, no ::selection rule is emitted', () => {
    const doc = S.composeIframeDocument('<p>x</p>');
    assert.doesNotMatch(doc, /::selection/);
  });

  test('a selectionStyle missing either backgroundColor or color is treated as absent — no partial ::selection rule', () => {
    const doc1 = S.composeIframeDocument('<p>x</p>', null, { backgroundColor: 'red' }); // no color
    const doc2 = S.composeIframeDocument('<p>x</p>', null, { color: 'red' }); // no backgroundColor
    assert.doesNotMatch(doc1, /::selection/);
    assert.doesNotMatch(doc2, /::selection/);
  });

  test('null selectionStyle behaves the same as omitting it', () => {
    const doc = S.composeIframeDocument('<p>x</p>', null, null);
    assert.doesNotMatch(doc, /::selection/);
  });

  test('textStyle and selectionStyle are independent — either can be present without the other', () => {
    const onlySelection = S.composeIframeDocument('<p>x</p>', null, { backgroundColor: 'blue', color: 'white' });
    assert.doesNotMatch(onlySelection, /body\{color:/);
    assert.match(onlySelection, /::selection/);

    const onlyText = S.composeIframeDocument('<p>x</p>', { color: 'red', fontFamily: 'monospace', fontSize: '12px' });
    assert.match(onlyText, /body\{color:/);
    assert.doesNotMatch(onlyText, /::selection/);
  });

  test('the ::selection rule appears before </head>, after the CSP meta, alongside the other style blocks', () => {
    const doc = S.composeIframeDocument('<p>x</p>', null, { backgroundColor: 'blue', color: 'white' });
    const cspIndex = doc.indexOf('Content-Security-Policy');
    const selectionIndex = doc.indexOf('::selection');
    const headCloseIndex = doc.indexOf('</head>');
    assert.ok(cspIndex < selectionIndex, '::selection rule should come after the CSP meta');
    assert.ok(selectionIndex < headCloseIndex, '::selection rule should still be inside <head>');
  });
});

// ─── makeDebounced ────────────────────────────────────────────────────────────

// Moved here from test/watcher-state.test.js — makeDebounced's canonical
// implementation now lives in this module (see its own header comment for
// why: it's the one already loaded both server-side and client-side, so the
// F3 Viewer's own selection-click debouncing can reuse this exact, already-
// tested implementation instead of a second copy). watcher-state.test.js
// keeps a thin test confirming its own re-export points at this same
// function, rather than duplicating this full behavioral suite.
describe('makeDebounced', () => {
  // Use fake timers injected via the timers parameter
  function makeFakeTimers() {
    const callbacks = new Map();
    let seq = 0;
    const fakeSetTimeout = (fn, delay) => {
      const id = ++seq;
      callbacks.set(id, { fn, delay });
      return id;
    };
    const fakeClearTimeout = (id) => { callbacks.delete(id); };
    const flush = (id) => {
      const entry = callbacks.get(id);
      if (entry) { callbacks.delete(id); entry.fn(); }
    };
    const pending = () => [...callbacks.keys()];
    const delayOf = (id) => { const e = callbacks.get(id); return e ? e.delay : undefined; };
    return { fakeSetTimeout, fakeClearTimeout, flush, pending, delayOf, seq: () => seq };
  }

  test('fires after delay', () => {
    const t = makeFakeTimers();
    const calls = [];
    const fn = (...args) => calls.push(args);
    const d = S.makeDebounced(fn, 300, { setTimeout: t.fakeSetTimeout, clearTimeout: t.fakeClearTimeout });

    d('a');
    assert.equal(t.pending().length, 1);
    t.flush(t.pending()[0]);
    assert.deepEqual(calls, [['a']]);
  });

  test('coalesces multiple rapid calls — only last fires', () => {
    const t = makeFakeTimers();
    const calls = [];
    const d = S.makeDebounced((...args) => calls.push(args), 300,
      { setTimeout: t.fakeSetTimeout, clearTimeout: t.fakeClearTimeout });

    d('first');
    d('second');
    d('third');

    // Only one timer should be pending (previous ones cancelled)
    assert.equal(t.pending().length, 1);
    t.flush(t.pending()[0]);
    assert.deepEqual(calls, [['third']]);
  });

  test('cancel() prevents firing', () => {
    const t = makeFakeTimers();
    const calls = [];
    const d = S.makeDebounced((...args) => calls.push(args), 300,
      { setTimeout: t.fakeSetTimeout, clearTimeout: t.fakeClearTimeout });

    d('hello');
    d.cancel();
    assert.equal(t.pending().length, 0);
    assert.deepEqual(calls, []);
  });

  test('can fire multiple times independently', () => {
    const t = makeFakeTimers();
    const calls = [];
    const d = S.makeDebounced((...args) => calls.push(args), 300,
      { setTimeout: t.fakeSetTimeout, clearTimeout: t.fakeClearTimeout });

    d('first');
    t.flush(t.pending()[0]);
    d('second');
    t.flush(t.pending()[0]);

    assert.deepEqual(calls, [['first'], ['second']]);
  });

  test('cancel() is safe to call when nothing is pending', () => {
    const t = makeFakeTimers();
    const d = S.makeDebounced(() => {}, 300, { setTimeout: t.fakeSetTimeout, clearTimeout: t.fakeClearTimeout });
    assert.doesNotThrow(() => d.cancel());
  });

  test('delayMs may be a zero-arg function — its return value is used as the actual delay', () => {
    const t = makeFakeTimers();
    let currentDelay = 500;
    const d = S.makeDebounced(() => {}, () => currentDelay,
      { setTimeout: t.fakeSetTimeout, clearTimeout: t.fakeClearTimeout });

    d();
    assert.equal(t.delayOf(t.pending()[0]), 500);
  });

  test('a function delayMs is re-invoked on every call, not cached from the first', () => {
    const t = makeFakeTimers();
    let currentDelay = 100;
    const calls = [];
    const d = S.makeDebounced((...args) => calls.push(args), () => currentDelay,
      { setTimeout: t.fakeSetTimeout, clearTimeout: t.fakeClearTimeout });

    d('first');
    assert.equal(t.delayOf(t.pending()[0]), 100);
    t.flush(t.pending()[0]);

    currentDelay = 250; // simulates e.g. appState.config having changed/loaded since
    d('second');
    assert.equal(t.delayOf(t.pending()[0]), 250);
    t.flush(t.pending()[0]);

    assert.deepEqual(calls, [['first'], ['second']]);
  });
});
