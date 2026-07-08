# text-extractor

> **Status:** design notes, implementation, and tests for one of PACO's
> F3-viewer extractors (paired with a sandboxed-iframe architecture doc
> discussed alongside these, not yet checked into this repo). Not yet
> wired into `worker/tasks` — this folder is documentation-in-place
> pending that integration. It has no `package.json`/`node_modules` of
> its own: `officeparser`, `marked`, and `sanitize-html` are declared in
> PACO's root `package.json` and resolve from the root `node_modules`,
> same as every other module in this project.

Turns document bytes into safe, minimal, semantic, **text-only** HTML —
headings, bold/italic, lists, blockquotes, code, and bare GFM tables.
No images. No article extraction. No filesystem access.

Supports whatever `officeparser`'s `fileType` accepts: `docx`, `pptx`,
`xlsx`, `odt`, `odp`, `ods`, `pdf`, `rtf`, `csv`, `md`, `html`.

## Pipeline

```
size-gate -> officeParser.parseOffice(buffer, { fileType })
          -> ast.to('md', { includeImages: false, ... })
          -> strip officeparser's always-emitted YAML frontmatter block
          -> marked (Markdown -> HTML)
          -> sanitizeExtractedHtml (same allowlist/behavior as the
             html-preview project: links become text, no media,
             scripts/styles fully removed)
```

## Contract

This module takes **bytes**, not a file path — the caller reads the
file and asserts its format:

```js
const { getDocumentPreview } = require('./src/textExtractor');

const buffer = fs.readFileSync('/path/to/file.docx');
const result = await getDocumentPreview(buffer, 'docx');
```

It never throws. It always resolves to one of:

```js
{ html: '<h1>...</h1>...', error: null }                       // success
{ html: null, error: { code: 'too-large', message: '...' } }   // failure
{ html: null, error: { code: 'parse-error', message: '...' } } // failure
```

`fileType` is **not validated or inferred** by this module — the
caller is responsible for only ever asserting a format officeparser
actually supports. If the asserted type doesn't match the bytes (or
officeparser can't parse them for any other reason), that surfaces as
`error.code === 'parse-error'`, not an exception.

`config` accepts overrides for `DEFAULT_CONFIG`: `maxFileSizeBytes`,
`allowedTags`, `allowedAttributes`, `fallbackToHtml`. `deps` accepts
injected dependencies (`officeParser`, `marked`, `sanitizeHtml`),
mainly for testing.

## Notable design decisions

- **No article extraction, unlike the companion `html-preview`
  project.** Readability solves "find the content amid the
  boilerplate" for scraped-shaped HTML. An office document's AST has
  no boilerplate to find — the whole document *is* the content — so
  that step is simply absent here.
- **officeparser's Markdown generator always emits a YAML frontmatter
  block**, even with nothing to show (`---\n---\n`), per its own docs
  ("structural metadata... is always included"). `marked` has no
  concept of frontmatter and renders two adjacent `---` lines as two
  `<hr>` elements — so every preview would otherwise start with two
  garbage horizontal rules. `stripFrontmatter()` removes exactly one
  leading frontmatter block (populated or empty) before handing the
  text to `marked`.
- **`marked` has no sanitizing mode of its own.** Its old `sanitize`
  option was removed in v8.0.0; the maintainers' own removal note
  explicitly points users at a dedicated sanitizer (DOMPurify,
  sanitize-html) instead. Concretely: any `<script>`/`<img
  onerror=...>`-shaped text sitting in a source document — regardless
  of format — passes straight through `marked`'s HTML output verbatim.
  `sanitizeExtractedHtml()` is therefore not a defense-in-depth
  nicety, it's the only thing making the output safe, and it runs
  unconditionally on every result.
- **`fallbackToHtml: false` by default** in `mdConfig`. officeparser's
  Markdown generator can optionally fall back to embedding raw HTML
  tags (`<table>`, `<u>`, `<sub>`, etc.) for features plain Markdown
  can't represent natively (merged cells, underline, text alignment).
  Defaulting this off keeps tables and other structure "bare and
  honest" — plain GFM grids, with unsupported features simplified or
  skipped rather than rendered with higher fidelity via embedded HTML.
  (Either way, anything that does come through as raw HTML still gets
  sanitized identically, so this is a fidelity choice, not a safety
  one.)
- **No image extraction ever.** `includeImages: false` (and
  `includeCharts: false`) are passed to the generator up front, so
  image/chart bytes are never even pulled out of the source document
  — cheaper and simpler than extracting-then-stripping.
- **Buffer coercion, not strict Buffer-only.** `fileContent` is
  coerced via `Buffer.from()` if it isn't already a `Buffer` (e.g. a
  plain byte array), so the API is a little more forgiving without
  weakening any of the safety guarantees.

## Known upstream quirk

Bullet/numbered lists created by `python-docx` via `style='List
Bullet'` (a style *reference* without explicit per-paragraph numbering
XML) do not currently round-trip as `<ul><li>` through officeparser's
Markdown generator — confirmed by inspecting officeparser's raw
Markdown output directly, upstream of anything this module does. This
is a characteristic of that specific style-application method, not a
defect here; the test suite proves list rendering works correctly
given well-formed Markdown list input, and separately exercises a real
`.docx` fixture for headings/bold/italic/tables end-to-end.

## Testing

`test/textExtractor.test.js` uses Node's built-in test runner
(`node --test`) and covers: the frontmatter-stripping helper directly,
the sanitizer directly (including injected fakes), success paths via
controlled `md`/`html` input (headings, bold, italic, lists, tables,
no leading `<hr>` garbage, embedded-`<script>` neutralization, no
images ever), a bundled real `.docx` fixture (`test/fixtures/real.docx`,
generated via `python-docx`) as an end-to-end integration smoke test,
and failure paths (too-large, mismatched `fileType`/content, unknown
`fileType`, injected `officeParser`/`marked` failures, and garbage
bytes) — proving the function never throws.
