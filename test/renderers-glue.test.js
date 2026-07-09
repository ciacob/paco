'use strict';

/**
 * test/renderers-glue.test.js
 *
 * Tests for every paco/renderers/<name>/glue.js. Each glue module is a
 * pure function returning a plain description of which extractor module
 * to load and how to call it — no I/O, no child process, no filesystem
 * access beyond require.resolve()'s own path resolution (which doesn't
 * execute the target module). Covered together in one file since each
 * is a handful of lines; also confirms the folders declared as sharing
 * one implementation (formatted-document/-plain, thumbnail/-svg,
 * filmstrip/waveform) actually resolve to the exact same module.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

describe('generic-text/glue.js and generic-binary/glue.js', () => {
  test('generic-text builds isText:true', () => {
    const { buildInvocation } = require('../paco/renderers/generic-text/glue');
    const plan = buildInvocation();
    assert.match(plan.modulePath, /genericExtractor\.js$/);
    assert.equal(plan.exportName, 'getGenericPreview');
    assert.deepEqual(plan.fixedArgs, [true, {}]);
  });

  test('generic-binary builds isText:false', () => {
    const { buildInvocation } = require('../paco/renderers/generic-binary/glue');
    const plan = buildInvocation();
    assert.match(plan.modulePath, /genericExtractor\.js$/);
    assert.equal(plan.exportName, 'getGenericPreview');
    assert.deepEqual(plan.fixedArgs, [false, {}]);
  });

  test('both resolve to the exact same generic-extractor module path', () => {
    const text = require('../paco/renderers/generic-text/glue').buildInvocation();
    const bin  = require('../paco/renderers/generic-binary/glue').buildInvocation();
    assert.equal(text.modulePath, bin.modulePath);
  });
});

describe('formatted-document/glue.js and formatted-document-plain/glue.js', () => {
  test('both are the exact same shared implementation', () => {
    const a = require('../paco/renderers/formatted-document/glue');
    const b = require('../paco/renderers/formatted-document-plain/glue');
    assert.equal(a, b, 'both should re-export the identical shared module (same object reference)');
  });

  test('buildInvocation(ext) passes the extension through as fileType, unmodified', () => {
    const { buildInvocation } = require('../paco/renderers/formatted-document/glue');
    const plan = buildInvocation('docx');
    assert.match(plan.modulePath, /textExtractor\.js$/);
    assert.equal(plan.exportName, 'getDocumentPreview');
    assert.deepEqual(plan.fixedArgs, ['docx', {}]);
  });

  test('works identically for a text-mode format (md)', () => {
    const { buildInvocation } = require('../paco/renderers/formatted-document-plain/glue');
    const plan = buildInvocation('md');
    assert.deepEqual(plan.fixedArgs, ['md', {}]);
  });
});

describe('thumbnail/glue.js and thumbnail-svg/glue.js', () => {
  test('both are the exact same shared implementation', () => {
    const a = require('../paco/renderers/thumbnail/glue');
    const b = require('../paco/renderers/thumbnail-svg/glue');
    assert.equal(a, b);
  });

  test('buildInvocation(ext) always requests html output', () => {
    const { buildInvocation } = require('../paco/renderers/thumbnail/glue');
    const plan = buildInvocation('png');
    assert.match(plan.modulePath, /imageExtractor\.js$/);
    assert.equal(plan.exportName, 'getImageThumbnail');
    assert.deepEqual(plan.fixedArgs, ['png', { output: 'html' }]);
  });

  test('svg goes through the same builder identically', () => {
    const { buildInvocation } = require('../paco/renderers/thumbnail-svg/glue');
    const plan = buildInvocation('svg');
    assert.deepEqual(plan.fixedArgs, ['svg', { output: 'html' }]);
  });
});

describe('filmstrip/glue.js and waveform/glue.js', () => {
  test('both are the exact same shared implementation', () => {
    const a = require('../paco/renderers/filmstrip/glue');
    const b = require('../paco/renderers/waveform/glue');
    assert.equal(a, b);
  });

  test('buildInvocation(ext) always requests html output, regardless of guessed kind', () => {
    const { buildInvocation } = require('../paco/renderers/filmstrip/glue');
    const videoPlan = buildInvocation('mp4');
    const audioPlan = require('../paco/renderers/waveform/glue').buildInvocation('mp3');
    assert.match(videoPlan.modulePath, /mediaExtractor\.js$/);
    assert.equal(videoPlan.modulePath, audioPlan.modulePath, 'identical module regardless of which tab guessed');
    assert.equal(videoPlan.exportName, 'getMediaPreview');
    assert.deepEqual(videoPlan.fixedArgs, ['mp4', { output: 'html' }]);
    assert.deepEqual(audioPlan.fixedArgs, ['mp3', { output: 'html' }]);
  });
});

describe('every glue module\'s modulePath actually resolves to a real, loadable file', () => {
  const glueModules = [
    '../paco/renderers/generic-text/glue',
    '../paco/renderers/generic-binary/glue',
    '../paco/renderers/formatted-document/glue',
    '../paco/renderers/formatted-document-plain/glue',
    '../paco/renderers/thumbnail/glue',
    '../paco/renderers/thumbnail-svg/glue',
    '../paco/renderers/filmstrip/glue',
    '../paco/renderers/waveform/glue',
  ];

  for (const gluePath of glueModules) {
    test(`${gluePath} resolves and loads its target module without throwing`, () => {
      const { buildInvocation } = require(gluePath);
      // Args don't matter for this check — any extension/no-arg call
      // still yields a modulePath; the real assertion is that requiring
      // it succeeds and exposes the declared exportName.
      const plan = buildInvocation('x');
      const mod = require(plan.modulePath);
      assert.equal(typeof mod[plan.exportName], 'function', `${plan.exportName} should be a function on the target module`);
    });
  }
});
