'use strict';

/**
 * paco/renderers/matcher.js
 *
 * Pure, synchronous renderer-matching algorithm for the F3 Viewer's
 * "View as: [tab] [tab] ..." UI. No I/O, no DOM — given the selection's
 * already-derived classification and the full list of registered
 * renderers (parsed renderer.json shapes), decides which renderer(s)
 * should appear as tabs and which one is preselected.
 *
 * ─── The algorithm ──────────────────────────────────────────────────────────
 *
 * 1. GATE — a renderer only participates at all if its abilities.selection_type
 *    and abilities.file_mode exactly equal the selection's own values.
 *    Renderers failing this gate are excluded entirely, before any rung
 *    matching even runs.
 *
 * 2. RUNG 1 (file-specific) — among gated renderers, those whose
 *    abilities.file_type (a string OR an array of strings) includes the
 *    selection's own derived file_type. A single-string file_type and a
 *    one-element array are matched identically; an array lets one
 *    renderer cover a closely-related family (e.g. ["jpeg","jpg","png"])
 *    without one renderer.json per exact extension.
 *
 * 3. RUNG 2 (generic category, binary only) — ONLY evaluated when rung 1
 *    produced nothing. Among gated renderers with file_mode "binary",
 *    those declaring abilities.binary_category equal to the selection's
 *    own binary_category, AND declaring no file_type at all (a renderer
 *    with both binary_category and file_type is a rung-1 renderer that
 *    merely also carries binary_category as informational metadata — see
 *    the renderer.json design discussion — it must never double as a
 *    rung-2 match too).
 *
 * 4. TAB SET = rung 1 if non-empty, else rung 2 if non-empty, else
 *    neither — PLUS the base renderer for the selection's file_mode,
 *    unconditionally appended (a renderer declaring neither file_type nor
 *    binary_category). The base is independent of whether rungs 1/2 fired
 *    at all — it is always offered as a fallback whenever the selection
 *    cleared the gate, full stop.
 *
 * 5. PRESELECTION = the most specific thing actually present, in this
 *    priority order:
 *      a) a rung-1 renderer matched via a single-string file_type
 *      b) a rung-1 renderer matched via an array file_type
 *      c) a rung-2 renderer
 *      d) the base renderer
 *    If more than one renderer ties within (a) or (b) — e.g. two
 *    different single-exact-type renderers somehow registered for the
 *    same file_type — the first one encountered in the input array wins;
 *    this is an edge case the registry-population layer should prevent,
 *    not something this function tries to adjudicate further.
 */

/**
 * @typedef {Object} SelectionClassification
 * @property {'single'|'multi'} selectionType
 * @property {'text'|'binary'}  fileMode
 * @property {'image'|'audio'|'video'|'other'|null} binaryCategory
 *   — null when fileMode is 'text', or when no specific category applies
 * @property {string|null} fileType
 *   — e.g. 'png', 'md' — null if the selection has no specific derivable type
 */

/**
 * @typedef {Object} RendererDef
 * @property {string} name
 * @property {string} uid
 * @property {Object} abilities
 * @property {'single'|'multi'} abilities.selection_type
 * @property {'text'|'binary'}  abilities.file_mode
 * @property {string}           [abilities.binary_category]
 * @property {string|string[]}  [abilities.file_type]
 */

/**
 * @param {SelectionClassification} selection
 * @param {RendererDef[]} renderers — the full registered renderer list
 * @returns {{ tabs: RendererDef[], preselected: RendererDef|null }}
 *   tabs is ordered: rung-1/2 matches (input order preserved) first, base
 *   last. preselected is one of the entries in tabs, or null if nothing
 *   matched at all (not even a base renderer is registered).
 */
function matchRenderers(selection, renderers) {
  const gated = (renderers || []).filter(r => _passesGate(r, selection));

  const rung1 = gated.filter(r => _isRung1Match(r, selection));
  const rung2 = rung1.length === 0
    ? gated.filter(r => _isRung2Match(r, selection))
    : [];

  const base = gated.find(_isBaseRenderer) || null;

  const primary = rung1.length > 0 ? rung1 : rung2;
  const tabs = base && !primary.includes(base) ? [...primary, base] : primary.slice();

  const preselected = _choosePreselection(rung1, rung2, base, selection);

  return { tabs, preselected };
}

/**
 * @param {RendererDef} renderer
 * @param {SelectionClassification} selection
 * @returns {boolean}
 */
function _passesGate(renderer, selection) {
  const a = renderer.abilities || {};
  return a.selection_type === selection.selectionType
      && a.file_mode === selection.fileMode;
}

/**
 * @param {RendererDef} renderer
 * @returns {string[]} normalised file_type as an array, [] if not declared
 */
function _fileTypesOf(renderer) {
  const ft = renderer.abilities && renderer.abilities.file_type;
  if (!ft) return [];
  return Array.isArray(ft) ? ft : [ft];
}

/**
 * @param {RendererDef} renderer
 * @returns {boolean} true if file_type is declared as a single string
 *   (not an array) — used only for preselection priority, not for the
 *   match test itself, which treats both shapes identically.
 */
function _hasSingleStringFileType(renderer) {
  const ft = renderer.abilities && renderer.abilities.file_type;
  return typeof ft === 'string' && ft.length > 0;
}

function _isRung1Match(renderer, selection) {
  if (!selection.fileType) return false;
  const types = _fileTypesOf(renderer);
  return types.includes(selection.fileType);
}

function _isRung2Match(renderer, selection) {
  if (selection.fileMode !== 'binary') return false;
  if (!selection.binaryCategory) return false;
  const a = renderer.abilities || {};
  if (_fileTypesOf(renderer).length > 0) return false; // file_type present → rung-1 renderer, never rung-2
  return a.binary_category === selection.binaryCategory;
}

/**
 * The base renderer for a file_mode: gated, but declares neither
 * file_type nor binary_category — i.e. nothing beyond the two hard gates.
 * @param {RendererDef} renderer
 * @returns {boolean}
 */
function _isBaseRenderer(renderer) {
  const a = renderer.abilities || {};
  return _fileTypesOf(renderer).length === 0 && !a.binary_category;
}

function _choosePreselection(rung1, rung2, base, selection) {
  if (rung1.length > 0) {
    const exact = rung1.find(_hasSingleStringFileType);
    if (exact) return exact;
    return rung1[0]; // array-file_type match — no exact-string match present
  }
  if (rung2.length > 0) return rung2[0];
  return base;
}

const matcher = { matchRenderers };

// Always expose as a browser global when running in a browser context —
// same dual-export pattern as paco/ui-state.js (see that file's own
// comment on why the typeof-window check is used over typeof-module).
if (typeof window !== 'undefined') {
  window.rendererMatcher = matcher;
}

// CommonJS export for Node.js (tests, tasks).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = matcher;
}
