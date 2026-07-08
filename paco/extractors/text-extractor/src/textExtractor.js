'use strict';

/**
 * text-extractor
 *
 * Turns document bytes (docx, pptx, xlsx, odt, odp, ods, pdf, rtf, csv,
 * md, html — whatever officeparser's `fileType` accepts) into safe,
 * minimal, semantic, text-only HTML: headings, bold/italic, lists,
 * blockquotes, code, and bare GFM-style tables. No images, no article
 * extraction, no filesystem access.
 *
 * The caller supplies the file's content as a Buffer and asserts its
 * format via `fileType`; this module does no path/extension inspection
 * and makes no attempt to guess or validate the format itself. If the
 * asserted type doesn't match the bytes, officeparser will throw and
 * that throw becomes a returned error — not an exception out of this
 * module.
 *
 * Pipeline: size-gate -> officeParser.parseOffice(buffer, { fileType })
 *           -> ast.to('md', { includeImages: false, ... })
 *           -> strip officeparser's YAML frontmatter block (marked has
 *              no notion of frontmatter and renders "---\n---\n" as two
 *              <hr> tags otherwise)
 *           -> marked (Markdown -> HTML)
 *           -> sanitizeExtractedHtml (same allowlist/behavior as the
 *              html-preview module: links become text, no media,
 *              scripts/styles fully removed)
 *
 * Return shape (always, never throws):
 *   { html: string, error: null }                          on success
 *   { html: null,   error: { code: string, message: string } } on failure
 *
 * Design: pure helpers do not touch officeparser/marked/sanitize-html
 * directly; those calls are isolated in getDocumentPreview and passed
 * through an explicit `deps` object so every piece can be unit-tested
 * in isolation (e.g. swap in a fake officeParser that throws).
 */

const sanitizeHtml = require('sanitize-html');
const { marked } = require('marked');
const officeParser = require('officeparser');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG = {
  // Buffers larger than this are rejected before any parsing is attempted.
  maxFileSizeBytes: 2 * 1024 * 1024, // 2 MB

  // Same text-only allowlist as html-preview's htmlPreview.js, kept in
  // sync deliberately: 'a' is absent (links collapse to text via
  // sanitize-html's default discard-but-keep-content behavior), and no
  // media tag is present at all (img/video/audio/source/track), so no
  // image survives regardless of source.
  allowedTags: [
    'p', 'br', 'hr',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'ul', 'ol', 'li',
    'strong', 'em', 'b', 'i', 'u', 's',
    'blockquote', 'code', 'pre',
    'table', 'thead', 'tbody', 'tr', 'td', 'th',
    'figure', 'figcaption',
  ],

  allowedAttributes: {
    th: ['colspan', 'rowspan'],
    td: ['colspan', 'rowspan'],
  },

  // Passed as mdConfig.fallbackToHtml to officeparser's Markdown
  // generator. false = "bare, honest" plain GFM: unsupported features
  // (merged cells, underline, alignment) are skipped/simplified rather
  // than emitted as embedded raw HTML for higher fidelity.
  fallbackToHtml: false,
};

// A small fixed vocabulary of error codes callers can branch on.
const ErrorCode = Object.freeze({
  TOO_LARGE: 'too-large',
  PARSE_ERROR: 'parse-error',
});

// ---------------------------------------------------------------------------
// Pure helpers (no I/O, no injected libs)
// ---------------------------------------------------------------------------

/** Builds a { html: null, error: {...} } failure result. */
function failure(code, message) {
  return { html: null, error: { code, message } };
}

/** Builds a { html, error: null } success result. */
function success(html) {
  return { html, error: null };
}

/**
 * officeparser's Markdown generator always emits a YAML frontmatter
 * block ("Structural metadata... is always included" per its own
 * docs), even when there's no metadata to show — producing a literal
 * "---\n---\n" at the very top of the output. marked has no concept of
 * YAML frontmatter and interprets consecutive "---" lines as two <hr>
 * elements, so every preview would otherwise start with two garbage
 * horizontal rules. This strips exactly one leading frontmatter block,
 * populated or empty, and is a no-op if none is present.
 */
function stripFrontmatter(markdown) {
  return String(markdown || '').replace(/^---\r?\n(?:[\s\S]*?\r?\n)?---\r?\n\s*/, '');
}

/**
 * Sanitizes HTML (already produced by marked from the extracted
 * Markdown) into the final safe preview markup. `sanitizer` is
 * injected so tests can swap it for a spy/mock.
 */
function sanitizeExtractedHtml(html, cfg, sanitizer = sanitizeHtml) {
  return sanitizer(html || '', {
    allowedTags: cfg.allowedTags,
    allowedAttributes: cfg.allowedAttributes,
    transformTags: { b: 'strong', i: 'em' },
    // script/style are not in allowedTags, and are in sanitize-html's
    // default nonTextTags list, so both the tags AND their content
    // (inline JS/CSS) are removed entirely, not just unwrapped. This is
    // not optional: marked has no HTML-sanitizing mode of its own (the
    // old `sanitize` option was removed in v8.0.0), so any raw
    // HTML-looking text in the source document — regardless of format —
    // passes straight through marked's output unless we strip it here.
  });
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Produces a safe, minimal, semantic, text-only HTML preview from
 * document bytes of an asserted format. Never throws.
 *
 * @param {Buffer} fileContent - the document's raw bytes
 * @param {string} fileType - format officeparser should treat the bytes
 *   as (e.g. 'docx', 'pptx', 'xlsx', 'odt', 'odp', 'ods', 'pdf', 'rtf',
 *   'csv', 'md', 'html'). Not validated or inferred by this module —
 *   the caller is responsible for only ever asserting a format
 *   officeparser actually supports.
 * @param {object} [config] - overrides for DEFAULT_CONFIG
 * @param {object} [deps] - injectable dependencies: { officeParser, marked, sanitizeHtml }
 * @returns {{ html: string, error: null } | { html: null, error: { code: string, message: string } }}
 */
async function getDocumentPreview(fileContent, fileType, config = {}, deps = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const parser = deps.officeParser || officeParser;
  const markdownRenderer = deps.marked || marked;
  const sanitizer = deps.sanitizeHtml || sanitizeHtml;

  let buffer;
  try {
    buffer = Buffer.isBuffer(fileContent) ? fileContent : Buffer.from(fileContent);
  } catch (err) {
    return failure(ErrorCode.PARSE_ERROR, `fileContent could not be read as a Buffer: ${err.message}`);
  }

  if (buffer.byteLength > cfg.maxFileSizeBytes) {
    return failure(
      ErrorCode.TOO_LARGE,
      `File is ${buffer.byteLength} bytes, exceeding the ${cfg.maxFileSizeBytes}-byte limit.`
    );
  }

  try {
    const ast = await parser.parseOffice(buffer, { fileType });
    const { value: rawMarkdown } = await ast.to('md', {
      includeImages: false,
      includeCharts: false,
      generateIds: false, // avoids Pandoc-style {#id} attributes marked doesn't understand
      mdConfig: { fallbackToHtml: cfg.fallbackToHtml },
    });
    const markdown = stripFrontmatter(rawMarkdown);
    const html = markdownRenderer.parse(markdown);
    return success(sanitizeExtractedHtml(html, cfg, sanitizer));
  } catch (err) {
    return failure(ErrorCode.PARSE_ERROR, err && err.message ? err.message : String(err));
  }
}

module.exports = {
  getDocumentPreview,
  // exported for unit testing / composition
  stripFrontmatter,
  sanitizeExtractedHtml,
  failure,
  success,
  ErrorCode,
  DEFAULT_CONFIG,
};
