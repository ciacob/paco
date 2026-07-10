'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  getGenericPreview,
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
  escapeRegExp,
  charOffsetToByteCoordinate,
  mapSelectionToMirroredRanges,
  applyHighlights,
  ErrorCode,
  DEFAULT_CONFIG,
} = require('../src/genericExtractor');

// ---------------------------------------------------------------------------
// escapeForPre — the verified safety primitive
// ---------------------------------------------------------------------------

/** Parses a string as HTML via jsdom's spec-compliant parser and returns the resulting textContent. */
function parseAsHtml(escapedHtml) {
  const dom = new JSDOM('<pre id="c"></pre>');
  const el = dom.window.document.getElementById('c');
  el.innerHTML = escapedHtml;
  return el.textContent;
}

test('escapeForPre: all 256 byte values round-trip positionally through real HTML parsing (jsdom/parse5)', () => {
  let all256 = '';
  for (let i = 0; i < 256; i++) all256 += String.fromCharCode(i);
  const parsed = parseAsHtml(escapeForPre(all256));
  assert.equal(parsed.length, 256, 'every byte must produce exactly one character, including NUL');
});

test('escapeForPre: every byte except NUL round-trips to its exact original character', () => {
  let all256 = '';
  for (let i = 0; i < 256; i++) all256 += String.fromCharCode(i);
  const parsed = parseAsHtml(escapeForPre(all256));
  for (let i = 1; i < 256; i++) {
    assert.equal(parsed.charCodeAt(i), i, `byte 0x${i.toString(16)} should round-trip exactly`);
  }
});

test('escapeForPre: NUL becomes U+FFFD — the one HTML-format-level exception, not implementation-avoidable', () => {
  const parsed = parseAsHtml(escapeForPre('A\x00B'));
  assert.equal(parsed.length, 3);
  assert.equal(parsed.charCodeAt(1), 0xfffd);
});

test('escapeForPre: CR round-trips to the exact literal CR character (not collapsed, not substituted to LF)', () => {
  const parsed = parseAsHtml(escapeForPre('A\rB'));
  assert.equal(parsed.length, 3);
  assert.equal(parsed.charCodeAt(1), 0x0d);
});

test('escapeForPre: a raw CRLF pair does not collapse — each byte survives as its own character', () => {
  const parsed = parseAsHtml(escapeForPre('A\r\nB'));
  assert.equal(parsed.length, 4);
  assert.equal(parsed.charCodeAt(1), 0x0d);
  assert.equal(parsed.charCodeAt(2), 0x0a);
});

test('escapeForPre: & < > are escaped as named entities and decode back to exactly one character each', () => {
  const parsed = parseAsHtml(escapeForPre('A&B<C>D'));
  assert.equal(parsed, 'A&B<C>D');
});

test('escapeForPre: ordinary text is passed through unchanged', () => {
  assert.equal(escapeForPre('hello world 123'), 'hello world 123');
});

// ---------------------------------------------------------------------------
// wrapLinePreservingIndent
// ---------------------------------------------------------------------------

test('wrapLinePreservingIndent: returns the line unchanged if it fits', () => {
  assert.deepEqual(wrapLinePreservingIndent('short', 80), ['short']);
});

test('wrapLinePreservingIndent: returns the line unchanged if wrapColumn is falsy', () => {
  assert.deepEqual(wrapLinePreservingIndent('x'.repeat(200), null), ['x'.repeat(200)]);
  assert.deepEqual(wrapLinePreservingIndent('x'.repeat(200), 0), ['x'.repeat(200)]);
});

test('wrapLinePreservingIndent: wraps and repeats the original indent on continuation lines', () => {
  const line = '    ' + 'a'.repeat(20); // 4-space indent + 20 chars = 24 total
  const wrapped = wrapLinePreservingIndent(line, 10);
  assert.equal(wrapped[0], '    aaaaaa'); // first 10 chars, includes the indent naturally
  for (let i = 1; i < wrapped.length; i++) {
    assert.ok(wrapped[i].startsWith('    '), `continuation line ${i} should start with the original indent`);
  }
  // rejoining (concept-check): the non-indent content should be fully preserved
  const reassembled = wrapped[0] + wrapped.slice(1).map((l) => l.slice(4)).join('');
  assert.equal(reassembled, line);
});

test('wrapLinePreservingIndent: handles pathological indent >= wrapColumn without hanging or producing empty chunks', () => {
  const line = ' '.repeat(50) + 'content-after-deep-indent';
  const wrapped = wrapLinePreservingIndent(line, 10);
  assert.ok(wrapped.length > 1);
  assert.ok(wrapped.every((l) => l.length > 0));
});

test('wrapLinePreservingIndent: tabs count as indent characters too', () => {
  const line = '\t\tcontent-is-here-and-fairly-long';
  const wrapped = wrapLinePreservingIndent(line, 15);
  assert.ok(wrapped.length > 1);
  assert.ok(wrapped[1].startsWith('\t\t'));
});

// ---------------------------------------------------------------------------
// buildPlainText
// ---------------------------------------------------------------------------

test('buildPlainText: no wrapping — one gutter entry per source line, sequential numbers', () => {
  const { text, gutterText, lineCount } = buildPlainText('line one\nline two\nline three', { wrapColumn: null });
  assert.equal(text, 'line one\nline two\nline three');
  assert.equal(gutterText, '1\n2\n3');
  assert.equal(lineCount, 3);
});

test('buildPlainText: wrapping produces blank gutter entries for continuation lines', () => {
  const { text, gutterText, lineCount } = buildPlainText('a'.repeat(25) + '\nshort', { wrapColumn: 10 });
  const bodyLines = text.split('\n');
  const gutterLines = gutterText.split('\n');
  assert.equal(bodyLines.length, gutterLines.length, 'body and gutter must stay row-count-synced');
  assert.equal(gutterLines[0], '1');
  assert.equal(gutterLines[1], ''); // continuation of line 1
  assert.equal(gutterLines[gutterLines.length - 1], '2'); // "short" is source line 2
  assert.equal(lineCount, bodyLines.length);
});

test('buildPlainText: an empty string produces one empty line, numbered 1', () => {
  const { text, gutterText, lineCount } = buildPlainText('', { wrapColumn: null });
  assert.equal(text, '');
  assert.equal(gutterText, '1');
  assert.equal(lineCount, 1);
});

// ---------------------------------------------------------------------------
// computeOffsetWidth / formatOffset
// ---------------------------------------------------------------------------

test('computeOffsetWidth: hex width scales with file size, minimum 4', () => {
  assert.equal(computeOffsetWidth(10, 'hex'), 4);
  assert.equal(computeOffsetWidth(0x100000, 'hex'), 5); // max offset 0xFFFFF -> 5 hex digits
});

test('computeOffsetWidth: decimal width scales with file size, minimum 1', () => {
  assert.equal(computeOffsetWidth(1, 'decimal'), 1);
  assert.equal(computeOffsetWidth(100000, 'decimal'), 5); // max offset 99999 -> 5 digits
});

test('formatOffset: hex is uppercase and zero-padded', () => {
  assert.equal(formatOffset(255, 'hex', 4), '00FF');
});

test('formatOffset: decimal is zero-padded', () => {
  assert.equal(formatOffset(42, 'decimal', 6), '000042');
});

// ---------------------------------------------------------------------------
// computeRowLayout / byte <-> char range conversions
// ---------------------------------------------------------------------------

test('computeRowLayout: matches hand-computed values for the default 16-bytes-per-row, groupSize-1 config', () => {
  const layout = computeRowLayout({ bytesPerRow: 16, groupSize: 1, columnGap: 4 });
  assert.equal(layout.hexWidth, 16 * 2 + 15); // 16 hex-digit-pairs + 15 separating spaces
  assert.equal(layout.latin1Width, 16);
  assert.equal(layout.rowWidth, layout.hexWidth + 4 + 16);
  assert.equal(layout.rowStride, layout.rowWidth + 1);
});

test('byteToHexCharRange: byte 0 of row 0 starts at character 0, spans 2 chars', () => {
  const layout = computeRowLayout({ bytesPerRow: 16, groupSize: 1, columnGap: 4 });
  assert.deepEqual(byteToHexCharRange(layout, 0), { start: 0, end: 2 });
});

test('byteToHexCharRange: byte 1 starts right after byte 0 plus one separating space', () => {
  const layout = computeRowLayout({ bytesPerRow: 16, groupSize: 1, columnGap: 4 });
  assert.deepEqual(byteToHexCharRange(layout, 1), { start: 3, end: 5 });
});

test('byteToHexCharRange: first byte of row 1 accounts for the full row stride', () => {
  const layout = computeRowLayout({ bytesPerRow: 16, groupSize: 1, columnGap: 4 });
  const range = byteToHexCharRange(layout, 16); // byte 16 = first byte of row 1
  assert.equal(range.start, layout.rowStride);
});

test('byteToLatin1CharRange: byte 0 of a row starts right after the hex column and gap', () => {
  const layout = computeRowLayout({ bytesPerRow: 16, groupSize: 1, columnGap: 4 });
  const range = byteToLatin1CharRange(layout, 0);
  assert.equal(range.start, layout.hexWidth + layout.columnGap);
  assert.equal(range.end, range.start + 1);
});

test('byteToHexCharRange/byteToLatin1CharRange: groupSize > 1 is accounted for correctly', () => {
  const layout = computeRowLayout({ bytesPerRow: 8, groupSize: 4, columnGap: 2 });
  // group 0 = bytes 0-3 ("XXXXXXXX"), group 1 = bytes 4-7, separated by 1 space
  assert.deepEqual(byteToHexCharRange(layout, 0), { start: 0, end: 2 });
  assert.deepEqual(byteToHexCharRange(layout, 3), { start: 6, end: 8 });
  assert.deepEqual(byteToHexCharRange(layout, 4), { start: 9, end: 11 }); // after the inter-group space
});

// ---------------------------------------------------------------------------
// isLatin1ControlByte / buildLatin1Column — all control characters -> '.'
// ---------------------------------------------------------------------------

test('isLatin1ControlByte: true for the full C0 range (0x00-0x1F) and DEL (0x7F)', () => {
  for (let b = 0x00; b <= 0x1f; b++) assert.equal(isLatin1ControlByte(b), true, `0x${b.toString(16)}`);
  assert.equal(isLatin1ControlByte(0x7f), true);
});

test('isLatin1ControlByte: true for the full C1 range (0x80-0x9F)', () => {
  for (let b = 0x80; b <= 0x9f; b++) assert.equal(isLatin1ControlByte(b), true, `0x${b.toString(16)}`);
});

test('isLatin1ControlByte: false immediately outside both ranges and for ordinary printable bytes', () => {
  assert.equal(isLatin1ControlByte(0x20), false); // space, first byte after C0
  assert.equal(isLatin1ControlByte(0x7e), false); // '~', last byte before DEL
  assert.equal(isLatin1ControlByte(0xa0), false); // first byte after C1
  assert.equal(isLatin1ControlByte(0x41), false); // 'A'
  assert.equal(isLatin1ControlByte(0xff), false); // 'ÿ'
});

test('buildLatin1Column: every control character becomes "."', () => {
  const buf = Buffer.from([0x41, 0x00, 0x0d, 0x0a, 0x09, 0x1f, 0x7f, 0x80, 0x9f, 0x42]);
  assert.equal(buildLatin1Column(buf), 'A........B');
});

test('buildLatin1Column: non-control bytes pass through as their true Latin-1 character', () => {
  const buf = Buffer.from([0x20, 0x41, 0x7e, 0xa0, 0xff]);
  const result = buildLatin1Column(buf);
  assert.equal(result.length, 5);
  for (let i = 0; i < buf.length; i++) {
    assert.equal(result.charCodeAt(i), buf[i]);
  }
});

// ---------------------------------------------------------------------------
// buildHexDumpText
// ---------------------------------------------------------------------------

test('buildHexDumpText: matches the exact hand-example format ("50 4B 03 04 ...")', () => {
  const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00, 0x08, 0x00, 0x00, 0x00, 0x21, 0x00, 0x32, 0x91, 0x6f, 0x57, 0x66, 0x01]);
  const { text } = buildHexDumpText(bytes, { bytesPerRow: 20, groupSize: 1, columnGap: 4, offsetFormat: 'hex' });
  const hexPortion = text.slice(0, text.indexOf('    '));
  assert.equal(hexPortion, '50 4B 03 04 14 00 06 00 08 00 00 00 21 00 32 91 6F 57 66 01');
});

test('buildHexDumpText: a short final row pads the hex column so Latin-1 stays aligned', () => {
  const bytes = Buffer.from([0x41, 0x42, 0x43]); // 3 bytes, bytesPerRow 16 -> one short row
  const { text } = buildHexDumpText(bytes, { bytesPerRow: 16, groupSize: 1, columnGap: 4, offsetFormat: 'hex' });
  const layout = computeRowLayout({ bytesPerRow: 16, groupSize: 1, columnGap: 4 });
  assert.equal(text.length, layout.hexWidth + 4 + 3); // padded hex + gap + only the 3 real latin1 chars
  assert.ok(text.startsWith('41 42 43'));
  assert.ok(text.endsWith('ABC'));
});

test('buildHexDumpText: an empty buffer produces one (empty) line, not zero and not a crash', () => {
  const { text, lineCount } = buildHexDumpText(Buffer.alloc(0), { bytesPerRow: 16, groupSize: 1, columnGap: 4, offsetFormat: 'hex' });
  assert.equal(text, '');
  assert.equal(lineCount, 1);
});

test('buildHexDumpText: gutter offsets increase by bytesPerRow per row, formatted per offsetFormat', () => {
  const bytes = Buffer.alloc(40); // 3 rows at bytesPerRow=16; max offset 32 -> width 2
  const { gutterText } = buildHexDumpText(bytes, { bytesPerRow: 16, groupSize: 1, columnGap: 4, offsetFormat: 'decimal' });
  assert.deepEqual(gutterText.split('\n'), ['00', '16', '32']);
});

test('buildHexDumpText: multi-row output has exactly one \\n per row boundary, no extras from embedded LF bytes', () => {
  const bytes = Buffer.from([...Array(16).fill(0x0a), ...Array(16).fill(0x41)]); // row 1 all LF bytes, row 2 all 'A'
  const { text, lineCount } = buildHexDumpText(bytes, { bytesPerRow: 16, groupSize: 1, columnGap: 4, offsetFormat: 'hex' });
  assert.equal(text.split('\n').length, 2);
  assert.equal(lineCount, 2);
});

// ---------------------------------------------------------------------------
// findMatches
// ---------------------------------------------------------------------------

test('findMatches: plain substring, multiple non-overlapping matches', () => {
  const matches = findMatches('abXabXab', 'ab', false);
  assert.deepEqual(matches, [
    { start: 0, end: 2 },
    { start: 3, end: 5 },
    { start: 6, end: 8 },
  ]);
});

test('findMatches: plain substring, no matches', () => {
  assert.deepEqual(findMatches('hello', 'xyz', false), []);
});

test('findMatches: empty query yields no matches', () => {
  assert.deepEqual(findMatches('hello', '', false), []);
});

test('findMatches: regex mode with a capture group still reports the full match span', () => {
  const matches = findMatches('foo123bar456', '\\d+', true);
  assert.deepEqual(matches, [
    { start: 3, end: 6 },
    { start: 9, end: 12 },
  ]);
});

test('findMatches: invalid regex yields no matches, never throws', () => {
  assert.doesNotThrow(() => {
    const matches = findMatches('hello', '(unclosed', true);
    assert.deepEqual(matches, []);
  });
});

test('findMatches: zero-length regex matches do not cause an infinite loop', () => {
  const start = Date.now();
  const matches = findMatches('abc', 'x*', true); // matches empty string at every position
  assert.ok(Date.now() - start < 1000, 'should terminate quickly');
  assert.ok(matches.length > 0);
});

test('findMatches: plain mode is case-sensitive by default (caseInsensitive omitted) — unchanged from before this parameter existed', () => {
  assert.deepEqual(findMatches('Hello WORLD hello', 'hello', false), [{ start: 12, end: 17 }]);
});

test('findMatches: plain mode, caseInsensitive:true matches regardless of case', () => {
  const matches = findMatches('Hello WORLD hello', 'hello', false, true);
  assert.deepEqual(matches, [
    { start: 0, end: 5 },
    { start: 12, end: 17 },
  ]);
});

test('findMatches: regex mode is case-sensitive by default (caseInsensitive omitted)', () => {
  assert.deepEqual(findMatches('Cat cat CAT', 'cat', true), [{ start: 4, end: 7 }]);
});

test('findMatches: regex mode, caseInsensitive:true adds the "i" flag', () => {
  const matches = findMatches('Cat cat CAT', 'cat', true, true);
  assert.deepEqual(matches, [
    { start: 0, end: 3 },
    { start: 4, end: 7 },
    { start: 8, end: 11 },
  ]);
});

test('findMatches: plain mode + caseInsensitive with a query containing regex-special characters matches LITERALLY, not as a pattern', () => {
  // The actual mechanism under test: case-insensitive plain mode now
  // routes through the regex engine (see findMatches' own comment for
  // why — avoiding toLowerCase() on a potentially large haystack), so a
  // query like "$5.00" must be escaped before becoming a RegExp, or "."
  // would match any character and "$" would anchor to end-of-string,
  // silently corrupting what was supposed to be a literal substring search.
  const matches = findMatches('Price: $5.00 (was $10.00)', '$5.00', false, true);
  assert.deepEqual(matches, [{ start: 7, end: 12 }]); // exactly one match, not also matching "$10.00" or misbehaving
});

test('findMatches: a plain-mode query that looks like a regex quantifier ("a+b") is still a literal search, case-insensitive or not', () => {
  assert.deepEqual(findMatches('a+b axxxb A+B', 'a+b', false), [{ start: 0, end: 3 }]);
  assert.deepEqual(findMatches('a+b axxxb A+B', 'a+b', false, true), [
    { start: 0, end: 3 },
    { start: 10, end: 13 },
  ]);
});

test('escapeRegExp: escapes every regex-special character', () => {
  const special = '.*+?^${}()|[]\\';
  const escaped = escapeRegExp(special);
  // Using the escaped output as a regex pattern should match the
  // original string literally, character for character.
  const re = new RegExp('^' + escaped + '$');
  assert.ok(re.test(special));
});

test('escapeRegExp: leaves ordinary characters untouched', () => {
  assert.equal(escapeRegExp('hello world 123'), 'hello world 123');
});

// ---------------------------------------------------------------------------
// charOffsetToByteCoordinate / mapSelectionToMirroredRanges
// ---------------------------------------------------------------------------

test('charOffsetToByteCoordinate: identifies the hex region correctly', () => {
  const layout = computeRowLayout({ bytesPerRow: 16, groupSize: 1, columnGap: 4 });
  const coord = charOffsetToByteCoordinate(layout, 100, 0); // offset 0 = first hex digit of byte 0
  assert.equal(coord.region, 'hex');
  assert.equal(coord.byteIndex, 0);
});

test('charOffsetToByteCoordinate: identifies the latin1 region correctly', () => {
  const layout = computeRowLayout({ bytesPerRow: 16, groupSize: 1, columnGap: 4 });
  const offset = layout.hexWidth + layout.columnGap; // first latin1 char of row 0
  const coord = charOffsetToByteCoordinate(layout, 100, offset);
  assert.equal(coord.region, 'latin1');
  assert.equal(coord.byteIndex, 0);
});

test('charOffsetToByteCoordinate: row 1 offsets resolve to bytes 16-31', () => {
  const layout = computeRowLayout({ bytesPerRow: 16, groupSize: 1, columnGap: 4 });
  const coord = charOffsetToByteCoordinate(layout, 100, layout.rowStride); // first char of row 1
  assert.equal(coord.byteIndex, 16);
});

test('mapSelectionToMirroredRanges: a selection fully within one row of the hex region mirrors to the matching latin1 span', () => {
  const layout = computeRowLayout({ bytesPerRow: 16, groupSize: 1, columnGap: 4 });
  // select bytes 0-2 in the hex region (chars 0 through the end of byte 2's hex digits)
  const hexStart = byteToHexCharRange(layout, 0).start;
  const hexEnd = byteToHexCharRange(layout, 2).end;
  const mirrored = mapSelectionToMirroredRanges(layout, 100, hexStart, hexEnd);
  assert.equal(mirrored.length, 1);
  const expectedLatin1Start = byteToLatin1CharRange(layout, 0).start;
  const expectedLatin1End = byteToLatin1CharRange(layout, 2).end;
  assert.deepEqual(mirrored[0], { start: expectedLatin1Start, end: expectedLatin1End });
});

test('mapSelectionToMirroredRanges: a selection in the latin1 region mirrors back to the hex region', () => {
  const layout = computeRowLayout({ bytesPerRow: 16, groupSize: 1, columnGap: 4 });
  const latin1Start = byteToLatin1CharRange(layout, 5).start;
  const latin1End = byteToLatin1CharRange(layout, 7).end;
  const mirrored = mapSelectionToMirroredRanges(layout, 100, latin1Start, latin1End);
  assert.equal(mirrored.length, 1);
  const expectedHexStart = byteToHexCharRange(layout, 5).start;
  const expectedHexEnd = byteToHexCharRange(layout, 7).end;
  assert.deepEqual(mirrored[0], { start: expectedHexStart, end: expectedHexEnd });
});

test('mapSelectionToMirroredRanges: a selection spanning multiple rows produces one mirrored range per row', () => {
  const layout = computeRowLayout({ bytesPerRow: 16, groupSize: 1, columnGap: 4 });
  // select from byte 10 of row 0 through byte 5 of row 1 (byte 21 overall), in the hex region
  const hexStart = byteToHexCharRange(layout, 10).start;
  const hexEnd = byteToHexCharRange(layout, 21).end;
  const mirrored = mapSelectionToMirroredRanges(layout, 100, hexStart, hexEnd);
  assert.equal(mirrored.length, 2, 'should produce exactly one mirrored range per affected row');
  // first range covers bytes 10-15 (rest of row 0) in latin1
  assert.deepEqual(mirrored[0], { start: byteToLatin1CharRange(layout, 10).start, end: byteToLatin1CharRange(layout, 15).end });
  // second range covers bytes 16-21 (start of row 1) in latin1
  assert.deepEqual(mirrored[1], { start: byteToLatin1CharRange(layout, 16).start, end: byteToLatin1CharRange(layout, 21).end });
});

test('mapSelectionToMirroredRanges: a collapsed/empty selection produces no ranges', () => {
  const layout = computeRowLayout({ bytesPerRow: 16, groupSize: 1, columnGap: 4 });
  assert.deepEqual(mapSelectionToMirroredRanges(layout, 100, 5, 5), []);
  assert.deepEqual(mapSelectionToMirroredRanges(layout, 100, 5, 3), []);
});

// ---------------------------------------------------------------------------
// applyHighlights (DOM-touching, tested via jsdom)
// ---------------------------------------------------------------------------

function makeContainer(text) {
  const dom = new JSDOM('<pre id="c"></pre>');
  const el = dom.window.document.getElementById('c');
  el.textContent = text;
  return el;
}

test('applyHighlights: wraps a single range in a span with the given class', () => {
  const container = makeContainer('hello world');
  applyHighlights(container, [{ start: 6, end: 11 }], 'hl');
  assert.equal(container.innerHTML, 'hello <span class="hl">world</span>');
});

test('applyHighlights: wraps multiple non-overlapping ranges correctly, preserving text in between', () => {
  const container = makeContainer('abXabXab');
  applyHighlights(container, [
    { start: 0, end: 2 },
    { start: 3, end: 5 },
    { start: 6, end: 8 },
  ], 'm');
  assert.equal(container.textContent, 'abXabXab');
  assert.equal(container.querySelectorAll('span.m').length, 3);
});

test('applyHighlights: an empty range list is a no-op', () => {
  const container = makeContainer('unchanged');
  applyHighlights(container, [], 'hl');
  assert.equal(container.innerHTML, 'unchanged');
});

test('applyHighlights: reset-then-reapply (the documented discipline) always starts from a clean single text node', () => {
  const container = makeContainer('abcdef');
  applyHighlights(container, [{ start: 1, end: 3 }], 'first');
  assert.ok(container.querySelector('span.first'));
  // the documented reset step
  container.textContent = container.textContent;
  assert.equal(container.childNodes.length, 1);
  assert.equal(container.firstChild.nodeType, 3); // TEXT_NODE
  applyHighlights(container, [{ start: 2, end: 4 }], 'second');
  assert.equal(container.textContent, 'abcdef');
  assert.ok(container.querySelector('span.second'));
  assert.equal(container.querySelectorAll('span.first').length, 0);
});

// ---------------------------------------------------------------------------
// getGenericPreview — integration
// ---------------------------------------------------------------------------

test('getGenericPreview: text mode produces one <pre>, preserves line breaks, no line-number gutter by default', () => {
  const result = getGenericPreview(Buffer.from('line one\nline two', 'utf-8'), true);
  assert.equal(result.error, null);
  assert.equal(result.mode, 'text');
  const dom = new JSDOM(`<div id="root">${result.html}</div>`);
  const pres = dom.window.document.querySelectorAll('pre');
  assert.equal(pres.length, 1);
  assert.equal(pres[0].textContent, 'line one\nline two');
});

test('getGenericPreview: text mode with showLineNumbers renders exactly two <pre> elements', () => {
  const result = getGenericPreview(Buffer.from('a\nb\nc', 'utf-8'), true, { showLineNumbers: true });
  assert.equal(result.error, null);
  const dom = new JSDOM(`<div id="root">${result.html}</div>`);
  assert.equal(dom.window.document.querySelectorAll('pre').length, 2);
});

test('getGenericPreview: text mode decodes UTF-8, including multi-byte characters', () => {
  const result = getGenericPreview(Buffer.from('héllo wörld 日本語', 'utf-8'), true);
  assert.equal(result.error, null);
  const dom = new JSDOM(`<div id="root">${result.html}</div>`);
  assert.equal(dom.window.document.getElementById('ge-body').textContent, 'héllo wörld 日本語');
});

test('getGenericPreview: text mode with invalid UTF-8 bytes does not throw (replacement characters, per Node default)', () => {
  const invalidUtf8 = Buffer.from([0x68, 0x65, 0xff, 0xfe, 0x6c, 0x6c, 0x6f]);
  const result = getGenericPreview(invalidUtf8, true);
  assert.equal(result.error, null);
  assert.equal(result.mode, 'text');
});

test('getGenericPreview: binary mode produces exactly two <pre> elements total, regardless of file size', () => {
  const bytes = Buffer.alloc(2000, 0x41); // 2000 bytes, ~125 rows at default bytesPerRow
  const result = getGenericPreview(bytes, false, { showLineNumbers: true });
  assert.equal(result.error, null);
  assert.equal(result.mode, 'binary');
  const dom = new JSDOM(`<div id="root">${result.html}</div>`);
  assert.equal(dom.window.document.querySelectorAll('pre').length, 2);
});

test('getGenericPreview: binary mode without showLineNumbers renders exactly one <pre>', () => {
  const result = getGenericPreview(Buffer.from([1, 2, 3]), false, { showLineNumbers: false });
  const dom = new JSDOM(`<div id="root">${result.html}</div>`);
  assert.equal(dom.window.document.querySelectorAll('pre').length, 1);
});

test('getGenericPreview: interactive: false omits the <script> tag entirely', () => {
  const result = getGenericPreview(Buffer.from('hello', 'utf-8'), true, { interactive: false });
  assert.equal(result.error, null);
  assert.doesNotMatch(result.html, /<script/);
});

test('getGenericPreview: interactive: true (default) includes a <script> tag', () => {
  const result = getGenericPreview(Buffer.from('hello', 'utf-8'), true, { interactive: true });
  assert.match(result.html, /<script/);
});

test('getGenericPreview: too-large is rejected before any processing', () => {
  const result = getGenericPreview(Buffer.alloc(1000), true, { maxFileSizeBytes: 10 });
  assert.equal(result.html, null);
  assert.equal(result.mode, null);
  assert.equal(result.error.code, ErrorCode.TOO_LARGE);
  assert.match(result.error.message, /1000/);
});

test('getGenericPreview: accepts a non-Buffer array-like and coerces it', () => {
  const bytes = Array.from(Buffer.from('hello', 'utf-8'));
  const result = getGenericPreview(bytes, true);
  assert.equal(result.error, null);
  assert.equal(result.mode, 'text');
});

test('getGenericPreview: a file containing NUL, CR, LF, and TAB bytes in binary mode never throws and produces valid, position-correct markup', () => {
  const bytes = Buffer.from([0x50, 0x4b, 0x00, 0x0d, 0x0a, 0x09, 0xff, 0x80, 0x41]);
  const result = getGenericPreview(bytes, false, { bytesPerRow: 9 });
  assert.equal(result.error, null);
  const dom = new JSDOM(`<div id="root">${result.html}</div>`);
  const body = dom.window.document.getElementById('ge-body');
  const row = body.textContent.split('\n')[0];
  assert.equal(row.split('\n').length, 1); // sanity: no stray newline within the row itself
  // NUL, CR, LF, TAB, and 0x80 are all control characters -> '.'; 0xFF and 0x41 pass through exactly.
  assert.ok(row.endsWith('PK....\u00ff.A'));
});

test('getGenericPreview: empty buffer in both modes never throws', () => {
  const textResult = getGenericPreview(Buffer.alloc(0), true);
  assert.equal(textResult.error, null);
  const binaryResult = getGenericPreview(Buffer.alloc(0), false);
  assert.equal(binaryResult.error, null);
});

test('getGenericPreview: default config never throws for a moderately large realistic buffer', () => {
  const bytes = Buffer.alloc(100_000);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
  const result = getGenericPreview(bytes, false);
  assert.equal(result.error, null);
  const dom = new JSDOM(`<div id="root">${result.html}</div>`);
  assert.ok(dom.window.document.getElementById('ge-body').textContent.length > 0);
});

// ---------------------------------------------------------------------------
// idPrefix — multi-instance-on-one-page support
// ---------------------------------------------------------------------------

test('sanitizeIdPrefix: accepts valid identifier-like strings unchanged', () => {
  assert.equal(sanitizeIdPrefix('file1'), 'file1');
  assert.equal(sanitizeIdPrefix('my-prefix_2'), 'my-prefix_2');
});

test('sanitizeIdPrefix: falls back to "ge" for invalid or empty input, never throws', () => {
  assert.equal(sanitizeIdPrefix(''), 'ge');
  assert.equal(sanitizeIdPrefix(null), 'ge');
  assert.equal(sanitizeIdPrefix(undefined), 'ge');
  assert.equal(sanitizeIdPrefix('123starts-with-digit'), 'ge');
  assert.equal(sanitizeIdPrefix('has spaces'), 'ge');
  assert.equal(sanitizeIdPrefix('<script>'), 'ge');
  assert.equal(sanitizeIdPrefix('"onmouseover=alert(1)'), 'ge');
});

test('getGenericPreview: idPrefix changes every generated element id and CSS class consistently', () => {
  const result = getGenericPreview(Buffer.from('hello'), true, { idPrefix: 'file1', interactive: true });
  assert.equal(result.error, null);
  assert.match(result.html, /id="file1-body"/);
  assert.match(result.html, /id="file1-find-input"/);
  assert.match(result.html, /\.file1-match\{/);
  assert.doesNotMatch(result.html, /id="ge-body"/);
});

test('getGenericPreview: an invalid idPrefix falls back to the default rather than producing broken/unsafe markup', () => {
  const result = getGenericPreview(Buffer.from('hello'), true, { idPrefix: '"><script>alert(1)</script>' });
  assert.equal(result.error, null);
  assert.doesNotMatch(result.html, /<script>alert/);
  assert.match(result.html, /id="ge-body"/);
});

test('getGenericPreview: two previews with distinct idPrefix values coexist on one page without collisions', () => {
  const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  const first = getGenericPreview(bytes, false, { idPrefix: 'a', bytesPerRow: 4 });
  const second = getGenericPreview(bytes, false, { idPrefix: 'b', bytesPerRow: 4 });
  const dom = new JSDOM(`<div id="root"><div>${first.html}</div><div>${second.html}</div></div>`);
  const doc = dom.window.document;
  assert.ok(doc.getElementById('a-body'));
  assert.ok(doc.getElementById('b-body'));
  assert.notEqual(doc.getElementById('a-body'), doc.getElementById('b-body'));
});

// ---------------------------------------------------------------------------
// Find UI — static markup
// ---------------------------------------------------------------------------

test('getGenericPreview: Find UI has a leading "Find:" label and a hint-style placeholder, not a bare "Find" placeholder', () => {
  const result = getGenericPreview(Buffer.from('hello world'), true);
  const dom = new JSDOM(`<div id="root">${result.html}</div>`);
  const doc = dom.window.document;
  assert.match(doc.getElementById('ge-find-toolbar').textContent, /Find:/);
  assert.equal(doc.getElementById('ge-find-input').getAttribute('placeholder'), 'Type and press Enter');
});

test('getGenericPreview: "case insensitive" checkbox is present, labelled, and preselected (checked) by default', () => {
  const result = getGenericPreview(Buffer.from('hello world'), true);
  const dom = new JSDOM(`<div id="root">${result.html}</div>`);
  const doc = dom.window.document;
  const checkbox = doc.getElementById('ge-find-case-insensitive');
  assert.ok(checkbox);
  assert.equal(checkbox.checked, true);
  assert.match(doc.getElementById('ge-find-toolbar').textContent, /case insensitive/);
});

test('getGenericPreview: prev/next buttons start disabled — no search has run yet, so neither has anything to do', () => {
  const result = getGenericPreview(Buffer.from('hello world'), true);
  const dom = new JSDOM(`<div id="root">${result.html}</div>`);
  const doc = dom.window.document;
  assert.equal(doc.getElementById('ge-find-prev').disabled, true);
  assert.equal(doc.getElementById('ge-find-next').disabled, true);
});

test('getGenericPreview: match counter is non-wrapping and muted', () => {
  const result = getGenericPreview(Buffer.from('hello world'), true);
  const dom = new JSDOM(`<div id="root">${result.html}</div>`);
  const counter = dom.window.document.getElementById('ge-match-count');
  assert.match(counter.getAttribute('style'), /white-space:\s*nowrap/);
  assert.match(counter.getAttribute('style'), /opacity:\s*0\.7/);
});

test('getGenericPreview: disabled prev/next buttons force color:inherit (overriding any browser-native disabled-widget color) plus opacity for the muted look', () => {
  const result = getGenericPreview(Buffer.from('hello world'), true);
  assert.match(result.html, /#ge-find-toolbar button:disabled\{color:inherit;opacity:0\.7;\}/);
});

test('getGenericPreview: Find toolbar is fixed-positioned with a translucent, blurred background, and the content row has an id for the client script to pad', () => {
  const result = getGenericPreview(Buffer.from('hello world'), true);
  const dom = new JSDOM(`<div id="root">${result.html}</div>`);
  const doc = dom.window.document;
  const toolbarStyle = doc.getElementById('ge-find-toolbar').getAttribute('style');
  assert.match(toolbarStyle, /position:\s*fixed/);
  assert.match(toolbarStyle, /rgba\(0,\s*0,\s*0,\s*0\.1\)/);
  assert.match(toolbarStyle, /backdrop-filter:\s*blur\(10px\)/);
  assert.match(toolbarStyle, /-webkit-backdrop-filter:\s*blur\(10px\)/);
  assert.ok(doc.getElementById('ge-content'));
});

// ---------------------------------------------------------------------------
// Find UI — actual interactive behavior (executing the real <script>, not
// just checking static markup shape — nothing else in this file runs the
// script itself, since JSDOM only executes it with runScripts:'dangerously')
// ---------------------------------------------------------------------------

function domWithScriptRun(html) {
  const dom = new JSDOM(`<!doctype html><html><body><div id="root">${html}</div></body></html>`, {
    runScripts: 'dangerously',
  });
  return dom;
}

function pressEnter(input) {
  input.dispatchEvent(new input.ownerDocument.defaultView.KeyboardEvent('keydown', { key: 'Enter' }));
}

test('Find UI: case-insensitive checkbox stays checked by default — a differently-cased query still finds the match', () => {
  const result = getGenericPreview(Buffer.from('The Quick Brown Fox'), true);
  const dom = domWithScriptRun(result.html);
  const doc = dom.window.document;
  const input = doc.getElementById('ge-find-input');
  assert.equal(doc.getElementById('ge-find-case-insensitive').checked, true, 'preselected, untouched');
  input.value = 'quick'; // lowercase query against "Quick" in the text
  pressEnter(input);
  assert.equal(doc.getElementById('ge-match-count').textContent, '1 / 1');
});

test('Find UI: unchecking case-insensitive makes the search case-sensitive again', () => {
  const result = getGenericPreview(Buffer.from('The Quick Brown Fox'), true);
  const dom = domWithScriptRun(result.html);
  const doc = dom.window.document;
  const input = doc.getElementById('ge-find-input');
  const caseToggle = doc.getElementById('ge-find-case-insensitive');
  caseToggle.checked = false;
  input.value = 'quick'; // lowercase query, but "Quick" in the text is capitalized
  pressEnter(input);
  assert.equal(doc.getElementById('ge-match-count').textContent, '0 / 0', 'case-sensitive now, no match for the differently-cased query');
});

test('Find UI: a case-insensitive query containing regex-special characters matches literally, through the REAL generated client-side script', () => {
  // Regression test for the actual bug this feature shipped with and had
  // to be fixed: within buildClientScript's outer template literal, `\]`
  // isn't a recognized JS escape sequence, so its backslash was silently
  // dropped ("identity escape"), breaking escapeRegExp's own regex
  // character class in the generated <script> specifically — the
  // server-side, unit-tested copy was never affected, only the
  // client-side mirror actually shipped to the browser. Exercises the
  // real generated HTML+script end to end, not the server-side function
  // directly, since that's the only way this specific bug would surface.
  const result = getGenericPreview(Buffer.from('Price: $5.00 (was $10.00)'), true);
  const dom = domWithScriptRun(result.html);
  const doc = dom.window.document;
  const input = doc.getElementById('ge-find-input');
  input.value = '$5.00'; // caseInsensitive stays checked (default) — routes through the regex path
  pressEnter(input);
  assert.equal(doc.getElementById('ge-match-count').textContent, '1 / 1', 'exactly one literal match, not corrupted by unescaped regex metacharacters');
});

test('Find UI: a query with multiple matches enables next but not prev (starts on the first match)', () => {
  const result = getGenericPreview(Buffer.from('cat dog cat bird cat'), true);
  const dom = domWithScriptRun(result.html);
  const doc = dom.window.document;
  const input = doc.getElementById('ge-find-input');
  input.value = 'cat';
  pressEnter(input);
  assert.equal(doc.getElementById('ge-match-count').textContent, '1 / 3');
  assert.equal(doc.getElementById('ge-find-prev').disabled, true, 'already on the first match');
  assert.equal(doc.getElementById('ge-find-next').disabled, false);
});

test('Find UI: a query with exactly one match disables both buttons — nowhere to go in either direction', () => {
  const result = getGenericPreview(Buffer.from('cat dog bird'), true);
  const dom = domWithScriptRun(result.html);
  const doc = dom.window.document;
  const input = doc.getElementById('ge-find-input');
  input.value = 'dog';
  pressEnter(input);
  assert.equal(doc.getElementById('ge-match-count').textContent, '1 / 1');
  assert.equal(doc.getElementById('ge-find-prev').disabled, true);
  assert.equal(doc.getElementById('ge-find-next').disabled, true);
});

test('Find UI: a query with zero matches leaves both buttons disabled', () => {
  const result = getGenericPreview(Buffer.from('cat dog bird'), true);
  const dom = domWithScriptRun(result.html);
  const doc = dom.window.document;
  const input = doc.getElementById('ge-find-input');
  input.value = 'elephant';
  pressEnter(input);
  assert.equal(doc.getElementById('ge-match-count').textContent, '0 / 0');
  assert.equal(doc.getElementById('ge-find-prev').disabled, true);
  assert.equal(doc.getElementById('ge-find-next').disabled, true);
});

test('Find UI: clicking next repeatedly stops at the last match — does not wrap back to the first', () => {
  const result = getGenericPreview(Buffer.from('cat dog cat bird cat'), true);
  const dom = domWithScriptRun(result.html);
  const doc = dom.window.document;
  const input = doc.getElementById('ge-find-input');
  const nextBtn = doc.getElementById('ge-find-next');
  input.value = 'cat';
  pressEnter(input);
  nextBtn.click(); // 1 -> 2
  nextBtn.click(); // 2 -> 3 (last)
  assert.equal(doc.getElementById('ge-match-count').textContent, '3 / 3');
  assert.equal(nextBtn.disabled, true, 'no wrap — next has nothing to do at the last match');
  nextBtn.click(); // should be a no-op, disabled or not (defensive guard in stepMatch)
  assert.equal(doc.getElementById('ge-match-count').textContent, '3 / 3', 'stayed on the last match, did not wrap to the first');
});

test('Find UI: clicking prev from the first match is a no-op — does not wrap back to the last', () => {
  const result = getGenericPreview(Buffer.from('cat dog cat bird cat'), true);
  const dom = domWithScriptRun(result.html);
  const doc = dom.window.document;
  const input = doc.getElementById('ge-find-input');
  const prevBtn = doc.getElementById('ge-find-prev');
  input.value = 'cat';
  pressEnter(input);
  assert.equal(doc.getElementById('ge-match-count').textContent, '1 / 3');
  prevBtn.click();
  assert.equal(doc.getElementById('ge-match-count').textContent, '1 / 3', 'stayed on the first match, did not wrap to the last');
});

test('Find UI: next/prev correctly re-enable/disable as you step through the middle of the match list', () => {
  const result = getGenericPreview(Buffer.from('cat dog cat bird cat'), true);
  const dom = domWithScriptRun(result.html);
  const doc = dom.window.document;
  const input = doc.getElementById('ge-find-input');
  const nextBtn = doc.getElementById('ge-find-next');
  const prevBtn = doc.getElementById('ge-find-prev');
  input.value = 'cat';
  pressEnter(input);
  nextBtn.click(); // now on match 2 of 3 — neither boundary
  assert.equal(doc.getElementById('ge-match-count').textContent, '2 / 3');
  assert.equal(nextBtn.disabled, false);
  assert.equal(prevBtn.disabled, false);
});

test('Find UI: a disabled button genuinely computes the theme-induced color AND the muted opacity, confirmed via getComputedStyle', () => {
  const result = getGenericPreview(Buffer.from('hello world'), true);
  // Mirrors the real scenario: composeIframeDocument injects a theme
  // color onto <body> (see its own textStyle parameter) — simulated
  // here directly, since this test constructs its own bare document
  // rather than going through that function.
  const dom = new (require('jsdom').JSDOM)(
    `<!doctype html><html><body style="color:rgb(201,205,212);"><div id="root">${result.html}</div></body></html>`,
    { runScripts: 'dangerously' }
  );
  const doc = dom.window.document;
  const prevBtn = doc.getElementById('ge-find-prev'); // starts disabled, no search has run
  assert.equal(prevBtn.disabled, true);
  const cs = dom.window.getComputedStyle(prevBtn);
  assert.equal(cs.color, 'rgb(201, 205, 212)', 'color:inherit picked up the theme-induced body color');
  assert.equal(cs.opacity, '0.7');
});

test('Find UI: the content row gets a non-empty paddingTop from the toolbar\'s measured height', () => {
  // JSDOM does no real layout, so offsetHeight is 0 here regardless of the
  // toolbar's actual content — this can't verify the PIXEL VALUE is
  // correct in a real browser, only that the mechanism runs without
  // error and actually sets contentEl.style.paddingTop (rather than, say,
  // silently failing to find either element).
  const result = getGenericPreview(Buffer.from('hello world'), true);
  const dom = domWithScriptRun(result.html);
  const doc = dom.window.document;
  assert.match(doc.getElementById('ge-content').style.paddingTop, /^\d+px$/);
});
