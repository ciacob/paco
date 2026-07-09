'use strict';

/**
 * test/renderers-registry.test.js
 *
 * Two things covered here:
 *
 * 1. paco/renderers/registry.js's own load-time invariant checks (uid
 *    uniqueness, base-per-file_mode), exercised against small synthetic
 *    fixture directories built for this test — NOT the real
 *    paco/renderers/ tree, so a bug injected on purpose doesn't require
 *    touching real shipped files.
 *
 * 2. That every REAL, checked-in paco/renderers/<name>/renderer.json
 *    actually validates against renderer.schema.json. This is the gap
 *    test/renderer-schema.test.js deliberately doesn't cover — that file
 *    only exercises the schema against synthetic fixture objects, never
 *    the real shipped manifests. registry.js itself doesn't re-run ajv at
 *    boot (see its own header comment for why), so this test is what
 *    actually catches a real renderer.json drifting out of schema.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('fs');
const os   = require('os');
const path = require('path');

const { loadRenderers, folderForUid } = require('../paco/renderers/registry');

// ─── Synthetic fixture helpers ───────────────────────────────────────────────

function makeTmpRenderersDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'paco-renderers-test-'));
}

function writeRenderer(rootDir, folderName, doc) {
  const dir = path.join(rootDir, folderName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'renderer.json'), JSON.stringify(doc));
}

const baseText = {
  name: 'generic-text', description: 'text base', uid: 'a0000000-0000-0000-0000-000000000001',
  abilities: { selection_type: 'single', file_mode: 'text' },
};
const baseBinary = {
  name: 'generic-binary', description: 'binary base', uid: 'a0000000-0000-0000-0000-000000000002',
  abilities: { selection_type: 'single', file_mode: 'binary' },
};
const pngFile = {
  name: 'thumbnail', description: 'png thumbnail', uid: 'a0000000-0000-0000-0000-000000000003',
  abilities: { selection_type: 'single', file_mode: 'binary', binary_category: 'image', file_type: 'png' },
};

describe('loadRenderers — happy path', () => {
  test('loads every renderer.json found in immediate subdirectories', () => {
    const dir = makeTmpRenderersDir();
    writeRenderer(dir, 'generic-text', baseText);
    writeRenderer(dir, 'generic-binary', baseBinary);
    writeRenderer(dir, 'thumbnail', pngFile);

    const renderers = loadRenderers(dir);
    assert.equal(renderers.length, 3);
    assert.ok(renderers.some(r => r.name === 'thumbnail'));
  });

  test('a subdirectory with no renderer.json is silently skipped, not an error', () => {
    const dir = makeTmpRenderersDir();
    writeRenderer(dir, 'generic-text', baseText);
    writeRenderer(dir, 'generic-binary', baseBinary);
    fs.mkdirSync(path.join(dir, 'not-a-renderer'));

    const renderers = loadRenderers(dir);
    assert.equal(renderers.length, 2);
  });
});

describe('loadRenderers — uid uniqueness', () => {
  test('throws when two renderers share a uid', () => {
    const dir = makeTmpRenderersDir();
    writeRenderer(dir, 'generic-text', baseText);
    writeRenderer(dir, 'generic-binary', baseBinary);
    writeRenderer(dir, 'dup-a', { ...pngFile, name: 'dup-a' });
    writeRenderer(dir, 'dup-b', { ...pngFile, name: 'dup-b' }); // same uid as pngFile

    assert.throws(() => loadRenderers(dir), /duplicate uid/);
  });
});

describe('loadRenderers — base-per-file_mode invariant', () => {
  test('throws when no base renderer exists for file_mode "text"', () => {
    const dir = makeTmpRenderersDir();
    writeRenderer(dir, 'generic-binary', baseBinary);
    writeRenderer(dir, 'thumbnail', pngFile);

    assert.throws(() => loadRenderers(dir), /no base renderer.*"text"/);
  });

  test('throws when no base renderer exists for file_mode "binary"', () => {
    const dir = makeTmpRenderersDir();
    writeRenderer(dir, 'generic-text', baseText);

    assert.throws(() => loadRenderers(dir), /no base renderer.*"binary"/);
  });

  test('a renderer with file_type does NOT count as a base, even with no binary_category', () => {
    const dir = makeTmpRenderersDir();
    writeRenderer(dir, 'generic-text', baseText);
    // Only a specific-file_type binary renderer, no true base for "binary"
    writeRenderer(dir, 'thumbnail', pngFile);

    assert.throws(() => loadRenderers(dir), /no base renderer.*"binary"/);
  });

  test('succeeds when both bases are present', () => {
    const dir = makeTmpRenderersDir();
    writeRenderer(dir, 'generic-text', baseText);
    writeRenderer(dir, 'generic-binary', baseBinary);
    assert.doesNotThrow(() => loadRenderers(dir));
  });
});

// ─── Real, shipped manifests ──────────────────────────────────────────────────

describe('loadRenderers — the real paco/renderers/ tree', () => {
  test('loads without throwing (uids unique, both bases present)', () => {
    const renderers = loadRenderers();
    assert.ok(renderers.length >= 8, `expected at least 8 real renderers, got ${renderers.length}`);
  });

  test('every real renderer.json validates against renderer.schema.json', () => {
    const Ajv = require('ajv/dist/2020');
    const addFormats = require('ajv-formats');
    const schema = require('../paco/renderers/renderer.schema.json');
    const ajv = new Ajv({ allErrors: true, strict: true });
    addFormats(ajv);
    const validate = ajv.compile(schema);

    const renderers = loadRenderers();
    for (const r of renderers) {
      assert.ok(validate(r), `${r.name} (${r.uid}) failed schema: ${JSON.stringify(validate.errors)}`);
    }
  });

  test('expected renderer names are all present', () => {
    const renderers = loadRenderers();
    const names = renderers.map(r => r.name);
    assert.ok(names.includes('Raw text'));
    assert.ok(names.includes('Raw binary'));
    assert.ok(names.filter(n => n === 'Formatted text').length === 2, 'expects exactly 2 Formatted text manifests (binary + text split)');
    assert.ok(names.filter(n => n === 'Thumbnail').length === 2, 'expects exactly 2 Thumbnail manifests (image + svg split)');
    assert.ok(names.includes('Filmstrip'));
    assert.ok(names.includes('Waveform'));
  });
});

describe('folderForUid — the real paco/renderers/ tree', () => {
  test('finds the correct folder for a known uid', () => {
    const renderers = loadRenderers();
    const thumbnail = renderers.find(r => r.name === 'Thumbnail' && r.abilities.binary_category === 'image');
    const folder = folderForUid(thumbnail.uid);
    assert.equal(folder, 'thumbnail');
  });

  test('finds the sibling split folder correctly too (not confused with its pair)', () => {
    const renderers = loadRenderers();
    const svgThumbnail = renderers.find(r => r.name === 'Thumbnail' && r.abilities.file_type === 'svg');
    const folder = folderForUid(svgThumbnail.uid);
    assert.equal(folder, 'thumbnail-svg');
  });

  test('returns null for an unknown uid', () => {
    assert.equal(folderForUid('00000000-0000-0000-0000-000000000000'), null);
  });
});
