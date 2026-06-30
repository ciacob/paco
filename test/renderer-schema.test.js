'use strict';

/**
 * test/renderer-schema.test.js
 *
 * Tests for paco/renderers/renderer.schema.json — validates the schema
 * itself compiles under ajv strict mode (catches schema-authoring bugs,
 * not just instance-document bugs), then exercises every rule settled in
 * the renderer-matching design discussion against real validation, both
 * accept and reject cases.
 *
 * This schema validates ONE renderer.json document in isolation —
 * registry-level concerns (uid uniqueness across the whole set, a base
 * renderer existing per file_mode) are explicitly out of scope, per the
 * schema's own description field, and are not tested here.
 */

const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const Ajv = require('ajv/dist/2020');
const addFormats = require('ajv-formats');

let validate;

before(() => {
  const schema = require(path.join('..', 'paco', 'renderers', 'renderer.schema.json'));
  const ajv = new Ajv({ allErrors: true, strict: true });
  addFormats(ajv);
  validate = ajv.compile(schema); // throws if the schema itself is malformed
});

function isValid(doc) {
  return validate(doc);
}

const UID_A = 'd08378bf-a4a1-4339-b4d8-e172dcbddcc1';
const UID_B = 'd08378bf-a4a1-4339-b4d8-e172dcbddcc2';

describe('renderer.schema.json — schema compiles cleanly under ajv strict mode', () => {
  test('compiling does not throw (catches schema-authoring bugs like the strict-mode required/not issue found during design)', () => {
    // The before() hook above already compiled it — if it had thrown, this
    // whole file would have failed to run at all. This test exists so a
    // future schema edit that breaks compilation fails loudly and
    // specifically, rather than as a confusing wholesale test-file crash.
    assert.equal(typeof validate, 'function');
  });
});

describe('renderer.schema.json — accepts every worked example from the design discussion', () => {
  test('generic-image: rung-2 generic-category renderer', () => {
    assert.ok(isValid({
      name: 'generic-image', description: 'Renders any image generically', uid: UID_A,
      abilities: { selection_type: 'single', file_mode: 'binary', binary_category: 'image' },
    }), JSON.stringify(validate.errors));
  });

  test('png-file: rung-1 single-string file_type, with informational binary_category', () => {
    assert.ok(isValid({
      name: 'png-file', description: 'Renders PNG images', uid: UID_B,
      abilities: { selection_type: 'single', file_mode: 'binary', binary_category: 'image', file_type: 'png' },
    }), JSON.stringify(validate.errors));
  });

  test('formatted-document: text-mode file_type, no binary_category needed', () => {
    assert.ok(isValid({
      name: 'formatted-document', description: 'Renders Markdown as HTML', uid: UID_A,
      abilities: { selection_type: 'single', file_mode: 'text', file_type: 'md' },
    }), JSON.stringify(validate.errors));
  });

  test('web-images: array file_type for a closely-related family', () => {
    assert.ok(isValid({
      name: 'web-images', description: 'Common web image formats', uid: UID_A,
      abilities: { selection_type: 'single', file_mode: 'binary', binary_category: 'image', file_type: ['jpeg', 'jpg', 'png', 'gif'] },
    }), JSON.stringify(validate.errors));
  });

  test('base binary renderer: only the two hard gates, nothing more', () => {
    assert.ok(isValid({
      name: 'generic-binary', description: 'Generic binary fallback', uid: UID_A,
      abilities: { selection_type: 'single', file_mode: 'binary' },
    }), JSON.stringify(validate.errors));
  });

  test('base text renderer: only the two hard gates, nothing more', () => {
    assert.ok(isValid({
      name: 'generic-text', description: 'Generic text fallback', uid: UID_A,
      abilities: { selection_type: 'single', file_mode: 'text' },
    }), JSON.stringify(validate.errors));
  });

  test('a multi-selection renderer', () => {
    assert.ok(isValid({
      name: 'image-gallery', description: 'Gallery view for multiple images', uid: UID_A,
      abilities: { selection_type: 'multi', file_mode: 'binary', binary_category: 'image' },
    }), JSON.stringify(validate.errors));
  });
});

describe('renderer.schema.json — required fields', () => {
  test('rejects a document missing uid', () => {
    assert.equal(isValid({
      name: 'x', description: 'x',
      abilities: { selection_type: 'single', file_mode: 'binary' },
    }), false);
  });

  test('rejects a document missing description', () => {
    assert.equal(isValid({
      name: 'x', uid: UID_A,
      abilities: { selection_type: 'single', file_mode: 'binary' },
    }), false);
  });

  test('rejects a document missing name', () => {
    assert.equal(isValid({
      description: 'x', uid: UID_A,
      abilities: { selection_type: 'single', file_mode: 'binary' },
    }), false);
  });

  test('rejects a document missing abilities entirely', () => {
    assert.equal(isValid({ name: 'x', description: 'x', uid: UID_A }), false);
  });

  test('rejects abilities missing selection_type', () => {
    assert.equal(isValid({
      name: 'x', description: 'x', uid: UID_A,
      abilities: { file_mode: 'binary' },
    }), false);
  });

  test('rejects abilities missing file_mode', () => {
    assert.equal(isValid({
      name: 'x', description: 'x', uid: UID_A,
      abilities: { selection_type: 'single' },
    }), false);
  });

  test('rejects an empty name string — must be non-empty, not just present', () => {
    assert.equal(isValid({
      name: '', description: 'x', uid: UID_A,
      abilities: { selection_type: 'single', file_mode: 'binary' },
    }), false);
  });

  test('rejects an empty description string', () => {
    assert.equal(isValid({
      name: 'x', description: '', uid: UID_A,
      abilities: { selection_type: 'single', file_mode: 'binary' },
    }), false);
  });
});

describe('renderer.schema.json — uid format', () => {
  test('rejects a non-UUID uid', () => {
    assert.equal(isValid({
      name: 'x', description: 'x', uid: 'not-a-uuid',
      abilities: { selection_type: 'single', file_mode: 'binary' },
    }), false);
  });

  test('accepts a well-formed UUID', () => {
    assert.ok(isValid({
      name: 'x', description: 'x', uid: '550e8400-e29b-41d4-a716-446655440000',
      abilities: { selection_type: 'single', file_mode: 'binary' },
    }));
  });
});

describe('renderer.schema.json — enum constraints', () => {
  test('rejects an invalid selection_type value', () => {
    assert.equal(isValid({
      name: 'x', description: 'x', uid: UID_A,
      abilities: { selection_type: 'triple', file_mode: 'binary' },
    }), false);
  });

  test('rejects an invalid file_mode value', () => {
    assert.equal(isValid({
      name: 'x', description: 'x', uid: UID_A,
      abilities: { selection_type: 'single', file_mode: 'video' },
    }), false);
  });

  test('rejects an invalid binary_category value', () => {
    assert.equal(isValid({
      name: 'x', description: 'x', uid: UID_A,
      abilities: { selection_type: 'single', file_mode: 'binary', binary_category: 'pdf' },
    }), false);
  });

  test('accepts every valid binary_category value', () => {
    for (const cat of ['image', 'audio', 'video', 'other']) {
      assert.ok(isValid({
        name: 'x', description: 'x', uid: UID_A,
        abilities: { selection_type: 'single', file_mode: 'binary', binary_category: cat },
      }), `binary_category "${cat}" should be valid`);
    }
  });
});

describe('renderer.schema.json — the text/binary_category prohibition', () => {
  test('rejects binary_category declared alongside file_mode "text"', () => {
    assert.equal(isValid({
      name: 'x', description: 'x', uid: UID_A,
      abilities: { selection_type: 'single', file_mode: 'text', binary_category: 'image' },
    }), false);
  });

  test('binary_category is fine alongside file_mode "binary"', () => {
    assert.ok(isValid({
      name: 'x', description: 'x', uid: UID_A,
      abilities: { selection_type: 'single', file_mode: 'binary', binary_category: 'image' },
    }));
  });
});

describe('renderer.schema.json — file_type shape', () => {
  test('accepts a single non-empty string', () => {
    assert.ok(isValid({
      name: 'x', description: 'x', uid: UID_A,
      abilities: { selection_type: 'single', file_mode: 'text', file_type: 'md' },
    }));
  });

  test('rejects an empty string file_type', () => {
    assert.equal(isValid({
      name: 'x', description: 'x', uid: UID_A,
      abilities: { selection_type: 'single', file_mode: 'text', file_type: '' },
    }), false);
  });

  test('accepts a non-empty array of strings', () => {
    assert.ok(isValid({
      name: 'x', description: 'x', uid: UID_A,
      abilities: { selection_type: 'single', file_mode: 'binary', file_type: ['png', 'jpg'] },
    }));
  });

  test('rejects an empty array', () => {
    assert.equal(isValid({
      name: 'x', description: 'x', uid: UID_A,
      abilities: { selection_type: 'single', file_mode: 'binary', file_type: [] },
    }), false);
  });

  test('rejects an array containing an empty string', () => {
    assert.equal(isValid({
      name: 'x', description: 'x', uid: UID_A,
      abilities: { selection_type: 'single', file_mode: 'binary', file_type: ['png', ''] },
    }), false);
  });

  test('rejects file_type as a number', () => {
    assert.equal(isValid({
      name: 'x', description: 'x', uid: UID_A,
      abilities: { selection_type: 'single', file_mode: 'binary', file_type: 42 },
    }), false);
  });

  test('rejects file_type as an array of numbers', () => {
    assert.equal(isValid({
      name: 'x', description: 'x', uid: UID_A,
      abilities: { selection_type: 'single', file_mode: 'binary', file_type: [1, 2] },
    }), false);
  });

  test('file_type is legal under file_mode "text" without any binary_category', () => {
    assert.ok(isValid({
      name: 'x', description: 'x', uid: UID_A,
      abilities: { selection_type: 'single', file_mode: 'text', file_type: 'md' },
    }));
  });
});

describe('renderer.schema.json — no unexpected extra properties', () => {
  test('rejects an unknown top-level property', () => {
    assert.equal(isValid({
      name: 'x', description: 'x', uid: UID_A,
      abilities: { selection_type: 'single', file_mode: 'binary' },
      unexpected: true,
    }), false);
  });

  test('rejects an unknown property inside abilities', () => {
    assert.equal(isValid({
      name: 'x', description: 'x', uid: UID_A,
      abilities: { selection_type: 'single', file_mode: 'binary', made_up_field: 'x' },
    }), false);
  });
});
