'use strict';

/**
 * generic-extractor
 *
 * Turns arbitrary bytes into safe, ready-to-use HTML for files that fall
 * outside every other extractor's coverage: bare text files, source code,
 * and binary files with no dedicated handler. Two modes, chosen by the
 * caller (this module never sniffs):
 *
 *   - text:   the decoded text itself, monospaced, in one <pre>, with
 *             original line breaks preserved and optional server-side
 *             wrapping that preserves each wrapped line's original indent.
 *   - binary: a hex dump — configurable bytes-per-row and group size —
 *             with a Latin-1 rendering of the same bytes alongside each
 *             row, both prepared as ONE pre-formatted block of text.
 *
 * Exactly two <pre> elements ever appear in the output: one optional
 * gutter (line numbers / byte offsets) and one holding the entire dump,
 * regardless of file size. No tables, no one-element-per-line, no
 * wrapping left to CSS — everything is plain text prepared once on the
 * Node side.
 *
 * When config.interactive is true (default), a small embedded <script>
 * adds Find/Find-Next/Find-Prev (plain substring or regex) and, in binary
 * mode, cross-highlighting between the hex and Latin-1 portions of a
 * selection. That script only ever touches the file's bytes as inert
 * text already sitting in the DOM (via textContent) — it is never
 * serialized into a <script> block itself, so there is no reproduction
 * of the "embedding untrusted content inside <script>" class of risk
 * that motivated a lot of caution earlier in this project.
 *
 * Return shape (always, never throws):
 *   { html: string, mode: 'text'|'binary', error: null }
 *   { html: null, mode: null, error: { code: string, message: string } }
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG = {
  // The entire file becomes visible content (unlike every other module
  // here, there's no derived/bounded thumbnail) — kept much lower than
  // media-extractor's ceiling for exactly that reason.
  maxFileSizeBytes: 5 * 1024 * 1024, // 5 MB

  // Text mode. null/0 = no wrapping at all.
  wrapColumn: null,

  // Binary mode.
  bytesPerRow: 16,
  groupSize: 1, // bytes per hex group before a separating space
  columnGap: 4, // spaces between the hex portion and the Latin-1 portion

  // Shared.
  showLineNumbers: false,
  offsetFormat: 'hex', // 'hex' | 'decimal' — binary mode's gutter only

  // false = pure static markup, no <script> at all.
  interactive: true,

  // Prefix for every element id / CSS class this module generates
  // (ge-body, ge-find-input, .ge-match, ...). The default is safe for
  // a single preview on a page; give each instance a distinct prefix
  // if more than one might coexist in the same document at once, since
  // getElementById-based lookups would otherwise collide. Validated
  // against a safe identifier pattern — invalid values fall back to
  // the default rather than being trusted as-is.
  idPrefix: 'ge',
};

function sanitizeIdPrefix(prefix) {
  const p = String(prefix == null ? '' : prefix);
  return /^[A-Za-z][A-Za-z0-9_-]*$/.test(p) ? p : 'ge';
}

const ErrorCode = Object.freeze({
  TOO_LARGE: 'too-large',
  PARSE_ERROR: 'parse-error',
});

function failure(code, message) {
  return { html: null, mode: null, error: { code, message } };
}

// ---------------------------------------------------------------------------
// escapeForPre — the core safety primitive
// ---------------------------------------------------------------------------

/**
 * Escapes a string for safe, EXACT embedding as literal text inside an
 * HTML <pre>. This is not just the usual &/</> escaping — it specifically
 * exists because two byte values get silently mangled by the HTML5
 * parser's own stream-preprocessing step if left as raw characters,
 * *before* the escaping question even arises:
 *
 *   - NUL (U+0000) is dropped entirely by the parser, shifting every
 *     subsequent character left by one position.
 *   - A CRLF pair collapses into a single LF character, losing one
 *     position per pair.
 *
 * Both were confirmed empirically (not assumed from spec-reading) using
 * jsdom's spec-compliant parser: a raw 256-byte Latin-1 string round-
 * tripped through innerHTML lost characters at exactly these two cases,
 * silently breaking any byte-position arithmetic downstream. Routing
 * NUL and CR through numeric character references instead (`&#0;`,
 * `&#13;`) sidesteps this, since references are decoded to their exact
 * codepoint *after* stream preprocessing has already run — verified the
 * same way, with the fix in place, for all 256 byte values.
 *
 * One exception remains, and it is a hard ceiling of HTML as a format,
 * not something any escaping strategy can route around: `&#0;` itself
 * is required by the HTML5 spec's numeric-character-reference table to
 * always resolve to U+FFFD, never literal NUL — no HTML document can
 * contain a literal U+0000 in its parsed text content. Every other byte
 * value, 0x01 through 0xFF, round-trips to its exact Latin-1 character.
 * A lone CR (not part of a CRLF pair) becomes LF — a different glyph,
 * but still exactly one character in, one character out, so it doesn't
 * disturb position counting the way the two cases above would.
 */
function escapeForPre(str) {
  return str.replace(/[&<>\x00\x0d]/g, (ch) => {
    switch (ch) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '\x00':
        return '&#0;';
      case '\x0d':
        return '&#13;';
      default:
        return ch;
    }
  });
}

// ---------------------------------------------------------------------------
// Pure helpers — text mode
// ---------------------------------------------------------------------------

/**
 * Wraps a single line at wrapColumn characters, repeating the line's own
 * leading whitespace as a prefix on every continuation line, so wrapped
 * output preserves the original indent without any CSS involved. Returns
 * [line] unchanged if wrapping doesn't apply or isn't needed.
 */
function wrapLinePreservingIndent(line, wrapColumn) {
  if (!wrapColumn || wrapColumn <= 0 || line.length <= wrapColumn) return [line];
  const indentMatch = line.match(/^[ \t]*/);
  const indent = indentMatch ? indentMatch[0] : '';
  const firstChunk = line.slice(0, wrapColumn);
  const rest = line.slice(wrapColumn);
  const contentWidth = Math.max(1, wrapColumn - indent.length);
  const continuationLines = [];
  for (let i = 0; i < rest.length; i += contentWidth) {
    continuationLines.push(indent + rest.slice(i, i + contentWidth));
  }
  return [firstChunk, ...continuationLines];
}

/**
 * Builds the plain-text body and its parallel line-number gutter.
 * Wrapping can turn one logical source line into several visual lines;
 * the gutter carries the original line number only on the first visual
 * line of each logical line, and an empty entry for continuation lines
 * introduced by wrapping — the standard editor convention, and what
 * keeps the two <pre>s row-count-synced for side-by-side layout.
 */
function buildPlainText(decodedText, config) {
  const sourceLines = decodedText.split('\n');
  const bodyLines = [];
  const gutterEntries = [];
  sourceLines.forEach((line, idx) => {
    const wrapped = config.wrapColumn ? wrapLinePreservingIndent(line, config.wrapColumn) : [line];
    wrapped.forEach((wline, wi) => {
      bodyLines.push(wline);
      gutterEntries.push(wi === 0 ? String(idx + 1) : '');
    });
  });
  return { text: bodyLines.join('\n'), gutterText: gutterEntries.join('\n'), lineCount: bodyLines.length };
}

// ---------------------------------------------------------------------------
// Pure helpers — binary mode
// ---------------------------------------------------------------------------

function computeOffsetWidth(totalBytes, format) {
  const maxOffset = Math.max(0, totalBytes - 1);
  if (format === 'decimal') return Math.max(1, String(maxOffset).length);
  return Math.max(4, maxOffset.toString(16).length);
}

function formatOffset(n, format, width) {
  if (format === 'decimal') return String(n).padStart(width, '0');
  return n.toString(16).toUpperCase().padStart(width, '0');
}

/**
 * Fixed per-row character layout for binary mode: where the hex portion
 * and the Latin-1 portion of each row start/end, in characters, and how
 * many characters (including the trailing newline) one full row spans in
 * the flat body text. This is the one structure the client-side
 * cross-highlight math is built on — everything it needs to convert
 * between a byte index and a character offset comes from here.
 */
function computeRowLayout(config) {
  const { bytesPerRow, groupSize, columnGap } = config;
  const groupsPerRow = Math.ceil(bytesPerRow / groupSize);
  const hexWidth = groupsPerRow * (groupSize * 2) + (groupsPerRow - 1); // hex chars + inter-group spaces
  const latin1Width = bytesPerRow; // exactly 1 char per byte, guaranteed by escapeForPre
  const rowWidth = hexWidth + columnGap + latin1Width; // chars per row, excluding the \n
  return { bytesPerRow, groupSize, hexWidth, columnGap, latin1Width, rowWidth, rowStride: rowWidth + 1 };
}

/** Character offset (within a row) where byte i's 2 hex digits start. Always exactly 2 chars, regardless of groupSize. */
function hexCharStartInRow(layout, byteIndexInRow) {
  const group = Math.floor(byteIndexInRow / layout.groupSize);
  const withinGroup = byteIndexInRow % layout.groupSize;
  return group * (layout.groupSize * 2 + 1) + withinGroup * 2;
}

/** Character offset (within a row) where byte i's Latin-1 character sits. */
function latin1CharStartInRow(layout, byteIndexInRow) {
  return layout.hexWidth + layout.columnGap + byteIndexInRow;
}

/** Absolute [start, end) character range, in the flat body text, of byte i's hex digits. */
function byteToHexCharRange(layout, byteIndex) {
  const row = Math.floor(byteIndex / layout.bytesPerRow);
  const byteIndexInRow = byteIndex % layout.bytesPerRow;
  const rowStart = row * layout.rowStride;
  const start = rowStart + hexCharStartInRow(layout, byteIndexInRow);
  return { start, end: start + 2 };
}

/** Absolute [start, end) character range, in the flat body text, of byte i's Latin-1 character. */
function byteToLatin1CharRange(layout, byteIndex) {
  const row = Math.floor(byteIndex / layout.bytesPerRow);
  const byteIndexInRow = byteIndex % layout.bytesPerRow;
  const rowStart = row * layout.rowStride;
  const start = rowStart + latin1CharStartInRow(layout, byteIndexInRow);
  return { start, end: start + 1 };
}

/**
 * The Latin-1 companion column substitutes every control character —
 * 0x00-0x1F, 0x7F (DEL), and 0x80-0x9F (the C1 control range) — with
 * '.', the conventional hex-editor placeholder.
 *
 * This started narrower: only 0x0A (LF) and 0x09 (TAB) were forced
 * substitutions, for a structural reason distinct from escapeForPre's
 * NUL/CR handling — <pre> with white-space:pre renders any literal LF
 * as a real line break and any literal TAB as a variable-width
 * tab-stop, and this module deliberately uses literal '\n' as its own
 * row-separator syntax within the same flat text blob as byte-derived
 * content, so those two specifically had no escaping-based fix
 * available (a numeric character reference for LF/TAB still decodes to
 * the exact same real character, which still triggers the same
 * rendering behavior). Broadened to every control character by
 * explicit choice, for visual consistency — otherwise some
 * non-printable bytes would render as '.' and others as whatever
 * blank/tofu glyph a given font happens to show, an arbitrary
 * inconsistency for content whose whole point is readability.
 *
 * One pleasant side effect: NUL and CR are themselves control
 * characters, so in binary mode they now become '.' here, before
 * escapeForPre ever sees them — the NUL-becomes-U+FFFD spec quirk and
 * the CR-needs-a-numeric-reference handling described on escapeForPre
 * no longer surface in the Latin-1 column at all. Both remain
 * necessary in escapeForPre regardless, since text mode's UTF-8-decoded
 * content isn't run through this substitution and could still contain
 * either byte.
 */
function isLatin1ControlByte(b) {
  return (b >= 0x00 && b <= 0x1f) || b === 0x7f || (b >= 0x80 && b <= 0x9f);
}
const LATIN1_CONTROL_PLACEHOLDER = '.';

function buildLatin1Column(rowBytes) {
  let out = '';
  for (const b of rowBytes) {
    out += isLatin1ControlByte(b) ? LATIN1_CONTROL_PLACEHOLDER : String.fromCharCode(b);
  }
  return out;
}

/**
 * Builds the hex-dump body and its parallel offset gutter. Each row is
 * padded to a fixed hex-column width even when it's the short final row
 * of the file, so the Latin-1 column stays aligned across every row.
 */
function buildHexDumpText(buffer, config) {
  const layout = computeRowLayout(config);
  const offsetWidth = computeOffsetWidth(buffer.length, config.offsetFormat);
  const bodyLines = [];
  const gutterEntries = [];

  if (buffer.length === 0) {
    return { text: '', gutterText: formatOffset(0, config.offsetFormat, offsetWidth), lineCount: 1 };
  }

  for (let rowStart = 0; rowStart < buffer.length; rowStart += config.bytesPerRow) {
    const rowBytes = buffer.subarray(rowStart, Math.min(rowStart + config.bytesPerRow, buffer.length));
    const hexGroups = [];
    for (let i = 0; i < rowBytes.length; i += config.groupSize) {
      const group = rowBytes.subarray(i, i + config.groupSize);
      hexGroups.push(Array.from(group, (b) => b.toString(16).toUpperCase().padStart(2, '0')).join(''));
    }
    let hexPart = hexGroups.join(' ');
    if (hexPart.length < layout.hexWidth) hexPart += ' '.repeat(layout.hexWidth - hexPart.length);
    const latin1Part = buildLatin1Column(rowBytes);
    bodyLines.push(hexPart + ' '.repeat(config.columnGap) + latin1Part);
    gutterEntries.push(formatOffset(rowStart, config.offsetFormat, offsetWidth));
  }

  return { text: bodyLines.join('\n'), gutterText: gutterEntries.join('\n'), lineCount: bodyLines.length };
}

// ---------------------------------------------------------------------------
// Pure helpers — search (shared by the client script; kept pure/testable here)
// ---------------------------------------------------------------------------

/**
 * Finds all non-overlapping matches of query in text. Never throws: an
 * invalid regex simply yields no matches rather than propagating a
 * SyntaxError, and zero-length regex matches are stepped over rather
 * than causing an infinite loop.
 */
function findMatches(text, query, useRegex) {
  const ranges = [];
  if (!query) return ranges;

  if (useRegex) {
    let re;
    try {
      re = new RegExp(query, 'g');
    } catch (_err) {
      return ranges;
    }
    let m;
    while ((m = re.exec(text)) !== null) {
      ranges.push({ start: m.index, end: m.index + m[0].length });
      if (m[0].length === 0) {
        re.lastIndex += 1;
        if (re.lastIndex > text.length) break;
      }
    }
    return ranges;
  }

  let idx = 0;
  while (true) {
    const found = text.indexOf(query, idx);
    if (found === -1) break;
    ranges.push({ start: found, end: found + query.length });
    idx = found + Math.max(query.length, 1);
  }
  return ranges;
}

// ---------------------------------------------------------------------------
// Cross-highlight mirroring (binary mode)
// ---------------------------------------------------------------------------

/**
 * Given an absolute character offset in the flat body text, determines
 * which row it falls in and, if it lands within the hex or Latin-1
 * region of that row, the corresponding byte index. Positions in the
 * gap between the two regions (or past the end of a short final row)
 * snap to the nearest sensible byte boundary rather than failing, so
 * this never throws on an odd drag endpoint.
 */
function charOffsetToByteCoordinate(layout, totalBytes, offset) {
  const row = Math.floor(offset / layout.rowStride);
  const withinRow = offset - row * layout.rowStride;
  const rowFirstByte = row * layout.bytesPerRow;
  const bytesInRow = Math.min(layout.bytesPerRow, Math.max(0, totalBytes - rowFirstByte));

  let region;
  let byteIndexInRow;
  if (withinRow < layout.hexWidth) {
    region = 'hex';
    byteIndexInRow = Math.floor(withinRow / (layout.groupSize * 2 + 1)) * layout.groupSize + Math.floor((withinRow % (layout.groupSize * 2 + 1)) / 2);
  } else {
    region = 'latin1';
    byteIndexInRow = withinRow - layout.hexWidth - layout.columnGap;
  }
  byteIndexInRow = Math.max(0, Math.min(byteIndexInRow, Math.max(0, bytesInRow - 1)));

  return { region, byteIndex: rowFirstByte + byteIndexInRow };
}

/**
 * Given a selection's absolute [start, end) character range in one
 * region, returns the per-row mirrored ranges in the other region — one
 * range per row the selection touches, matching how a highlight that
 * crosses a line break has to be expressed as separate spans anyway.
 * Which region "wins" for a selection that isn't cleanly within one
 * region is decided by where it starts; this covers selections that
 * start and end within the intended region cleanly, which is the
 * overwhelmingly common real case, rather than exhaustively resolving
 * every possible ragged multi-region drag.
 */
function mapSelectionToMirroredRanges(layout, totalBytes, absStart, absEnd) {
  if (absEnd <= absStart) return [];
  const startCoord = charOffsetToByteCoordinate(layout, totalBytes, absStart);
  const endCoord = charOffsetToByteCoordinate(layout, totalBytes, Math.max(absStart, absEnd - 1));
  const sourceRegion = startCoord.region;
  const targetRegion = sourceRegion === 'hex' ? 'latin1' : 'hex';

  const byteStart = startCoord.byteIndex;
  const byteEnd = endCoord.byteIndex + 1; // half-open
  if (byteEnd <= byteStart) return [];

  const firstRow = Math.floor(byteStart / layout.bytesPerRow);
  const lastRow = Math.floor((byteEnd - 1) / layout.bytesPerRow);

  const ranges = [];
  for (let row = firstRow; row <= lastRow; row++) {
    const rowFirstByte = row * layout.bytesPerRow;
    const rowLastByte = rowFirstByte + layout.bytesPerRow - 1;
    const coveredStart = Math.max(byteStart, rowFirstByte);
    const coveredEnd = Math.min(byteEnd - 1, rowLastByte);
    if (coveredEnd < coveredStart) continue;
    const startRange = targetRegion === 'hex' ? byteToHexCharRange(layout, coveredStart) : byteToLatin1CharRange(layout, coveredStart);
    const endRange = targetRegion === 'hex' ? byteToHexCharRange(layout, coveredEnd) : byteToLatin1CharRange(layout, coveredEnd);
    ranges.push({ start: startRange.start, end: endRange.end });
  }
  return ranges;
}

// ---------------------------------------------------------------------------
// DOM-touching helper (still pure enough to unit-test via jsdom: takes a
// container element and a sorted, non-overlapping range list, has no
// other side effects or dependencies).
// ---------------------------------------------------------------------------

/**
 * Wraps each [start, end) range in `container`'s text in a <span> with
 * the given className. Assumes container holds a single text node (the
 * caller resets via `container.textContent = container.textContent`
 * before calling this, per this module's highlight-discipline: every
 * highlight-inserting action starts clean, so insertion never has to
 * deal with previously-fragmented content). Ranges must be sorted
 * ascending and non-overlapping.
 */
function applyHighlights(container, ranges, className) {
  if (!ranges.length) return;
  let tail = container.firstChild;
  if (!tail) return;
  let consumed = 0;
  for (const range of ranges) {
    const rest = tail.splitText(range.start - consumed);
    const after = rest.splitText(range.end - range.start);
    const span = container.ownerDocument.createElement('span');
    span.className = className;
    rest.parentNode.insertBefore(span, rest);
    span.appendChild(rest);
    tail = after;
    consumed = range.end;
  }
}

// ---------------------------------------------------------------------------
// Client-side script (embedded verbatim; not templated with any
// caller/file-derived content beyond a handful of trusted small integers
// from config, so there is nothing here that needs escaping the way an
// open text field would).
// ---------------------------------------------------------------------------

function buildClientScript(mode, layout, idPrefix) {
  const layoutJson = mode === 'binary' ? JSON.stringify(layout) : 'null';
  return `<script>(function(){
var mode=${JSON.stringify(mode)};
var layout=${layoutJson};
var P=${JSON.stringify(idPrefix)};
var body=document.getElementById(P+'-body');
if(!body)return;

function resetHighlights(){ body.textContent = body.textContent; }

function applyHighlights(container, ranges, className){
  if(!ranges.length) return;
  var tail = container.firstChild;
  if(!tail) return;
  var consumed = 0;
  for (var i=0;i<ranges.length;i++){
    var range = ranges[i];
    var rest = tail.splitText(range.start - consumed);
    var after = rest.splitText(range.end - range.start);
    var span = document.createElement('span');
    span.className = className;
    rest.parentNode.insertBefore(span, rest);
    span.appendChild(rest);
    tail = after;
    consumed = range.end;
  }
}

function findMatches(text, query, useRegex){
  var ranges = [];
  if (!query) return ranges;
  if (useRegex) {
    var re;
    try { re = new RegExp(query, 'g'); } catch(e){ return ranges; }
    var m;
    while ((m = re.exec(text)) !== null) {
      ranges.push({start: m.index, end: m.index + m[0].length});
      if (m[0].length === 0) { re.lastIndex++; if (re.lastIndex > text.length) break; }
    }
    return ranges;
  }
  var idx = 0;
  while (true) {
    var found = text.indexOf(query, idx);
    if (found === -1) break;
    ranges.push({start: found, end: found + query.length});
    idx = found + Math.max(query.length, 1);
  }
  return ranges;
}

var currentMatches = [];
var currentMatchPos = -1;
var matchClass = P+'-match';
var matchCurrentClass = P+'-match '+P+'-match-current';
var mirrorClass = P+'-mirror';

function runSearch(query, useRegex){
  resetHighlights();
  currentMatches = findMatches(body.textContent, query, useRegex);
  currentMatchPos = currentMatches.length ? 0 : -1;
  applyHighlights(body, currentMatches, matchClass);
  updateMatchUi();
  scrollToCurrent();
}

function updateMatchUi(){
  var counter = document.getElementById(P+'-match-count');
  if (counter) counter.textContent = currentMatches.length ? (currentMatchPos+1) + ' / ' + currentMatches.length : '0 / 0';
  var spans = body.querySelectorAll('.'+matchClass);
  for (var i=0;i<spans.length;i++) spans[i].className = (i===currentMatchPos) ? matchCurrentClass : matchClass;
}

function scrollToCurrent(){
  var spans = body.querySelectorAll('.'+matchClass);
  if (currentMatchPos>=0 && spans[currentMatchPos]) spans[currentMatchPos].scrollIntoView({block:'center'});
}

function stepMatch(delta){
  if (!currentMatches.length) return;
  currentMatchPos = (currentMatchPos + delta + currentMatches.length) % currentMatches.length;
  updateMatchUi();
  scrollToCurrent();
}

var input = document.getElementById(P+'-find-input');
var regexToggle = document.getElementById(P+'-find-regex');
var nextBtn = document.getElementById(P+'-find-next');
var prevBtn = document.getElementById(P+'-find-prev');
if (input) input.addEventListener('keydown', function(e){ if(e.key==='Enter') runSearch(input.value, regexToggle && regexToggle.checked); });
if (nextBtn) nextBtn.addEventListener('click', function(){ stepMatch(1); });
if (prevBtn) prevBtn.addEventListener('click', function(){ stepMatch(-1); });

if (mode === 'binary' && layout) {
  function charOffsetToByteCoordinate(offset){
    var row = Math.floor(offset / layout.rowStride);
    var withinRow = offset - row*layout.rowStride;
    var rowFirstByte = row*layout.bytesPerRow;
    var region, byteIndexInRow;
    if (withinRow < layout.hexWidth) {
      region = 'hex';
      var groupSpan = layout.groupSize*2+1;
      byteIndexInRow = Math.floor(withinRow/groupSpan)*layout.groupSize + Math.floor((withinRow%groupSpan)/2);
    } else {
      region = 'latin1';
      byteIndexInRow = withinRow - layout.hexWidth - layout.columnGap;
    }
    byteIndexInRow = Math.max(0, Math.min(byteIndexInRow, layout.bytesPerRow-1));
    return {region: region, byteIndex: rowFirstByte + byteIndexInRow};
  }
  function byteToHexCharRange(byteIndex){
    var row = Math.floor(byteIndex/layout.bytesPerRow);
    var byteIndexInRow = byteIndex % layout.bytesPerRow;
    var rowStart = row*layout.rowStride;
    var group = Math.floor(byteIndexInRow/layout.groupSize);
    var withinGroup = byteIndexInRow % layout.groupSize;
    var start = rowStart + group*(layout.groupSize*2+1) + withinGroup*2;
    return {start: start, end: start+2};
  }
  function byteToLatin1CharRange(byteIndex){
    var row = Math.floor(byteIndex/layout.bytesPerRow);
    var byteIndexInRow = byteIndex % layout.bytesPerRow;
    var rowStart = row*layout.rowStride;
    var start = rowStart + layout.hexWidth + layout.columnGap + byteIndexInRow;
    return {start: start, end: start+1};
  }
  function mapSelectionToMirroredRanges(absStart, absEnd){
    if (absEnd <= absStart) return [];
    var startCoord = charOffsetToByteCoordinate(absStart);
    var endCoord = charOffsetToByteCoordinate(Math.max(absStart, absEnd-1));
    var sourceRegion = startCoord.region;
    var targetRegion = sourceRegion === 'hex' ? 'latin1' : 'hex';
    var byteStart = startCoord.byteIndex;
    var byteEnd = endCoord.byteIndex + 1;
    if (byteEnd <= byteStart) return [];
    var firstRow = Math.floor(byteStart/layout.bytesPerRow);
    var lastRow = Math.floor((byteEnd-1)/layout.bytesPerRow);
    var ranges = [];
    for (var row=firstRow; row<=lastRow; row++){
      var rowFirstByte = row*layout.bytesPerRow;
      var rowLastByte = rowFirstByte + layout.bytesPerRow - 1;
      var coveredStart = Math.max(byteStart, rowFirstByte);
      var coveredEnd = Math.min(byteEnd-1, rowLastByte);
      if (coveredEnd < coveredStart) continue;
      var startRange = targetRegion==='hex' ? byteToHexCharRange(coveredStart) : byteToLatin1CharRange(coveredStart);
      var endRange = targetRegion==='hex' ? byteToHexCharRange(coveredEnd) : byteToLatin1CharRange(coveredEnd);
      ranges.push({start: startRange.start, end: endRange.end});
    }
    return ranges;
  }

  function absoluteOffsetOfNode(node, localOffset){
    var walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, null);
    var total = 0;
    var n;
    while ((n = walker.nextNode())) {
      if (n === node) return total + localOffset;
      total += n.textContent.length;
    }
    return total;
  }

  body.addEventListener('mousedown', function(){ resetHighlights(); });
  body.addEventListener('mouseup', function(){
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount===0) return;
    var range = sel.getRangeAt(0);
    if (!body.contains(range.startContainer) || !body.contains(range.endContainer)) return;
    var absStart = absoluteOffsetOfNode(range.startContainer, range.startOffset);
    var absEnd = absoluteOffsetOfNode(range.endContainer, range.endOffset);
    if (absEnd < absStart) { var t=absStart; absStart=absEnd; absEnd=t; }
    var mirrored = mapSelectionToMirroredRanges(absStart, absEnd);
    applyHighlights(body, mirrored, mirrorClass);
  });
}
})();</script>`;
}

// ---------------------------------------------------------------------------
// HTML assembly
// ---------------------------------------------------------------------------

const BASE_STYLE =
  'font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;line-height:1.5;white-space:pre;margin:0;';

function assembleHtml({ mode, bodyText, gutterText, config, layout }) {
  const P = sanitizeIdPrefix(config.idPrefix);
  const escapedBody = escapeForPre(bodyText);
  const gutterHtml = config.showLineNumbers
    ? `<pre style="${BASE_STYLE}text-align:right;padding-right:8px;margin-right:8px;border-right:1px solid #ccc;color:#888;user-select:none;">${escapeForPre(gutterText)}</pre>`
    : '';
  const bodyHtml = `<pre id="${P}-body" data-mode="${mode}" style="${BASE_STYLE}overflow-x:auto;flex:1;">${escapedBody}</pre>`;
  const findToolbar = config.interactive
    ? '<div style="display:flex;align-items:center;gap:6px;margin-bottom:8px;font-family:sans-serif;font-size:13px;">' +
      `<input id="${P}-find-input" type="text" placeholder="Find" style="font-family:inherit;">` +
      `<label style="display:flex;align-items:center;gap:2px;"><input id="${P}-find-regex" type="checkbox">regex</label>` +
      `<button id="${P}-find-prev" type="button">prev</button>` +
      `<button id="${P}-find-next" type="button">next</button>` +
      `<span id="${P}-match-count">0 / 0</span>` +
      '</div>'
    : '';
  const script = config.interactive ? buildClientScript(mode, layout, P) : '';
  return (
    `${findToolbar}<div style="display:flex;">${gutterHtml}${bodyHtml}</div>` +
    `<style>.${P}-match{background:#ffe58f;}.${P}-match-current{background:#ffa940;}.${P}-mirror{background:#91caff;}</style>` +
    script
  );
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Produces safe, ready-to-use HTML for a text or binary preview of
 * arbitrary bytes. Never throws.
 *
 * @param {Buffer} fileContent - the file's raw bytes
 * @param {boolean} isText - true: decode as UTF-8 and render as text.
 *   false: render as a hex + Latin-1 dump. Not inferred — the caller
 *   decides.
 * @param {object} [config] - overrides for DEFAULT_CONFIG
 * @returns {{ html: string, mode: 'text'|'binary', error: null } | { html: null, mode: null, error: { code: string, message: string } }}
 */
function getGenericPreview(fileContent, isText, config = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  let buffer;
  try {
    buffer = Buffer.isBuffer(fileContent) ? fileContent : Buffer.from(fileContent);
  } catch (err) {
    return failure(ErrorCode.PARSE_ERROR, `fileContent could not be read as a Buffer: ${err.message}`);
  }

  if (buffer.byteLength > cfg.maxFileSizeBytes) {
    return failure(ErrorCode.TOO_LARGE, `File is ${buffer.byteLength} bytes, exceeding the ${cfg.maxFileSizeBytes}-byte limit.`);
  }

  try {
    if (isText) {
      const decoded = buffer.toString('utf-8'); // invalid sequences already become U+FFFD, no extra handling needed
      const { text, gutterText } = buildPlainText(decoded, cfg);
      const html = assembleHtml({ mode: 'text', bodyText: text, gutterText, config: cfg, layout: null });
      return { html, mode: 'text', error: null };
    }

    const layout = computeRowLayout(cfg);
    const { text, gutterText } = buildHexDumpText(buffer, cfg);
    const html = assembleHtml({ mode: 'binary', bodyText: text, gutterText, config: cfg, layout });
    return { html, mode: 'binary', error: null };
  } catch (err) {
    return failure(ErrorCode.PARSE_ERROR, err && err.message ? err.message : String(err));
  }
}

module.exports = {
  getGenericPreview,
  // exported for unit testing / composition
  escapeForPre,
  wrapLinePreservingIndent,
  buildPlainText,
  computeOffsetWidth,
  formatOffset,
  computeRowLayout,
  buildLatin1Column,
  isLatin1ControlByte,
  sanitizeIdPrefix,
  byteToHexCharRange,
  byteToLatin1CharRange,
  buildHexDumpText,
  findMatches,
  charOffsetToByteCoordinate,
  mapSelectionToMirroredRanges,
  applyHighlights,
  assembleHtml,
  failure,
  ErrorCode,
  DEFAULT_CONFIG,
};
