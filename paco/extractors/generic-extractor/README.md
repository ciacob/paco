# generic-extractor

> **Status:** design notes, implementation, and tests for one of PACO's
> F3-viewer extractors (paired with a sandboxed-iframe architecture doc
> discussed alongside these, not yet checked into this repo). Not yet
> wired into `worker/tasks` — this folder is documentation-in-place
> pending that integration. It has no `package.json`/`node_modules` of
> its own: its one dependency (`jsdom`, dev-only) is declared in PACO's
> root `package.json` and resolves from the root `node_modules`, same
> as every other module in this project.

Turns arbitrary bytes into safe, ready-to-use HTML for files outside
every other extractor's coverage: bare text files, source code, and
binary files with no dedicated handler. **Zero runtime dependencies.**

Two modes, chosen by the caller — this module never sniffs:

- **text** — the decoded text itself, monospaced, in one `<pre>`,
  original line breaks preserved, with optional server-side wrapping
  that preserves each wrapped line's original indent.
- **binary** — a hex dump (configurable bytes-per-row and group size)
  with a Latin-1 rendering of the same bytes alongside each row, both
  prepared as one pre-formatted block of text.

**Exactly two `<pre>` elements ever appear in the output** — one
optional gutter (line numbers / byte offsets) and one holding the
entire dump, regardless of file size. No tables, no one-element-per-
row, no wrapping left to CSS.

## Usage

```js
const { getGenericPreview } = require('./src/genericExtractor');

const result = getGenericPreview(buffer, true /* isText */, {
  showLineNumbers: true,
  wrapColumn: 100,
});
```

Never throws. Always resolves to one of:

```js
{ html: string, mode: 'text' | 'binary', error: null }
{ html: null, mode: null, error: { code: 'too-large' | 'parse-error', message: string } }
```

`isText` is not inferred — the caller decides. `config` accepts
overrides for `DEFAULT_CONFIG`: `maxFileSizeBytes` (default 5MB — the
*entire* file becomes visible content here, unlike every other module
in this project, hence the much lower ceiling than `media-extractor`'s),
`wrapColumn` (text mode, default no wrapping), `bytesPerRow` (binary,
default 16), `groupSize` (binary, default 1), `columnGap` (binary,
default 4), `showLineNumbers` (default false), `offsetFormat` (`'hex'`
| `'decimal'`, binary mode's gutter), `interactive` (default true —
`false` omits the `<script>` entirely, pure static markup), `idPrefix`
(default `'ge'` — see "Multiple previews on one page" below).

## The interactive layer: what it touches, and what it doesn't

When `interactive` is true, a small embedded `<script>` adds Find /
Find-Next / Find-Prev (plain substring or regex) and, in binary mode,
cross-highlighting between the hex and Latin-1 portions of a
selection.

This script **only ever reads the file's bytes as inert text already
sitting in the DOM**, via `textContent` — it is never serialized back
into a `<script>` block or any other executable context itself. That
distinction matters: an earlier design considered embedding file
content into a `<script>` block (e.g. as a JSON payload for a search
index), which would have reopened the same category of risk as
`marked` not sanitizing its own output in `text-extractor` — untrusted
bytes finding an unintended path from "data" to "executed." Reading
already-rendered `<pre>` content via `textContent`, and representing
highlights as inserted `<span>`s, sidesteps that entirely; there was
never a reason to route through `<script>` at all.

**Highlight discipline:** every action that's about to insert
highlight spans — starting a drag, or running a genuinely new Find
query — begins with `element.textContent = element.textContent`,
discarding whatever's currently there. Find-Next/Find-Prev never touch
the DOM structure; they just move a `.match-current`-style class
between spans a prior search already inserted. This is what makes
insertion itself simple: since every highlighting action starts from a
single, unfragmented text node, an absolute character offset *is* a
node-local offset, so insertion is a direct `Text.splitText()` — no
generic tree-walking required anywhere in `applyHighlights()`.
Native `Selection` and synthetic highlight `<span>`s are entirely
separate constructs, so copying a selection only ever copies the
genuine selection — the mirrored highlight in the other column is
never included, for free, with no extra code.

## escapeForPre: verified, not assumed

Embedding arbitrary bytes as literal `<pre>` text turned out to have
two non-obvious failure modes, confirmed empirically against jsdom's
spec-compliant HTML parser (`parse5`) rather than assumed from reading
the HTML5 spec:

- **NUL (0x00) is silently dropped** by the parser's own
  stream-preprocessing step, shifting every subsequent character left
  by one position — not substituted, *removed*.
- **A raw CRLF pair collapses into a single LF**, losing one position
  per pair — extremely relevant given how common Windows line endings
  are in real files.

Both are fixed by routing NUL and CR through numeric character
references (`&#0;`, `&#13;`) instead of raw bytes — references decode
to their exact codepoint *after* stream preprocessing has already run,
sidestepping both normalizations. Verified with the fix in place: 255
of 256 byte values round-trip to their exact original character.

**The one unavoidable exception:** `&#0;` is required by the HTML5
spec's own numeric-character-reference table to always resolve to
U+FFFD, never literal NUL, regardless of how it's expressed in the
source. No HTML document can contain a literal U+0000 in its parsed
text content — a hard ceiling of the format itself, not an
implementation gap. Position is still exactly preserved (one byte,
one character) even for this case; only the literal glyph differs.

CR, despite initial concern, needed no such compromise: since this
module always encodes CR via numeric reference rather than ever
leaving a raw CR byte in the source, the newline-normalization rule
(which only fires on *raw* bytes in the stream) never applies —
`&#13;` decodes to the exact, literal CR character, not the LF
substitution a raw CR byte alone would trigger.

This is foundational, shared logic — it's what text mode's decoded
content and both `<pre>` gutters pass through. Binary mode's Latin-1
column has an additional layer on top, described next, that changes
which bytes actually reach this NUL/CR handling in practice.

## Control characters in the Latin-1 column: all of them become "." (binary mode only)

Every control character — `0x00`–`0x1F`, `0x7F` (DEL), and
`0x80`–`0x9F` (the C1 range), 65 values in total — is substituted with
`.`, the conventional hex-editor placeholder, in the Latin-1 companion
column. `isText` mode is entirely unaffected — a text file's own tabs
and newlines are legitimate, unambiguous content there.

Two bytes force this regardless of preference: `0x0A` (LF) and `0x09`
(TAB) visually break the hex dump's fixed-width monospace grid if left
raw. `white-space: pre` renders any literal LF as a real line break
and any literal TAB as a variable-width tab-stop, and this module
deliberately uses literal `\n` as its own row-separator syntax within
the same flat text blob as byte-derived content — a byte-derived LF is
indistinguishable from a row separator to the renderer, and a
byte-derived TAB silently shifts every column to its right. Confirmed
directly: an 8-byte-per-row dump containing an LF byte produced 3
visual rows from what should have been 2. Neither is fixable via the
numeric-reference trick above — a reference for LF/TAB still decodes
to the exact same real character, which still triggers the same
rendering behavior regardless of how it arrived.

Every other control character is substituted by explicit choice rather
than necessity, for visual consistency — otherwise some non-printable
bytes would render as `.` while others showed whatever tofu/blank
glyph a given font happens to pick for an undefined or non-printing
codepoint, an arbitrary inconsistency for content whose whole point is
readability.

One pleasant side effect: NUL and CR are themselves control
characters, so in binary mode they're now caught by
`buildLatin1Column()` before `escapeForPre` ever sees them — the
NUL-becomes-U+FFFD spec quirk and CR's numeric-reference handling
(both described above) no longer surface in the Latin-1 column at all.
Both remain necessary in `escapeForPre` regardless, since text mode's
UTF-8-decoded content isn't run through this substitution and could
still contain either byte.

## Multiple previews on one page

Every generated element id and CSS class is prefixed (`ge-body`,
`ge-find-input`, `.ge-match`, ...). Discovered while building a live
demo of this module's own output: two instances on the same page with
the default prefix collide via `getElementById`. `idPrefix` (validated
against a safe identifier pattern — invalid values silently fall back
to the default rather than being trusted as-is) lets each instance get
a distinct namespace; give every simultaneous preview on one page its
own prefix.

## Known scope limits

- **Cross-selection mirroring assumes a selection starts and ends
  within its source region cleanly** (hex or Latin-1). This covers the
  overwhelmingly common real case. A selection that starts in the gap
  between columns, or ambiguously straddles both regions mid-drag,
  snaps to the nearest sensible byte boundary rather than failing —
  reasonable, not exhaustively polished for every conceivable ragged
  drag pattern.
- **Find matches against the literal rendered text**, exactly as
  displayed — `"50 4B"` matches the hex digits with their spaces
  intact; there's no canonicalization or format-agnostic matching.
  This was a deliberate simplification, not an oversight: it's simpler
  and matches how a person actually reads the screen.

## Testing

`test/genericExtractor.test.js` uses Node's built-in test runner
(`node --test`), with `jsdom` used specifically to verify generated
HTML actually parses the way this module assumes (real DOM behavior,
not string-matching assumptions). Covers: `escapeForPre` against all
256 byte values through real HTML parsing, specifically including the
NUL-drop and CRLF-collapse regression cases and confirming the fix;
`buildLatin1Column`'s all-control-character substitution (full C0 and
C1 ranges, boundary values) and every non-control byte's pass-through; line/indent-preserving wrap logic including pathological
deep-indent cases; the full row-layout character arithmetic
(hex/Latin-1 range conversions, groupSize > 1); `findMatches` (plain
and regex, including invalid-regex and zero-length-match safety);
`charOffsetToByteCoordinate`/`mapSelectionToMirroredRanges` against
hand-computed expected ranges, including multi-row selections;
`applyHighlights` via jsdom (single/multiple ranges, empty-list no-op,
the reset-then-reapply discipline); `idPrefix` validation and the
multi-instance-on-one-page scenario; and full `getGenericPreview`
integration (both modes, line-number gutter presence/absence,
UTF-8 decoding including invalid sequences, `interactive: false`
omitting the script, too-large gating, non-Buffer coercion, and a
buffer deliberately containing NUL/CR/LF/TAB together never throwing
and producing position-correct markup).
