'use strict';

/**
 * test/child-process-registry.test.js
 *
 * Tests for paco/child-process-registry.js — the factory extracted from
 * the original calc-registry.js so a second caller (extraction jobs)
 * could get the exact same semantics without sharing state with calc's
 * own registry. See test/calc-registry.test.js for calc-registry.js's own
 * (unchanged) behavioral contract; this file covers the factory itself
 * plus the one property that matters most for two independent callers:
 * that separate createChildProcessRegistry() calls never see each other's
 * entries.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createChildProcessRegistry } = require('../paco/child-process-registry');

function fakeChild(label) {
  return { label };
}

describe('createChildProcessRegistry', () => {
  test('register then get returns the same child', () => {
    const registry = createChildProcessRegistry();
    const child = fakeChild('a');
    registry.register('t1', child);
    assert.equal(registry.get('t1'), child);
  });

  test('get on an unknown id returns undefined', () => {
    const registry = createChildProcessRegistry();
    assert.equal(registry.get('missing'), undefined);
  });

  test('remove deletes the entry', () => {
    const registry = createChildProcessRegistry();
    registry.register('t1', fakeChild('a'));
    registry.remove('t1');
    assert.equal(registry.get('t1'), undefined);
  });

  test('remove on an unknown id does not throw', () => {
    const registry = createChildProcessRegistry();
    assert.doesNotThrow(() => registry.remove('missing'));
  });

  test('size reflects the current entry count', () => {
    const registry = createChildProcessRegistry();
    assert.equal(registry.size(), 0);
    registry.register('t1', fakeChild('a'));
    registry.register('t2', fakeChild('b'));
    assert.equal(registry.size(), 2);
    registry.remove('t1');
    assert.equal(registry.size(), 1);
  });

  test('registering a second child under the same id overwrites the first', () => {
    const registry = createChildProcessRegistry();
    registry.register('dup-id', fakeChild('first'));
    registry.register('dup-id', fakeChild('second'));
    assert.equal(registry.get('dup-id').label, 'second');
  });

  test('two separately-created registries never see each other\'s entries', () => {
    const a = createChildProcessRegistry();
    const b = createChildProcessRegistry();
    a.register('same-id', fakeChild('from-a'));
    assert.equal(b.get('same-id'), undefined);
    assert.equal(a.size(), 1);
    assert.equal(b.size(), 0);
  });
});

describe('paco/calc-registry.js and paco/extract-registry.js — independent singletons', () => {
  test('are distinct instances that do not share state', () => {
    const calcRegistry    = require('../paco/calc-registry');
    const extractRegistry = require('../paco/extract-registry');

    calcRegistry.register('shared-name', fakeChild('calc-side'));
    assert.equal(extractRegistry.get('shared-name'), undefined);

    extractRegistry.register('shared-name', fakeChild('extract-side'));
    assert.equal(calcRegistry.get('shared-name').label, 'calc-side');
    assert.equal(extractRegistry.get('shared-name').label, 'extract-side');

    calcRegistry.remove('shared-name');
    extractRegistry.remove('shared-name');
  });
});
