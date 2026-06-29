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
