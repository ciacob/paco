'use strict';

/**
 * test/watcher-state.test.js
 *
 * Tests for paco/watcher-state.js using Node.js v22 built-in test runner.
 * All tests are pure — no fs.watch, no WS, no timers (fake timers injected).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const W = require('../paco/watcher-state');

// ─── normalisePath ────────────────────────────────────────────────────────────

describe('normalisePath', () => {
  test('strips trailing slash', () => {
    assert.equal(W.normalisePath('/home/user/docs/'), '/home/user/docs');
  });

  test('strips trailing backslash', () => {
    assert.equal(W.normalisePath('/home/user/docs\\'), '/home/user/docs');
  });

  test('no-op on clean path', () => {
    assert.equal(W.normalisePath('/home/user'), '/home/user');
  });

  test('empty string stays empty', () => {
    assert.equal(W.normalisePath(''), '');
  });

  test('null/undefined returns empty string', () => {
    assert.equal(W.normalisePath(null), '');
    assert.equal(W.normalisePath(undefined), '');
  });

  test('multiple trailing slashes stripped', () => {
    assert.equal(W.normalisePath('/home/user///'), '/home/user');
  });
});

// ─── affectedPanels ───────────────────────────────────────────────────────────

describe('affectedPanels', () => {
  const panels = { left: '/home/user/docs', right: '/home/user/music' };

  test('matches left panel', () => {
    assert.deepEqual(W.affectedPanels('/home/user/docs', panels), ['left']);
  });

  test('matches right panel', () => {
    assert.deepEqual(W.affectedPanels('/home/user/music', panels), ['right']);
  });

  test('matches both panels when same path', () => {
    const both = { left: '/home/user', right: '/home/user' };
    assert.deepEqual(W.affectedPanels('/home/user', both), ['left', 'right']);
  });

  test('returns empty when no match', () => {
    assert.deepEqual(W.affectedPanels('/home/user/other', panels), []);
  });

  test('trailing slash on changed path is normalised', () => {
    assert.deepEqual(W.affectedPanels('/home/user/docs/', panels), ['left']);
  });

  test('trailing slash on panel path is normalised', () => {
    const trailingPanels = { left: '/home/user/docs/', right: '/home/user/music/' };
    assert.deepEqual(W.affectedPanels('/home/user/docs', trailingPanels), ['left']);
  });
});

// ─── diffWatchSet ─────────────────────────────────────────────────────────────

describe('diffWatchSet', () => {
  test('adds both paths when set is empty', () => {
    const { toAdd, toRemove } = W.diffWatchSet(
      new Set(),
      { left: '/a', right: '/b' }
    );
    assert.deepEqual(toAdd.sort(), ['/a', '/b'].sort());
    assert.deepEqual(toRemove, []);
  });

  test('removes paths no longer in panels', () => {
    const { toAdd, toRemove } = W.diffWatchSet(
      new Set(['/a', '/b']),
      { left: '/c', right: '/b' }
    );
    assert.deepEqual(toAdd, ['/c']);
    assert.deepEqual(toRemove, ['/a']);
  });

  test('no change when paths unchanged', () => {
    const { toAdd, toRemove } = W.diffWatchSet(
      new Set(['/a', '/b']),
      { left: '/a', right: '/b' }
    );
    assert.deepEqual(toAdd, []);
    assert.deepEqual(toRemove, []);
  });

  test('deduplicates when both panels show same path', () => {
    const { toAdd, toRemove } = W.diffWatchSet(
      new Set(),
      { left: '/same', right: '/same' }
    );
    assert.deepEqual(toAdd, ['/same']);  // only one watcher needed
    assert.deepEqual(toRemove, []);
  });

  test('handles empty panel paths gracefully', () => {
    const { toAdd, toRemove } = W.diffWatchSet(
      new Set(['/a']),
      { left: '', right: '/b' }
    );
    assert.ok(toAdd.includes('/b'));
    assert.ok(toRemove.includes('/a'));
    // empty string should not be added as a watch target
    assert.ok(!toAdd.includes(''));
  });
});

// ─── shouldRefresh ────────────────────────────────────────────────────────────

describe('shouldRefresh', () => {
  test('returns true when idle + ready + panel matched', () => {
    assert.equal(W.shouldRefresh('idle', 'ready', ['left']), true);
  });

  test('returns false when worker is not idle', () => {
    assert.equal(W.shouldRefresh('running', 'ready', ['left']), false);
    assert.equal(W.shouldRefresh('done',    'ready', ['left']), false);
    assert.equal(W.shouldRefresh('error',   'ready', ['left']), false);
  });

  test('returns false during boot', () => {
    assert.equal(W.shouldRefresh('idle', 'idle',          ['left']), false);
    assert.equal(W.shouldRefresh('idle', 'booting-left',  ['left']), false);
    assert.equal(W.shouldRefresh('idle', 'booting-right', ['left']), false);
  });

  test('returns false when no panels affected', () => {
    assert.equal(W.shouldRefresh('idle', 'ready', []), false);
  });

  test('returns true for either panel', () => {
    assert.equal(W.shouldRefresh('idle', 'ready', ['right']), true);
    assert.equal(W.shouldRefresh('idle', 'ready', ['left', 'right']), true);
  });
});

// ─── makeDebounced ────────────────────────────────────────────────────────────

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
    return { fakeSetTimeout, fakeClearTimeout, flush, pending, seq: () => seq };
  }

  test('fires after delay', () => {
    const t = makeFakeTimers();
    const calls = [];
    const fn = (...args) => calls.push(args);
    const d = W.makeDebounced(fn, 300, { setTimeout: t.fakeSetTimeout, clearTimeout: t.fakeClearTimeout });

    d('a');
    assert.equal(t.pending().length, 1);
    t.flush(t.pending()[0]);
    assert.deepEqual(calls, [['a']]);
  });

  test('coalesces multiple rapid calls — only last fires', () => {
    const t = makeFakeTimers();
    const calls = [];
    const d = W.makeDebounced((...args) => calls.push(args), 300,
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
    const d = W.makeDebounced((...args) => calls.push(args), 300,
      { setTimeout: t.fakeSetTimeout, clearTimeout: t.fakeClearTimeout });

    d('hello');
    d.cancel();
    assert.equal(t.pending().length, 0);
    assert.deepEqual(calls, []);
  });

  test('can fire multiple times independently', () => {
    const t = makeFakeTimers();
    const calls = [];
    const d = W.makeDebounced((...args) => calls.push(args), 300,
      { setTimeout: t.fakeSetTimeout, clearTimeout: t.fakeClearTimeout });

    d('first');
    t.flush(t.pending()[0]);
    d('second');
    t.flush(t.pending()[0]);

    assert.deepEqual(calls, [['first'], ['second']]);
  });
});
