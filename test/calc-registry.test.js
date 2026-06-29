'use strict';

/**
 * test/calc-registry.test.js
 *
 * Tests for paco/calc-registry.js — a trivial Map wrapper, but worth
 * testing directly since calc-size.js and cancel-calc.js both depend on
 * its exact semantics (register/get/remove, and that re-requiring the
 * module returns the SAME instance within one process, which is what
 * makes it work as shared state between separate task invocations).
 */

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const registry = require('../paco/calc-registry');

// Fake "child process" — registry only ever stores/retrieves whatever is
// passed in, so a plain object stands in fine for these tests.
function fakeChild(label) {
  return { label };
}

describe('calc-registry', () => {
  beforeEach(() => {
    // Drain whatever might be left over from a previous test in this file
    // (registry is a real module-level singleton, not reset between tests).
    for (const id of ['t1', 't2', 't3', 'dup-id', 'missing']) {
      registry.remove(id);
    }
  });

  test('register then get returns the same child', () => {
    const child = fakeChild('a');
    registry.register('t1', child);
    assert.equal(registry.get('t1'), child);
  });

  test('get on an unknown id returns undefined', () => {
    assert.equal(registry.get('missing'), undefined);
  });

  test('remove deletes the entry', () => {
    registry.register('t1', fakeChild('a'));
    registry.remove('t1');
    assert.equal(registry.get('t1'), undefined);
  });

  test('remove on an unknown id does not throw', () => {
    assert.doesNotThrow(() => registry.remove('missing'));
  });

  test('size reflects the current entry count', () => {
    const before = registry.size();
    registry.register('t1', fakeChild('a'));
    registry.register('t2', fakeChild('b'));
    assert.equal(registry.size(), before + 2);
    registry.remove('t1');
    assert.equal(registry.size(), before + 1);
    registry.remove('t2');
    assert.equal(registry.size(), before);
  });

  test('registering a second child under the same id overwrites the first', () => {
    const first  = fakeChild('first');
    const second = fakeChild('second');
    registry.register('dup-id', first);
    registry.register('dup-id', second);
    assert.equal(registry.get('dup-id'), second);
    registry.remove('dup-id');
  });

  test('re-requiring the module returns the same singleton instance', () => {
    registry.register('t3', fakeChild('persisted'));
    // Node's require() cache means this is the same module instance, not
    // a fresh one — exactly the property calc-size.js/cancel-calc.js rely
    // on to find each other's registrations across separate task calls.
    const reRequired = require('../paco/calc-registry');
    assert.equal(reRequired.get('t3').label, 'persisted');
    registry.remove('t3');
  });
});
