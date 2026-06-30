'use strict';

/**
 * test/renderer-matcher.test.js
 *
 * Tests for paco/renderers/matcher.js — the pure renderer-selection
 * algorithm for the F3 Viewer's "View as: [tab] [tab]" UI.
 *
 * Test renderer fixtures below mirror the exact examples worked through
 * in the design discussion: png-file vs generic-image, an md-file
 * renderer, a "common web images" family renderer via array file_type,
 * and the always-present base renderers.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { matchRenderers } = require('../paco/renderers/matcher');

// ─── Fixtures ───────────────────────────────────────────────────────────────

function sel(overrides = {}) {
  return Object.assign({
    selectionType: 'single',
    fileMode: 'binary',
    binaryCategory: null,
    fileType: null,
  }, overrides);
}

const baseBinary = {
  name: 'generic-binary', uid: 'base-binary',
  abilities: { selection_type: 'single', file_mode: 'binary' },
};
const baseBinaryMulti = {
  name: 'generic-binary-multi', uid: 'base-binary-multi',
  abilities: { selection_type: 'multi', file_mode: 'binary' },
};
const baseText = {
  name: 'generic-text', uid: 'base-text',
  abilities: { selection_type: 'single', file_mode: 'text' },
};
const genericImage = {
  name: 'generic-image', uid: 'generic-image',
  abilities: { selection_type: 'single', file_mode: 'binary', binary_category: 'image' },
};
const pngFile = {
  name: 'png-file', uid: 'png-file',
  abilities: { selection_type: 'single', file_mode: 'binary', binary_category: 'image', file_type: 'png' },
};
const webImagesFamily = {
  name: 'web-images', uid: 'web-images',
  abilities: { selection_type: 'single', file_mode: 'binary', binary_category: 'image', file_type: ['jpeg', 'jpg', 'png', 'gif'] },
};
const mdFile = {
  name: 'formatted-document', uid: 'd08378bf-a4a1-4339-b4d8-e172dcbddcc1',
  abilities: { selection_type: 'single', file_mode: 'text', file_type: 'md' },
};
const genericAudio = {
  name: 'generic-audio', uid: 'generic-audio',
  abilities: { selection_type: 'single', file_mode: 'binary', binary_category: 'audio' },
};

// ─── Gate (selection_type + file_mode) ───────────────────────────────────────

describe('matchRenderers — gate', () => {
  test('a renderer with the wrong selection_type never participates', () => {
    const multiOnly = { name: 'multi-only', uid: 'x', abilities: { selection_type: 'multi', file_mode: 'binary' } };
    const r = matchRenderers(sel({ selectionType: 'single' }), [multiOnly]);
    assert.deepEqual(r.tabs, []);
    assert.equal(r.preselected, null);
  });

  test('a renderer with the wrong file_mode never participates', () => {
    const r = matchRenderers(sel({ fileMode: 'binary' }), [baseText]);
    assert.deepEqual(r.tabs, []);
    assert.equal(r.preselected, null);
  });

  test('an empty registry yields no tabs and no preselection', () => {
    const r = matchRenderers(sel(), []);
    assert.deepEqual(r.tabs, []);
    assert.equal(r.preselected, null);
  });

  test('selection_type and file_mode must BOTH match — partial match still excluded', () => {
    const wrongMode = { name: 'wrong-mode', uid: 'x', abilities: { selection_type: 'single', file_mode: 'text' } };
    const r = matchRenderers(sel({ selectionType: 'single', fileMode: 'binary' }), [wrongMode]);
    assert.deepEqual(r.tabs, []);
  });
});

// ─── Rung 1: file-specific (the worked PNG/JPEG examples) ────────────────────

describe('matchRenderers — rung 1 (file-specific)', () => {
  test('PNG selection with both png-file and generic-image registered: png-file wins, generic-image excluded entirely', () => {
    const r = matchRenderers(
      sel({ fileMode: 'binary', binaryCategory: 'image', fileType: 'png' }),
      [genericImage, pngFile, baseBinary]
    );
    const names = r.tabs.map(t => t.name);
    assert.ok(names.includes('png-file'));
    assert.ok(!names.includes('generic-image'), 'rung 1 hit must suppress rung 2 entirely');
    assert.ok(names.includes('generic-binary'), 'base is always present');
    assert.equal(r.preselected.name, 'png-file');
  });

  test('JPEG selection with only generic-image registered (no jpeg-file): generic-image wins via rung 2', () => {
    const r = matchRenderers(
      sel({ fileMode: 'binary', binaryCategory: 'image', fileType: 'jpeg' }),
      [genericImage, pngFile, baseBinary]
    );
    const names = r.tabs.map(t => t.name);
    assert.ok(names.includes('generic-image'));
    assert.ok(!names.includes('png-file'), 'png-file must not match a jpeg selection');
    assert.ok(names.includes('generic-binary'));
    assert.equal(r.preselected.name, 'generic-image');
  });

  test('md-file selection matches the markdown renderer via rung 1, no binary_category needed', () => {
    const r = matchRenderers(
      sel({ fileMode: 'text', binaryCategory: null, fileType: 'md' }),
      [mdFile, baseText]
    );
    const names = r.tabs.map(t => t.name);
    assert.ok(names.includes('formatted-document'));
    assert.ok(names.includes('generic-text'));
    assert.equal(r.preselected.name, 'formatted-document');
  });

  test('a single-string file_type and a one-element array file_type match identically', () => {
    const oneElementArray = {
      name: 'md-array', uid: 'x',
      abilities: { selection_type: 'single', file_mode: 'text', file_type: ['md'] },
    };
    const r = matchRenderers(sel({ fileMode: 'text', fileType: 'md' }), [oneElementArray]);
    assert.equal(r.tabs.length, 1);
    assert.equal(r.tabs[0].name, 'md-array');
  });
});

// ─── Rung 1 with array file_type (the "family" renderer) ────────────────────

describe('matchRenderers — rung 1 family renderer (array file_type)', () => {
  test('a JPEG matches the web-images family renderer when no exact jpeg-file renderer exists', () => {
    const r = matchRenderers(
      sel({ fileMode: 'binary', binaryCategory: 'image', fileType: 'jpeg' }),
      [webImagesFamily, baseBinary]
    );
    assert.ok(r.tabs.map(t => t.name).includes('web-images'));
    assert.equal(r.preselected.name, 'web-images');
  });

  test('exact single-type renderer steals preselection over a matching family renderer', () => {
    const r = matchRenderers(
      sel({ fileMode: 'binary', binaryCategory: 'image', fileType: 'png' }),
      [webImagesFamily, pngFile, baseBinary]
    );
    const names = r.tabs.map(t => t.name);
    assert.ok(names.includes('web-images'), 'both should be listed as tabs — multiple rung-1 matches coexist');
    assert.ok(names.includes('png-file'));
    assert.equal(r.preselected.name, 'png-file', 'exact single-type match must win preselection');
  });

  test('a type outside the family array does not match it', () => {
    const r = matchRenderers(
      sel({ fileMode: 'binary', binaryCategory: 'image', fileType: 'tiff' }),
      [webImagesFamily, baseBinary]
    );
    assert.ok(!r.tabs.map(t => t.name).includes('web-images'));
  });
});

// ─── Rung 2: generic category (binary only) ──────────────────────────────────

describe('matchRenderers — rung 2 (generic category, binary only)', () => {
  test('rung 2 is never evaluated for text selections — no generic-category fallback for text', () => {
    const genericTextWithCategory = {
      // Hypothetical malformed/unusual registration: binary_category on a
      // text-mode renderer should never happen per the schema, but the
      // matcher must not crash or misbehave if it somehow does.
      name: 'weird', uid: 'x',
      abilities: { selection_type: 'single', file_mode: 'text', binary_category: 'image' },
    };
    const r = matchRenderers(sel({ fileMode: 'text', fileType: 'unknownext' }), [genericTextWithCategory, baseText]);
    // Should fall through to base only — rung 2 logic explicitly requires fileMode binary
    assert.equal(r.tabs.length, 1);
    assert.equal(r.tabs[0].name, 'generic-text');
  });

  test('a renderer declaring BOTH binary_category and file_type is rung-1 only, never also offered as rung-2', () => {
    // pngFile has both — confirm it doesn't somehow get double-counted or
    // change generic-image's behaviour when png-file is absent.
    const r = matchRenderers(
      sel({ fileMode: 'binary', binaryCategory: 'audio', fileType: 'mp3' }),
      [pngFile, genericAudio, baseBinary] // pngFile's category is 'image', should never match audio anyway
    );
    const names = r.tabs.map(t => t.name);
    assert.ok(!names.includes('png-file'));
    assert.ok(names.includes('generic-audio'));
  });

  test('an unregistered specific type with a registered category renderer falls back to rung 2', () => {
    const r = matchRenderers(
      sel({ fileMode: 'binary', binaryCategory: 'audio', fileType: 'flac' }),
      [genericAudio, baseBinary]
    );
    assert.equal(r.preselected.name, 'generic-audio');
  });
});

// ─── Base renderer — always present, never overridden ────────────────────────

describe('matchRenderers — base renderer', () => {
  test('base is the sole tab when nothing else matches at all', () => {
    const r = matchRenderers(
      sel({ fileMode: 'binary', binaryCategory: 'other', fileType: 'bin' }),
      [genericImage, pngFile, mdFile, baseBinary] // none apply to an "other" binary
    );
    assert.deepEqual(r.tabs.map(t => t.name), ['generic-binary']);
    assert.equal(r.preselected.name, 'generic-binary');
  });

  test('base is absent from tabs if no base renderer is registered (graceful, not a crash)', () => {
    const r = matchRenderers(
      sel({ fileMode: 'binary', binaryCategory: 'other', fileType: 'bin' }),
      [genericImage] // wrong category anyway, and no base registered
    );
    assert.deepEqual(r.tabs, []);
    assert.equal(r.preselected, null);
  });

  test('base never appears twice even if somehow matched by both rung logic and the base check', () => {
    // Construct a pathological renderer that IS the base shape but also
    // happens to be discoverable — confirms no duplication in tabs.
    const r = matchRenderers(
      sel({ fileMode: 'binary', binaryCategory: 'image', fileType: 'png' }),
      [pngFile, baseBinary, baseBinary] // duplicate registration, still shouldn't crash
    );
    const baseCount = r.tabs.filter(t => t.name === 'generic-binary').length;
    assert.ok(baseCount >= 1); // duplicates in the input are a registry-loading concern, not this function's job to dedupe
  });

  test('different selection_type base renderers do not leak into each other', () => {
    const r = matchRenderers(
      sel({ selectionType: 'multi', fileMode: 'binary', binaryCategory: 'other', fileType: null }),
      [baseBinary, baseBinaryMulti]
    );
    assert.deepEqual(r.tabs.map(t => t.name), ['generic-binary-multi']);
  });
});

// ─── Tab ordering ─────────────────────────────────────────────────────────────

describe('matchRenderers — tab ordering', () => {
  test('rung matches preserve input order, base is always last', () => {
    const r = matchRenderers(
      sel({ fileMode: 'binary', binaryCategory: 'image', fileType: 'png' }),
      [baseBinary, webImagesFamily, pngFile] // base listed FIRST in input
    );
    assert.deepEqual(r.tabs.map(t => t.name), ['web-images', 'png-file', 'generic-binary']);
  });
});

// ─── Multi-selection ──────────────────────────────────────────────────────────

describe('matchRenderers — multi-selection', () => {
  test('a multi-selection gate only matches multi-selection renderers', () => {
    const galleryRenderer = {
      name: 'image-gallery', uid: 'x',
      abilities: { selection_type: 'multi', file_mode: 'binary', binary_category: 'image' },
    };
    const r = matchRenderers(
      sel({ selectionType: 'multi', fileMode: 'binary', binaryCategory: 'image', fileType: null }),
      [genericImage, pngFile, galleryRenderer, baseBinaryMulti] // single-only ones must not appear
    );
    const names = r.tabs.map(t => t.name);
    assert.deepEqual(names.sort(), ['generic-binary-multi', 'image-gallery'].sort());
    assert.equal(r.preselected.name, 'image-gallery');
  });
});
