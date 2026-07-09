'use strict';

/**
 * paco/renderers/registry.js
 *
 * The "boot-time registry-loading code" that renderer.schema.json's own
 * description anticipates but leaves unimplemented — per-document shape
 * (required fields, enums, the text/binary_category prohibition) is
 * already enforced by that schema, and re-validated against every real,
 * checked-in renderer.json by test/renderers-registry.test.js, so this
 * module does NOT re-run ajv at every server boot: these are
 * developer-authored, static, checked-in files, not user-supplied input,
 * and the test suite already fails loudly if one of them drifts out of
 * schema. What CAN'T be checked one document at a time — uid uniqueness
 * and "a base renderer exists for each file_mode" — is exactly what this
 * module enforces, at load time, across the whole set.
 *
 * Discovery: every immediate subdirectory of paco/renderers/ that
 * contains a renderer.json is a renderer. matcher.js and
 * renderer.schema.json themselves live directly in paco/renderers/, not
 * in a subdirectory, so they're naturally skipped.
 *
 * Deliberately NOT this module's job: deciding which extractor task to
 * run for a matched renderer, or how to configure it — that's
 * paco/renderers/<name>/glue.js's responsibility, invoked separately by
 * worker/tasks/extract-preview.js once a specific renderer has actually
 * been chosen for a specific selection. This module only ever answers
 * "what renderers exist", for matchRenderers (client-side, via GET
 * /renderers) to choose among.
 */

const fs   = require('fs');
const path = require('path');

const RENDERERS_DIR = __dirname;

/**
 * @param {string} [renderersDir] — injected for testability; defaults to
 *   this module's own directory (the real paco/renderers/).
 * @returns {object[]} every valid renderer.json document found, in
 *   directory-listing order (not otherwise meaningful — matchRenderers
 *   doesn't depend on registry input order, only on content).
 * @throws if two renderers share a uid, or if no base renderer (a
 *   renderer declaring neither file_type nor binary_category) exists for
 *   both file_mode "text" and file_mode "binary" — both are load-time
 *   configuration bugs in this project's own shipped manifests, not
 *   something a caller should have to guard against downstream.
 */
function loadRenderers(renderersDir = RENDERERS_DIR) {
  const entries = fs.readdirSync(renderersDir, { withFileTypes: true })
    .filter(e => e.isDirectory());

  const renderers = [];
  for (const entry of entries) {
    const manifestPath = path.join(renderersDir, entry.name, 'renderer.json');
    if (!fs.existsSync(manifestPath)) continue; // not every subdirectory need be a renderer
    const doc = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    renderers.push(doc);
  }

  _checkUidsUnique(renderers);
  _checkBasePerFileMode(renderers);

  return renderers;
}

function _checkUidsUnique(renderers) {
  const seen = new Map(); // uid -> renderer name
  for (const r of renderers) {
    if (seen.has(r.uid)) {
      throw new Error(
        `paco/renderers/registry.js: duplicate uid "${r.uid}" shared by ` +
        `"${seen.get(r.uid)}" and "${r.name}" — every renderer.json must have a unique uid.`
      );
    }
    seen.set(r.uid, r.name);
  }
}

function _isBaseRenderer(r) {
  const a = r.abilities || {};
  const ft = a.file_type;
  const hasFileType = Array.isArray(ft) ? ft.length > 0 : !!ft;
  return !hasFileType && !a.binary_category;
}

function _checkBasePerFileMode(renderers) {
  for (const fileMode of ['text', 'binary']) {
    const hasBase = renderers.some(r =>
      r.abilities && r.abilities.file_mode === fileMode &&
      r.abilities.selection_type === 'single' &&
      _isBaseRenderer(r)
    );
    if (!hasBase) {
      throw new Error(
        `paco/renderers/registry.js: no base renderer registered for ` +
        `selection_type "single", file_mode "${fileMode}" — every single-selection ` +
        `file_mode needs a fallback renderer declaring neither file_type nor binary_category.`
      );
    }
  }
}

/**
 * Find which paco/renderers/<folder>/ a given uid lives in — used
 * server-side only, by worker/tasks/extract-preview.js, to know which
 * folder's glue.js to require() once a specific renderer has been chosen
 * for a specific selection. Deliberately NOT part of loadRenderers()'s
 * own return value: the objects that function returns are served as-is
 * to the browser via GET /renderers, and should stay exactly what's on
 * disk (schema-conformant renderer.json content), not decorated with an
 * internal-only field the client has no use for.
 *
 * @param {string} uid
 * @param {string} [renderersDir]
 * @returns {string|null} the folder name, or null if no renderer.json
 *   anywhere under renderersDir declares this uid.
 */
function folderForUid(uid, renderersDir = RENDERERS_DIR) {
  const entries = fs.readdirSync(renderersDir, { withFileTypes: true })
    .filter(e => e.isDirectory());

  for (const entry of entries) {
    const manifestPath = path.join(renderersDir, entry.name, 'renderer.json');
    if (!fs.existsSync(manifestPath)) continue;
    const doc = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (doc.uid === uid) return entry.name;
  }
  return null;
}

module.exports = { loadRenderers, folderForUid };
