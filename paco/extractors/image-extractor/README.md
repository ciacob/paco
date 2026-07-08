# image-extractor

> **Status:** design notes, implementation, and tests for one of PACO's
> F3-viewer extractors (paired with a sandboxed-iframe architecture doc
> discussed alongside these, not yet checked into this repo). Not yet
> wired into `worker/tasks` — this folder is documentation-in-place
> pending that integration. It has no `package.json`/`node_modules` of
> its own: `sharp` and `libheif-js` are declared in PACO's root
> `package.json` and resolve from the root `node_modules`, same as
> every other module in this project — `sharp` in particular is
> shared with, and deduplicated against, `media-extractor`'s own use
> of it.

Turns image bytes of an asserted format into a single-format thumbnail
bounded to a fixed box (default 1024x1024, aspect preserved, never
cropped, never upscaled). No filesystem access, no format sniffing —
the caller supplies bytes and asserts the type, exactly like
`text-extractor`.

Supported: `jpeg`/`jpg`, `png`, `webp`, `avif`, `tiff`/`tif`, `gif`,
`svg`, `heic`, `heif`, `psd`. Everything else (RAW formats, ICO, ...)
is an `unsupported-format` error — no placeholder rendering; that's
left to the caller.

## Branches

- **jpeg/png/webp/avif/tiff/gif** → `sharp`, direct decode + resize.
  Animated GIFs resolve to a single (first) frame.
- **svg** → `sharp`, with an explicit rasterization `density` computed
  to bound the *render* itself, not just a post-hoc resize (see
  "SVG rasterization" below — this is the trickiest part of the module).
- **heic/heif** → `libheif-js` (WASM) decode to raw RGBA, piped into
  `sharp` for resize/encode. sharp's own prebuilt binaries deliberately
  exclude HEIC decode (it requires libheif compiled with libde265/x265,
  which carries HEVC patent-licensing baggage sharp's maintainers won't
  bundle) — this is the only route to HEIC support without a
  Docker/build step.
- **psd** → zero-dependency manual parse of Image Resource Block 1036
  (the JPEG thumbnail Photoshop embeds by default). **No full-document
  compositing is ever attempted** — a PSD with no embedded thumbnail
  resource is a `no-embedded-thumbnail` error, not a slow fallback.

## Output format

Every branch outputs **WebP** (explicitly listed among sharp's
*prebuilt*-binary-supported formats, unlike HEIF/JXL — no reliability
caveat), except the PSD embedded-thumbnail path, which stays **JPEG**:
the resource is already JPEG bytes, and re-encoding to WebP would cost
a decode+encode round trip for a source with no alpha channel to
preserve in the first place.

## Usage

```js
const { getImageThumbnail } = require('./src/imageExtractor');

const buffer = fs.readFileSync('/path/to/photo.heic');
const result = await getImageThumbnail(buffer, 'heic');
```

Never throws. Always resolves to one of:

```js
{ thumbnail: Buffer, html: null, format: 'webp'|'jpeg', width, height, error: null }  // success (output: 'buffer', default)
{ thumbnail: null, html: null, error: { code: 'too-large', message: '...' } }               // failure
{ thumbnail: null, html: null, error: { code: 'unsupported-format', message: '...' } }      // failure
{ thumbnail: null, html: null, error: { code: 'too-many-pixels', message: '...' } }         // failure
{ thumbnail: null, html: null, error: { code: 'no-embedded-thumbnail', message: '...' } }   // failure (psd only)
{ thumbnail: null, html: null, error: { code: 'parse-error', message: '...' } }             // failure
```

`fileType` is **not validated or inferred** — the caller is
responsible for only ever asserting a format this module actually
supports.

`config` accepts overrides for `DEFAULT_CONFIG`: `maxFileSizeBytes`
(default 15MB), `maxDimension` (default 1024), `withoutEnlargement`
(default true), `webpQuality` (default 80), `jpegQuality` (default 85,
PSD path only), `limitInputPixels` (default 100 megapixels — an
explicit decompression-bomb guard, deliberately tighter than sharp's
own ~268-megapixel default), `maxSvgDensity` (default 3000, see
below), `output` (default `'buffer'`; also `'html'` or `'both'` — see
"HTML output" below). `deps` accepts injected dependencies (`sharp`,
`HeifDecoder`, `extractPsdEmbeddedThumbnailJpeg`), mainly for testing.

## HTML output

Setting `config.output` to `'html'` or `'both'` adds a ready-to-embed
HTML fragment to the result — the thumbnail inlined as a `data:` URI,
centered both horizontally and vertically, scaled to fit within
whatever space it's placed into without stretching or cropping:

```html
<div style="display:flex;align-items:center;justify-content:center;width:100%;height:100%;">
  <img src="data:image/webp;base64,...." width="768" height="1024" decoding="async" style="max-width:100%;max-height:100%;width:auto;height:auto;object-fit:contain;display:block;">
</div>
```

This is a **fragment**, not a standalone document — it assumes the
caller places it inside a container that itself has real, computed
dimensions (an iframe, a sized `div`, ...); the outer `div` fills
`100%` of that parent via flexbox centering.

A few things worth knowing:

- **`output: 'buffer'` is unchanged and remains the default** — this
  is additive, not a breaking change to existing callers.
- **The return shape is uniform across all three modes** —
  `thumbnail` and `html` keys are always both present (`null` when
  not requested), so callers never need to guard with
  `'html' in result`. Failure results also always include `html: null`
  alongside `thumbnail: null`, for the same reason.
- **No `alt` attribute, deliberately.** This is meant for a local
  tool, not a web page — there's no accessibility audience to serve,
  and dropping it also removes the one place in this module that
  would otherwise need to escape caller-supplied text before
  interpolating it into markup. The base64 payload
  (`[A-Za-z0-9+/=]` only) and the `format` string (always one of this
  module's own fixed values) are both already safe to interpolate
  without escaping.
- **An unrecognized `output` value behaves as `'buffer'`** rather than
  throwing or erroring — consistent with this module's general
  fail-closed-but-never-throw philosophy for configuration.

## SVG rasterization — the trickiest part of this module

Calling `.resize(1024, 1024)` on an SVG-backed `sharp` pipeline does
**not** bound rasterization cost by itself. libvips renders the SVG at
its own declared intrinsic size × a default 72 DPI density *first*,
then resizes that raster — so a maliciously large declared
`width`/`height`/`viewBox` can still force a large initial raster
allocation even though only a 1024×1024 output was requested
(confirmed against real upstream `sharp` issues, not assumed).

The fix implemented here (`computeBoundedSvgDensity`):

1. Read the SVG's intrinsic size via a `metadata()` pre-flight call —
   **deliberately without the pixel-limit guard** on this call
   specifically, since reading SVG metadata is XML attribute parsing,
   not rasterization; no pixel data is decoded at this stage regardless
   of how large the declared size is. (Found the hard way: applying the
   guard here rejects the metadata read itself for a legitimately
   huge-canvas SVG, before density can be computed in response — see
   the regression test covering this exact case.)
2. Compute a `density` value scaled so the *initial* raster lands near
   the target box: small declared sizes get density boosted up (small
   vector icons render crisply at the full target box — this is
   correct and desirable for vectors, unlike upscaling a raster image,
   which would look blurry); huge declared sizes get density scaled
   down proportionally, naturally self-limiting.
3. Clamp the computed density into `[1, maxSvgDensity]` — defense in
   depth against a pathological near-zero declared size blowing the
   formula up. This is what actually protects the tiny-width,
   huge-`viewBox` adversarial case: renders in single-digit
   milliseconds, safely, at the cost of a smaller-than-requested output
   for that specific degenerate input — a deliberate safety trade-off,
   not a bug.
4. The pixel-limit guard is reinstated on the actual rasterizing call
   (where real memory allocation happens), and the subsequent
   `.resize({ fit: 'inside' })` remains a hard ceiling on output
   dimensions regardless of any imprecision in the density estimate.

## PSD embedded-thumbnail extraction

`extractPsdEmbeddedThumbnailJpeg()` is a small, careful, bounds-checked
binary parser (no dependency) that walks a PSD/PSB file's header, skips
the Color Mode Data section, then walks Image Resource Blocks looking
specifically for resource ID `1036` — the JPEG thumbnail Photoshop
embeds by default. It:

- Throws (distinct from "not found") on a missing `"8BPS"` signature
  or a section whose declared length exceeds the actual buffer — a
  malformed/truncated file is a `parse-error`, not silently treated as
  "no thumbnail."
- Returns `null` when the file is structurally a valid PSD but simply
  has no resource 1036 — surfaced as `no-embedded-thumbnail`.
- Caps resource-block iteration (5000) as a defensive measure against
  malformed data that could otherwise stall a scan.
- Only implements resource ID 1036 (the modern JPEG thumbnail format).
  The legacy raw-BGR format (resource 1033) is deliberately out of
  scope — rare enough in practice not to be worth the added parsing
  complexity for a thumbnail feature.

## HEIC: verified against real device photos

The HEIC branch is tested two ways. An injected fake `HeifDecoder`
exercises this module's own integration logic in isolation (decode
call, width/height extraction, the pixel-count guard firing *before*
`display()`, raw RGBA piped into `sharp`, resize, encode). Separately,
it's been run against three real iPhone-captured HEIC photos (genuine
HEVC-coded, 2.4–3.0MB each, confirmed via `file`) to prove `libheif-js`
itself correctly decodes real-world device output — all three produced
correctly oriented, undamaged, correctly bounded WebP thumbnails,
visually verified.

Those three real photos are **not bundled into this zip** — they're
someone's personal photos, not synthetic test data, and don't belong
in a redistributable module. `test/imageExtractor.test.js` includes a
regression test block that runs against `test/fixtures/real{1,2,3}.heic`
if present locally and skips itself cleanly if they're absent (same
pattern used for the `text-extractor` project's bundled `.docx`
fixture, except here the fixtures themselves aren't shipped).

**Timing, measured for real, worth knowing before relying on this for
a snappy "quick preview" UX:** decoding these three real photos (full
device resolution, before any resizing) took 1.5–3.4 seconds each on
this environment's hardware — meaningfully slower than the
millisecond-scale timings every other branch (including SVG's
adversarial cases) showed. This is WASM software decode of a full-
resolution HEVC image, not a fast path, and it's proportional to the
source photo's actual resolution, not the requested thumbnail size —
there's no equivalent to JPEG's shrink-on-load here. Worth keeping in
mind for the calling application: a HEIC-heavy directory in an
F3-style previewer may feel noticeably slower to page through than
one full of JPEGs, and might warrant an async/background-loading UX
rather than a blocking one.

## Testing

`test/imageExtractor.test.js` uses Node's built-in test runner
(`node --test`), with all fixtures generated at test-time via `sharp`
itself or hand-built buffers (`test/fixtures.js`) — no bundled binary
files. Covers: `normalizeFileType` and `computeBoundedSvgDensity`
directly; `extractPsdEmbeddedThumbnailJpeg` directly (success,
no-thumbnail, invalid signature, truncated/malformed data); every
raster format's success path plus animated-GIF-to-single-frame and
corrupt-bytes handling; SVG's normal, no-intrinsic-size, huge-intrinsic
(the regression case above), tiny-size-huge-viewBox (the adversarial
density-ceiling case), zero-dimension, and malformed-XML cases; HEIC
success/no-images/decoder-throws/oversized-before-display via injected
fakes; PSD success/oversized-thumbnail/no-thumbnail/invalid-signature/
injected-parser-failure; output-mode behavior (`buffer`/`html`/`both`,
uniform return shape, unrecognized values falling back to `buffer`)
and `buildThumbnailDataUriHtml` directly (markup structure, MIME type
per format, base64 round-trip, no `alt` attribute); and cross-cutting
concerns (unsupported formats, too-large-checked-before-decode,
non-Buffer input coercion, garbage bytes never throwing, custom
`webpQuality` actually affecting output size).
