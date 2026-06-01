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
    assert.ok(s.panels.left);
    assert.ok(s.panels.right);
    assert.equal(s.config.theme, 'dark');
  });

  test('overrides are applied shallowly', () => {
    const s = S.makeAppState({ activePanel: 'right', busy: true });
    assert.equal(s.activePanel, 'right');
    assert.equal(s.busy, true);
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
  test('0 → empty string', () => assert.equal(S.fmtSize(0), ''));
  test('null/undefined → empty string', () => {
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
