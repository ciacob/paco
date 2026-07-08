'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');

const {
  getImageThumbnail,
  normalizeFileType,
  computeBoundedSvgDensity,
  extractPsdEmbeddedThumbnailJpeg,
  buildThumbnailDataUriHtml,
  ErrorCode,
  DEFAULT_CONFIG,
} = require('../src/imageExtractor');

const { buildRasterImage, buildAnimatedGif, buildSyntheticPsd, buildNoiseImage } = require('./fixtures');

// ---------------------------------------------------------------------------
// normalizeFileType
// ---------------------------------------------------------------------------

test('normalizeFileType: maps jpg -> jpeg and tif -> tiff', () => {
  assert.equal(normalizeFileType('jpg'), 'jpeg');
  assert.equal(normalizeFileType('JPG'), 'jpeg');
  assert.equal(normalizeFileType('tif'), 'tiff');
  assert.equal(normalizeFileType('  PNG  '), 'png');
});

test('normalizeFileType: passes through unrecognized values unchanged (lowercased)', () => {
  assert.equal(normalizeFileType('CR2'), 'cr2');
  assert.equal(normalizeFileType(''), '');
});

// ---------------------------------------------------------------------------
// computeBoundedSvgDensity
// ---------------------------------------------------------------------------

test('computeBoundedSvgDensity: scales up density for a small declared intrinsic size', () => {
  const d = computeBoundedSvgDensity(200, 100, 1024, 3000);
  assert.equal(d, 72 * (1024 / 200));
});

test('computeBoundedSvgDensity: scales down density for a huge declared intrinsic size', () => {
  const d = computeBoundedSvgDensity(200000, 100000, 1024, 3000);
  assert.ok(d < 72, `expected density below the 72 baseline, got ${d}`);
  assert.ok(d >= 1, `expected density clamped to at least 1, got ${d}`);
});

test('computeBoundedSvgDensity: clamps a pathologically large result to maxDensity', () => {
  const d = computeBoundedSvgDensity(1, 1, 1024, 3000);
  assert.equal(d, 3000);
});

test('computeBoundedSvgDensity: falls back to the 72 baseline for missing/invalid intrinsic size', () => {
  assert.equal(computeBoundedSvgDensity(0, 0, 1024, 3000), 72);
  assert.equal(computeBoundedSvgDensity(NaN, NaN, 1024, 3000), 72);
  assert.equal(computeBoundedSvgDensity(-5, -5, 1024, 3000), 72);
  assert.equal(computeBoundedSvgDensity(undefined, undefined, 1024, 3000), 72);
});

// ---------------------------------------------------------------------------
// buildThumbnailDataUriHtml
// ---------------------------------------------------------------------------

test('buildThumbnailDataUriHtml: produces a centered, fit-to-container fragment with correct dimensions', () => {
  const buf = Buffer.from('fake-image-bytes');
  const html = buildThumbnailDataUriHtml(buf, 'webp', 768, 1024);

  // Centering + fit-to-container, not just "some CSS"
  assert.match(html, /display:flex/);
  assert.match(html, /align-items:center/);
  assert.match(html, /justify-content:center/);
  assert.match(html, /object-fit:contain/);
  assert.match(html, /max-width:100%/);
  assert.match(html, /max-height:100%/);

  // Real intrinsic dimensions as attributes, not just baked into CSS
  assert.match(html, /width="768"/);
  assert.match(html, /height="1024"/);

  // It's a fragment: no doctype/html/head/body wrapper
  assert.doesNotMatch(html, /<!DOCTYPE/i);
  assert.doesNotMatch(html, /<html/i);
  assert.doesNotMatch(html, /<body/i);
});

test('buildThumbnailDataUriHtml: embeds the correct MIME type per format', () => {
  const buf = Buffer.from('x');
  assert.match(buildThumbnailDataUriHtml(buf, 'webp', 10, 10), /data:image\/webp;base64,/);
  assert.match(buildThumbnailDataUriHtml(buf, 'jpeg', 10, 10), /data:image\/jpeg;base64,/);
});

test('buildThumbnailDataUriHtml: the embedded base64 payload round-trips to the original bytes', async () => {
  const original = await sharp({ create: { width: 20, height: 15, channels: 3, background: { r: 9, g: 8, b: 7 } } })
    .webp()
    .toBuffer();
  const html = buildThumbnailDataUriHtml(original, 'webp', 20, 15);
  const match = html.match(/base64,([^"]+)"/);
  assert.ok(match, 'expected to find the base64 payload in the markup');
  const decoded = Buffer.from(match[1], 'base64');
  assert.ok(decoded.equals(original), 'decoded data URI payload should exactly match the source buffer');
  const meta = await sharp(decoded).metadata();
  assert.equal(meta.width, 20);
  assert.equal(meta.height, 15);
});

test('buildThumbnailDataUriHtml: no alt attribute — local tool, no accessibility audience, no caller-supplied text to escape', () => {
  const html = buildThumbnailDataUriHtml(Buffer.from('x'), 'webp', 10, 10);
  assert.doesNotMatch(html, /alt=/);
});

// ---------------------------------------------------------------------------
// extractPsdEmbeddedThumbnailJpeg
// ---------------------------------------------------------------------------

test('extractPsdEmbeddedThumbnailJpeg: extracts real JPEG bytes from a well-formed resource', async () => {
  const psd = await buildSyntheticPsd({ withThumbnail: true, thumbWidth: 64, thumbHeight: 32 });
  const jpegBytes = extractPsdEmbeddedThumbnailJpeg(psd);
  assert.ok(jpegBytes, 'expected non-null JPEG bytes');
  // A real JPEG SOI marker.
  assert.equal(jpegBytes[0], 0xff);
  assert.equal(jpegBytes[1], 0xd8);
  const meta = await sharp(jpegBytes).metadata();
  assert.equal(meta.width, 64);
  assert.equal(meta.height, 32);
});

test('extractPsdEmbeddedThumbnailJpeg: returns null when no thumbnail resource is present', async () => {
  const psd = await buildSyntheticPsd({ withThumbnail: false });
  const result = extractPsdEmbeddedThumbnailJpeg(psd);
  assert.equal(result, null);
});

test('extractPsdEmbeddedThumbnailJpeg: throws on a missing "8BPS" signature', () => {
  assert.throws(() => extractPsdEmbeddedThumbnailJpeg(Buffer.from('not a psd at all')), /8BPS/);
});

test('extractPsdEmbeddedThumbnailJpeg: throws (not hangs) on a truncated Image Resources section', () => {
  const header = Buffer.alloc(26);
  header.write('8BPS', 0, 'ascii');
  header.writeUInt16BE(1, 4);
  const colorModeLen = Buffer.alloc(4); // 0
  const resourcesLenField = Buffer.alloc(4);
  resourcesLenField.writeUInt32BE(999999, 0); // claims far more than actually present
  const truncated = Buffer.concat([header, colorModeLen, resourcesLenField]); // no actual resource bytes follow
  assert.throws(() => extractPsdEmbeddedThumbnailJpeg(truncated), /Truncated PSD/);
});

// ---------------------------------------------------------------------------
// getImageThumbnail: raster formats (jpeg, png, webp, avif, tiff)
// ---------------------------------------------------------------------------

for (const format of ['jpeg', 'png', 'webp', 'avif', 'tiff']) {
  test(`getImageThumbnail: ${format} — scales down to fit the box, outputs webp`, async () => {
    const buf = await buildRasterImage({ width: 2000, height: 1000, format });
    const result = await getImageThumbnail(buf, format);
    assert.equal(result.error, null);
    assert.equal(result.format, 'webp');
    assert.equal(result.width, 1024);
    assert.equal(result.height, 512);
    assert.ok(Buffer.isBuffer(result.thumbnail));
    assert.ok(result.thumbnail.length > 0);
  });
}

test('getImageThumbnail: jpg alias behaves identically to jpeg', async () => {
  const buf = await buildRasterImage({ width: 400, height: 200, format: 'jpeg' });
  const result = await getImageThumbnail(buf, 'jpg');
  assert.equal(result.error, null);
  assert.equal(result.format, 'webp');
});

test('getImageThumbnail: does not upscale a smaller-than-box source (withoutEnlargement)', async () => {
  const buf = await buildRasterImage({ width: 100, height: 50, format: 'png' });
  const result = await getImageThumbnail(buf, 'png');
  assert.equal(result.error, null);
  assert.equal(result.width, 100);
  assert.equal(result.height, 50);
});

test('getImageThumbnail: respects a custom maxDimension', async () => {
  const buf = await buildRasterImage({ width: 2000, height: 1000, format: 'png' });
  const result = await getImageThumbnail(buf, 'png', { maxDimension: 200 });
  assert.equal(result.error, null);
  assert.equal(result.width, 200);
  assert.equal(result.height, 100);
});

test('getImageThumbnail: animated GIF resolves to a single (first) frame', async () => {
  const buf = await buildAnimatedGif({
    frameColors: [
      { r: 255, g: 0, b: 0 },
      { r: 0, g: 255, b: 0 },
      { r: 0, g: 0, b: 255 },
    ],
  });
  // sanity: confirm the source really is multi-frame before testing our handling of it
  const sourceMeta = await sharp(buf, { pages: -1 }).metadata();
  assert.ok(sourceMeta.pages > 1, 'expected a genuinely animated source fixture');

  const result = await getImageThumbnail(buf, 'gif');
  assert.equal(result.error, null);
  assert.equal(result.format, 'webp');
  const outMeta = await sharp(result.thumbnail, { pages: -1 }).metadata();
  assert.ok(!outMeta.pages || outMeta.pages === 1, `expected a single-frame output, got pages=${outMeta.pages}`);
});

test('getImageThumbnail: corrupt bytes for an asserted raster format yield a parse-error, never throw', async () => {
  const buf = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01, 0x02]); // truncated JPEG
  const result = await getImageThumbnail(buf, 'jpeg');
  assert.equal(result.thumbnail, null);
  assert.equal(result.error.code, ErrorCode.PARSE_ERROR);
});

// ---------------------------------------------------------------------------
// getImageThumbnail: SVG
// ---------------------------------------------------------------------------

test('getImageThumbnail: svg — normal case scales into the box', async () => {
  const svg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="blue"/></svg>'
  );
  const result = await getImageThumbnail(svg, 'svg');
  assert.equal(result.error, null);
  assert.equal(result.format, 'webp');
  assert.equal(result.width, 1024);
  assert.equal(result.height, 512);
});

test('getImageThumbnail: svg — no intrinsic width/height, only viewBox, still resolves', async () => {
  const svg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200"><rect width="400" height="200" fill="green"/></svg>'
  );
  const result = await getImageThumbnail(svg, 'svg');
  assert.equal(result.error, null);
  assert.equal(result.width, 1024);
  assert.equal(result.height, 512);
});

test('getImageThumbnail: svg — huge declared intrinsic size resolves quickly and safely (regression: metadata pre-flight must not itself trip the pixel limit)', async () => {
  const svg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="200000" height="100000"><rect width="200000" height="100000" fill="purple"/></svg>'
  );
  const start = Date.now();
  const result = await getImageThumbnail(svg, 'svg');
  const elapsedMs = Date.now() - start;
  assert.equal(result.error, null);
  assert.equal(result.width, 1024);
  assert.equal(result.height, 512);
  assert.ok(elapsedMs < 2000, `expected a fast, bounded render; took ${elapsedMs}ms`);
});

test('getImageThumbnail: svg — tiny declared size with a huge viewBox is bounded by maxSvgDensity, not a bomb', async () => {
  const svg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1" viewBox="0 0 500000 500000"><rect width="500000" height="500000" fill="red"/></svg>'
  );
  const start = Date.now();
  const result = await getImageThumbnail(svg, 'svg');
  const elapsedMs = Date.now() - start;
  assert.equal(result.error, null);
  // Deliberately bounded well below the requested 1024 box by the density
  // ceiling — this is the safety trade-off, not a bug.
  assert.ok(result.width <= 100 && result.height <= 100, `expected a small bounded output, got ${result.width}x${result.height}`);
  assert.ok(elapsedMs < 2000, `expected a fast render even for adversarial input; took ${elapsedMs}ms`);
});

test('getImageThumbnail: svg — zero declared dimensions yield a parse-error, not a hang or crash', async () => {
  const svg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0" viewBox="0 0 999999 999999"><rect width="999999" height="999999" fill="black"/></svg>'
  );
  const result = await getImageThumbnail(svg, 'svg');
  assert.equal(result.thumbnail, null);
  assert.equal(result.error.code, ErrorCode.PARSE_ERROR);
});

test('getImageThumbnail: svg — malformed XML yields a parse-error, not a throw', async () => {
  const svg = Buffer.from('<svg><this is not valid xml at all');
  const result = await getImageThumbnail(svg, 'svg');
  assert.equal(result.thumbnail, null);
  assert.equal(result.error.code, ErrorCode.PARSE_ERROR);
});

// ---------------------------------------------------------------------------
// getImageThumbnail: HEIC/HEIF (injected fake decoder — no real fixture available)
// ---------------------------------------------------------------------------

function makeFakeHeifDecoder({ width, height, decodeThrows = false, imagesReturned = 1 } = {}) {
  return class FakeHeifDecoder {
    decode() {
      if (decodeThrows) throw new Error('injected decode failure');
      if (imagesReturned === 0) return [];
      return [
        {
          get_width: () => width,
          get_height: () => height,
          display: (target, cb) => {
            const data = target.data;
            for (let i = 0; i < data.length; i += 4) {
              data[i] = 100;
              data[i + 1] = 150;
              data[i + 2] = 200;
              data[i + 3] = 255;
            }
            cb({ data, width, height });
          },
        },
      ];
    }
  };
}

test('getImageThumbnail: heic — success path via injected decoder produces a webp thumbnail', async () => {
  const HeifDecoder = makeFakeHeifDecoder({ width: 2000, height: 1000 });
  const result = await getImageThumbnail(Buffer.from('fake heic bytes'), 'heic', {}, { HeifDecoder });
  assert.equal(result.error, null);
  assert.equal(result.format, 'webp');
  assert.equal(result.width, 1024);
  assert.equal(result.height, 512);
});

test('getImageThumbnail: heif alias behaves identically to heic', async () => {
  const HeifDecoder = makeFakeHeifDecoder({ width: 400, height: 200 });
  const result = await getImageThumbnail(Buffer.from('fake'), 'heif', {}, { HeifDecoder });
  assert.equal(result.error, null);
  assert.equal(result.format, 'webp');
});

test('getImageThumbnail: heic — decoder returning no images yields a parse-error', async () => {
  const HeifDecoder = makeFakeHeifDecoder({ imagesReturned: 0 });
  const result = await getImageThumbnail(Buffer.from('garbage'), 'heic', {}, { HeifDecoder });
  assert.equal(result.thumbnail, null);
  assert.equal(result.error.code, ErrorCode.PARSE_ERROR);
});

test('getImageThumbnail: heic — decoder throwing synchronously is caught, not propagated', async () => {
  const HeifDecoder = makeFakeHeifDecoder({ decodeThrows: true });
  const result = await getImageThumbnail(Buffer.from('garbage'), 'heic', {}, { HeifDecoder });
  assert.equal(result.thumbnail, null);
  assert.equal(result.error.code, ErrorCode.PARSE_ERROR);
  assert.match(result.error.message, /injected decode failure/);
});

test('getImageThumbnail: heic — oversized declared dimensions are rejected before display() runs', async () => {
  let displayCalled = false;
  class HugeHeifDecoder {
    decode() {
      return [
        {
          get_width: () => 50000,
          get_height: () => 50000,
          display: () => {
            displayCalled = true;
          },
        },
      ];
    }
  }
  const result = await getImageThumbnail(Buffer.from('huge'), 'heic', {}, { HeifDecoder: HugeHeifDecoder });
  assert.equal(result.thumbnail, null);
  assert.equal(result.error.code, ErrorCode.TOO_MANY_PIXELS);
  assert.equal(displayCalled, false, 'display() should never be called for an oversized declared image');
});

// ---------------------------------------------------------------------------
// getImageThumbnail: HEIC — real-world fixtures (not injected fakes)
//
// The injected-fake tests above prove this module's own integration logic
// is correct, but they don't prove libheif-js actually decodes real HEVC-
// coded HEIC bytes from an actual device. These three fixtures are real
// iPhone photos (2.4-3.0MB each), used here specifically to close that gap.
// They are NOT bundled into the shipped zip (personal photos have no
// business in a redistributable module) — these tests skip themselves
// automatically if the fixture files aren't present locally.
// ---------------------------------------------------------------------------

const REAL_HEIC_FIXTURES = ['real1.heic', 'real2.heic', 'real3.heic'].map((f) =>
  require('node:path').join(__dirname, 'fixtures', f)
);
const realHeicFixturesPresent = REAL_HEIC_FIXTURES.every((p) => require('node:fs').existsSync(p));

for (const fixturePath of REAL_HEIC_FIXTURES) {
  const name = require('node:path').basename(fixturePath);
  test(
    `getImageThumbnail: heic — real device photo (${name}) decodes to a correctly bounded webp thumbnail`,
    { skip: !realHeicFixturesPresent },
    async () => {
      const buf = require('node:fs').readFileSync(fixturePath);
      const result = await getImageThumbnail(buf, 'heic');
      assert.equal(result.error, null, () => `unexpected error: ${JSON.stringify(result.error)}`);
      assert.equal(result.format, 'webp');
      assert.ok(Buffer.isBuffer(result.thumbnail));
      assert.ok(result.thumbnail.length > 0);
      // Real photos are portrait or landscape depending on how they were
      // shot; either way, the longer edge should land on exactly 1024
      // (the default maxDimension) and the shorter edge should be smaller.
      assert.equal(Math.max(result.width, result.height), 1024);
      assert.ok(Math.min(result.width, result.height) < 1024);
      // Round-trip through sharp to confirm the output bytes are a
      // genuinely valid, undamaged WebP image, not just non-empty bytes.
      const outMeta = await sharp(result.thumbnail).metadata();
      assert.equal(outMeta.format, 'webp');
      assert.equal(outMeta.width, result.width);
      assert.equal(outMeta.height, result.height);
    }
  );
}

// ---------------------------------------------------------------------------
// getImageThumbnail: PSD
// ---------------------------------------------------------------------------

test('getImageThumbnail: psd — embedded thumbnail is extracted and boxed as jpeg', async () => {
  const psd = await buildSyntheticPsd({ withThumbnail: true, thumbWidth: 64, thumbHeight: 32 });
  const result = await getImageThumbnail(psd, 'psd');
  assert.equal(result.error, null);
  assert.equal(result.format, 'jpeg');
  assert.equal(result.width, 64);
  assert.equal(result.height, 32);
});

test('getImageThumbnail: psd — a thumbnail larger than the box still gets bounded', async () => {
  const psd = await buildSyntheticPsd({ withThumbnail: true, thumbWidth: 2000, thumbHeight: 1000 });
  const result = await getImageThumbnail(psd, 'psd', { maxDimension: 300 });
  assert.equal(result.error, null);
  assert.equal(result.format, 'jpeg');
  assert.equal(result.width, 300);
  assert.equal(result.height, 150);
});

test('getImageThumbnail: psd — no embedded thumbnail yields a dedicated error code, never composites', async () => {
  const psd = await buildSyntheticPsd({ withThumbnail: false });
  const result = await getImageThumbnail(psd, 'psd');
  assert.equal(result.thumbnail, null);
  assert.equal(result.error.code, ErrorCode.NO_EMBEDDED_THUMBNAIL);
});

test('getImageThumbnail: psd — invalid signature yields a parse-error', async () => {
  const result = await getImageThumbnail(Buffer.from('not a psd file'), 'psd');
  assert.equal(result.thumbnail, null);
  assert.equal(result.error.code, ErrorCode.PARSE_ERROR);
});

test('getImageThumbnail: psd — an injected parser failure is caught, not propagated', async () => {
  const deps = {
    extractPsdEmbeddedThumbnailJpeg: () => {
      throw new Error('injected psd parser failure');
    },
  };
  const result = await getImageThumbnail(Buffer.from('irrelevant'), 'psd', {}, deps);
  assert.equal(result.thumbnail, null);
  assert.equal(result.error.code, ErrorCode.PARSE_ERROR);
  assert.match(result.error.message, /injected psd parser failure/);
});

// ---------------------------------------------------------------------------
// getImageThumbnail: unsupported formats, too-large, buffer coercion
// ---------------------------------------------------------------------------

for (const fileType of ['cr2', 'nef', 'arw', 'ico', 'bmp-legacy-nonsense', '']) {
  test(`getImageThumbnail: unsupported format "${fileType}" yields unsupported-format, never throws`, async () => {
    const result = await getImageThumbnail(Buffer.from('irrelevant bytes'), fileType);
    assert.equal(result.thumbnail, null);
    assert.equal(result.error.code, ErrorCode.UNSUPPORTED_FORMAT);
  });
}

test('getImageThumbnail: too-large is checked before any decode is attempted', async () => {
  const buf = Buffer.alloc(1000);
  const result = await getImageThumbnail(buf, 'jpeg', { maxFileSizeBytes: 10 });
  assert.equal(result.thumbnail, null);
  assert.equal(result.error.code, ErrorCode.TOO_LARGE);
  assert.match(result.error.message, /1000/);
});

test('getImageThumbnail: accepts a non-Buffer array-like and coerces it', async () => {
  const buf = await buildRasterImage({ width: 100, height: 50, format: 'png' });
  const bytes = Array.from(buf);
  const result = await getImageThumbnail(bytes, 'png');
  assert.equal(result.error, null);
  assert.equal(result.format, 'webp');
});

test('getImageThumbnail: never throws even for completely garbage bytes with a raster-typed assertion', async () => {
  const buf = Buffer.from([0x00, 0xff, 0x13, 0x37, 0xde, 0xad, 0xbe, 0xef]);
  await assert.doesNotReject(async () => {
    const result = await getImageThumbnail(buf, 'png');
    assert.equal(result.thumbnail, null);
    assert.equal(result.error.code, ErrorCode.PARSE_ERROR);
  });
});

test('getImageThumbnail: respects a custom webpQuality without changing dimensions', async () => {
  const buf = await buildNoiseImage({ width: 500, height: 300, format: 'png' });
  const low = await getImageThumbnail(buf, 'png', { webpQuality: 10 });
  const high = await getImageThumbnail(buf, 'png', { webpQuality: 95 });
  assert.equal(low.error, null);
  assert.equal(high.error, null);
  assert.equal(low.width, high.width);
  assert.equal(low.height, high.height);
  assert.ok(low.thumbnail.length < high.thumbnail.length, 'lower quality should produce a smaller buffer');
});

// ---------------------------------------------------------------------------
// getImageThumbnail: output modes ('buffer' / 'html' / 'both')
// ---------------------------------------------------------------------------

test('getImageThumbnail: output "buffer" (default) — unchanged shape, html is null', async () => {
  const buf = await buildRasterImage({ width: 400, height: 200, format: 'png' });
  const explicit = await getImageThumbnail(buf, 'png', { output: 'buffer' });
  const implicit = await getImageThumbnail(buf, 'png'); // no config at all
  for (const result of [explicit, implicit]) {
    assert.equal(result.error, null);
    assert.ok(Buffer.isBuffer(result.thumbnail));
    assert.equal(result.html, null);
    assert.deepEqual(Object.keys(result).sort(), ['error', 'format', 'height', 'html', 'thumbnail', 'width']);
  }
});

test('getImageThumbnail: output "both" — both thumbnail and html present and mutually consistent', async () => {
  const buf = await buildRasterImage({ width: 400, height: 200, format: 'png' });
  const result = await getImageThumbnail(buf, 'png', { output: 'both' });
  assert.equal(result.error, null);
  assert.ok(Buffer.isBuffer(result.thumbnail));
  assert.equal(typeof result.html, 'string');
  assert.match(result.html, /data:image\/webp;base64,/);
  assert.match(result.html, new RegExp(`width="${result.width}"`));
  assert.match(result.html, new RegExp(`height="${result.height}"`));
  // The embedded payload should be exactly the returned thumbnail buffer.
  const embedded = result.html.match(/base64,([^"]+)"/)[1];
  assert.ok(Buffer.from(embedded, 'base64').equals(result.thumbnail));
});

test('getImageThumbnail: output "html" — thumbnail is null, html is present', async () => {
  const buf = await buildRasterImage({ width: 400, height: 200, format: 'png' });
  const result = await getImageThumbnail(buf, 'png', { output: 'html' });
  assert.equal(result.error, null);
  assert.equal(result.thumbnail, null);
  assert.equal(typeof result.html, 'string');
  assert.match(result.html, /data:image\/webp;base64,/);
});

test('getImageThumbnail: output "html" — psd embedded-thumbnail path emits a jpeg data URI', async () => {
  const psd = await buildSyntheticPsd({ withThumbnail: true, thumbWidth: 64, thumbHeight: 32 });
  const result = await getImageThumbnail(psd, 'psd', { output: 'html' });
  assert.equal(result.error, null);
  assert.equal(result.format, 'jpeg');
  assert.match(result.html, /data:image\/jpeg;base64,/);
});

test('getImageThumbnail: an unrecognized output value behaves as "buffer", never throws', async () => {
  const buf = await buildRasterImage({ width: 100, height: 50, format: 'png' });
  const result = await getImageThumbnail(buf, 'png', { output: 'not-a-real-mode' });
  assert.equal(result.error, null);
  assert.ok(Buffer.isBuffer(result.thumbnail));
  assert.equal(result.html, null);
});

test('getImageThumbnail: failure results always include html: null alongside thumbnail: null', async () => {
  const result = await getImageThumbnail(Buffer.from('x'), 'cr2', { output: 'both' });
  assert.equal(result.thumbnail, null);
  assert.equal(result.html, null);
  assert.equal(result.error.code, ErrorCode.UNSUPPORTED_FORMAT);
});

test('getImageThumbnail: html output has no alt attribute (local tool, not a web tool)', async () => {
  const buf = await buildRasterImage({ width: 100, height: 50, format: 'png' });
  const result = await getImageThumbnail(buf, 'png', { output: 'html' });
  assert.doesNotMatch(result.html, /alt=/);
});
