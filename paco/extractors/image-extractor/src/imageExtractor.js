'use strict';

/**
 * image-extractor
 *
 * Turns image bytes of an asserted format into a single-format thumbnail,
 * bounded to a fixed box, safe to run against arbitrary/untrusted input.
 * No filesystem access, no format sniffing (the caller asserts the type,
 * exactly like text-extractor).
 *
 * Branches:
 *   - jpeg/png/webp/avif/tiff/gif  -> sharp, direct decode+resize
 *   - svg                          -> sharp, with an explicit density
 *                                     computed to bound the *rasterization*
 *                                     itself, not just the final resize
 *   - heic/heif                    -> libheif-js (WASM) decode to raw RGBA,
 *                                     then piped into sharp for resize/encode
 *   - psd                          -> zero-dependency manual parse of Image
 *                                     Resource Block 1036 (embedded JPEG
 *                                     thumbnail) ONLY. No full-document
 *                                     compositing is ever attempted; a PSD
 *                                     with no embedded thumbnail is an
 *                                     expressive error, not a slow fallback.
 *   - anything else (RAW, ICO, ...) -> unsupported-format error
 *
 * Output is always a single format: WebP for every branch except the PSD
 * embedded-thumbnail path, which stays JPEG (the resource is already JPEG
 * bytes; re-encoding to WebP would cost a decode+encode round trip for a
 * source that has no alpha channel to preserve in the first place).
 *
 * config.output controls what's returned: 'buffer' (default, just the
 * encoded bytes), 'html' (a ready-to-embed fragment with the image inlined
 * as a data: URI, centered and fit-to-container), or 'both'.
 *
 * Return shape (always, never throws; keys are always present regardless
 * of output mode, so callers never need to guard with `'html' in result`):
 *   { thumbnail: Buffer|null, html: string|null, format: 'webp'|'jpeg', width: number, height: number, error: null }
 *   { thumbnail: null, html: null, error: { code: string, message: string } }
 *
 * Design: pure helpers (PSD parsing, density math, error/success builders)
 * do not touch sharp/libheif-js directly; those calls are isolated in
 * per-branch functions and threaded through an explicit `deps` object so
 * every piece can be unit-tested in isolation (e.g. swap in a fake
 * HeifDecoder that returns a known pixel pattern without needing a real
 * HEIC fixture).
 */

// A small, deliberate exception to extractors otherwise being standalone
// packages — see formatFileTooLargeError's own comment in ui-state.js.
const { formatFileTooLargeError } = require('../../../ui-state');
const sharp = require('sharp');
const libheif = require('libheif-js/wasm-bundle');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG = {
  // Buffers larger than this are rejected before any decode is attempted.
  maxFileSizeBytes: 15 * 1024 * 1024, // 15 MB

  // The thumbnail is scaled to fit within maxDimension x maxDimension,
  // preserving aspect ratio, never cropping.
  maxDimension: 1024,

  // Never upscale a smaller source image beyond its native size.
  withoutEnlargement: true,

  webpQuality: 80,
  jpegQuality: 85, // used only for the PSD embedded-thumbnail branch

  // Explicit decompression-bomb guard, checked against the image's
  // declared pixel count before/while decoding. Deliberately tighter
  // than sharp's own default (~268 megapixels): 100 megapixels comfortably
  // covers legitimate high-resolution photography while still bounding
  // worst-case memory use for a thumbnail generator handling arbitrary
  // input.
  limitInputPixels: 100_000_000,

  // Defensive ceiling on the density value computed for SVG rasterization
  // (see rasterizeSvgWithBoundedDensity). Guards against pathological
  // near-zero declared intrinsic sizes blowing up the density formula.
  maxSvgDensity: 3000,

  // What getImageThumbnail returns: 'buffer' (just the encoded bytes, as
  // before), 'html' (just a ready-to-embed HTML fragment with the image
  // inlined as a data: URI), or 'both'. Unrecognized values behave as
  // 'buffer' — this module does not throw on a malformed config value.
  output: 'buffer',
};

// A small fixed vocabulary of error codes callers can branch on.
const ErrorCode = Object.freeze({
  TOO_LARGE: 'too-large',
  UNSUPPORTED_FORMAT: 'unsupported-format',
  TOO_MANY_PIXELS: 'too-many-pixels',
  NO_EMBEDDED_THUMBNAIL: 'no-embedded-thumbnail',
  PARSE_ERROR: 'parse-error',
});

const RASTER_FORMATS = new Set(['jpeg', 'jpg', 'png', 'webp', 'avif', 'tiff', 'tif', 'gif']);
const HEIC_FORMATS = new Set(['heic', 'heif']);

/** Normalizes caller-supplied format aliases onto sharp's/our canonical names. */
function normalizeFileType(fileType) {
  const t = String(fileType || '').trim().toLowerCase();
  if (t === 'jpg') return 'jpeg';
  if (t === 'tif') return 'tiff';
  return t;
}

// ---------------------------------------------------------------------------
// Pure helpers (no I/O, no injected libs)
// ---------------------------------------------------------------------------

function failure(code, message) {
  return { thumbnail: null, html: null, error: { code, message } };
}

function success(buffer, format, width, height, cfg) {
  const wantsHtml = cfg.output === 'html' || cfg.output === 'both';
  const wantsBuffer = cfg.output !== 'html';
  const html = wantsHtml ? buildThumbnailDataUriHtml(buffer, format, width, height) : null;
  return {
    thumbnail: wantsBuffer ? buffer : null,
    html,
    format,
    width,
    height,
    error: null,
  };
}

/**
 * Builds a self-contained HTML fragment (not a standalone document) that
 * embeds the thumbnail as a data: URI, centered both horizontally and
 * vertically, scaled to fit within whatever space the fragment is placed
 * into without stretching, cropping, or exceeding its container.
 *
 * Assumes the caller places this fragment inside a container that itself
 * has real, computed dimensions (an iframe, a sized div, ...) — the outer
 * element here fills 100% of that parent via flexbox centering.
 *
 * No alt text: this is meant for a local tool, not a web page, so
 * there's no accessibility audience to serve and no caller-supplied
 * string to worry about escaping.
 */
function buildThumbnailDataUriHtml(buffer, format, width, height) {
  const mimeType = format === 'jpeg' ? 'image/jpeg' : 'image/webp';
  const base64 = buffer.toString('base64');
  return (
    '<div style="display:flex;align-items:center;justify-content:center;width:100%;height:100%;">' +
    `<img src="data:${mimeType};base64,${base64}" width="${width}" height="${height}" decoding="async" ` +
    'style="max-width:100%;max-height:100%;width:auto;height:auto;object-fit:contain;display:block;">' +
    '</div>'
  );
}

/**
 * Computes the density (in DPI, relative to the standard 72 DPI baseline)
 * that should be passed to sharp's SVG loader so that rasterization itself
 * happens close to targetDimension, rather than at the SVG's own declared
 * intrinsic size followed by a downscaling resize.
 *
 * This matters because sharp's `.resize()` alone does NOT bound SVG
 * rasterization cost: libvips renders the SVG at its declared intrinsic
 * size x the current density *first*, then resizes that raster. A
 * maliciously large declared width/height/viewBox would otherwise force a
 * large initial raster allocation regardless of the requested output size.
 *
 * The result is clamped into [1, maxDensity] so that a pathological
 * near-zero (or missing/invalid) intrinsic size can't blow the formula up;
 * the subsequent `.resize({ fit: 'inside' })` call remains the actual hard
 * ceiling on output dimensions regardless of any imprecision here.
 */
function computeBoundedSvgDensity(intrinsicWidth, intrinsicHeight, targetDimension, maxDensity) {
  const BASE_DENSITY = 72;
  const w = Number(intrinsicWidth);
  const h = Number(intrinsicHeight);
  const largest = Math.max(
    Number.isFinite(w) && w > 0 ? w : 0,
    Number.isFinite(h) && h > 0 ? h : 0
  );
  if (largest <= 0) {
    // No usable intrinsic size (missing, zero, negative, or NaN) — stay at
    // the default density rather than guess; the post-hoc resize clamp
    // still bounds the final output.
    return BASE_DENSITY;
  }
  const raw = BASE_DENSITY * (targetDimension / largest);
  return Math.min(Math.max(raw, 1), maxDensity);
}

// ---------------------------------------------------------------------------
// PSD: zero-dependency manual parse of Image Resource Block 1036
// (embedded JPEG thumbnail). No full-document compositing is attempted.
// ---------------------------------------------------------------------------

const PSD_THUMBNAIL_RESOURCE_ID = 1036; // 0x040C, "Thumbnail Resource (Photoshop 5.0)"
const PSD_MAX_RESOURCE_BLOCKS = 5000; // defensive iteration cap

function readUInt32BE(buf, offset, label) {
  if (offset < 0 || offset + 4 > buf.length) {
    throw new Error(`Truncated PSD: could not read ${label} at offset ${offset}`);
  }
  return buf.readUInt32BE(offset);
}

function readUInt16BE(buf, offset, label) {
  if (offset < 0 || offset + 2 > buf.length) {
    throw new Error(`Truncated PSD: could not read ${label} at offset ${offset}`);
  }
  return buf.readUInt16BE(offset);
}

/**
 * Parses just enough of a PSD/PSB file to walk into the Image Resources
 * section and pull out the embedded JPEG thumbnail (resource ID 1036), if
 * present. Returns a Buffer of raw JPEG bytes, or null if the file is a
 * structurally valid PSD but has no such resource.
 *
 * Throws if the file doesn't look like a PSD at all, or is truncated in a
 * way that makes the header/resource section unreadable — callers should
 * catch this and treat it as a parse error, distinct from "no thumbnail".
 */
function extractPsdEmbeddedThumbnailJpeg(buffer) {
  if (buffer.length < 26 || buffer.toString('ascii', 0, 4) !== '8BPS') {
    throw new Error('Not a PSD/PSB file (missing "8BPS" signature)');
  }

  // Header: signature(4) version(2) reserved(6) channels(2) height(4)
  // width(4) depth(2) colorMode(2) = 26 bytes total.
  let pos = 26;

  const colorModeDataLen = readUInt32BE(buffer, pos, 'Color Mode Data length');
  pos += 4 + colorModeDataLen;
  if (pos > buffer.length) {
    throw new Error('Truncated PSD: Color Mode Data section exceeds file length');
  }

  const imageResourcesLen = readUInt32BE(buffer, pos, 'Image Resources length');
  pos += 4;
  const resourcesEnd = pos + imageResourcesLen;
  if (resourcesEnd > buffer.length) {
    throw new Error('Truncated PSD: Image Resources section exceeds file length');
  }

  let blocks = 0;
  while (pos < resourcesEnd && blocks < PSD_MAX_RESOURCE_BLOCKS) {
    blocks += 1;

    if (pos + 4 > resourcesEnd || buffer.toString('ascii', pos, pos + 4) !== '8BIM') {
      break; // not a well-formed resource block boundary; stop scanning
    }
    pos += 4;

    const resourceId = readUInt16BE(buffer, pos, 'resource ID');
    pos += 2;

    const nameLen = buffer[pos];
    if (pos + 1 > resourcesEnd) break;
    let nameFieldLen = 1 + nameLen;
    if (nameFieldLen % 2 !== 0) nameFieldLen += 1;
    pos += nameFieldLen;

    const dataLen = readUInt32BE(buffer, pos, 'resource data length');
    pos += 4;

    const dataStart = pos;
    const dataEnd = dataStart + dataLen;
    if (dataEnd > resourcesEnd || dataLen < 0) {
      throw new Error('Truncated PSD: resource data exceeds Image Resources section');
    }

    if (resourceId === PSD_THUMBNAIL_RESOURCE_ID) {
      // Thumbnail resource layout: format(4) width(4) height(4)
      // widthBytes(4) totalSize(4) compressedSize(4) bitsPerPixel(2)
      // numPlanes(2) = 28 bytes, followed by raw JPEG data.
      if (dataLen < 28) {
        throw new Error('Malformed PSD thumbnail resource: shorter than its fixed header');
      }
      const jpegStart = dataStart + 28;
      const declaredCompressedSize = readUInt32BE(buffer, dataStart + 20, 'thumbnail compressedSize');
      const jpegEnd = Math.min(dataEnd, jpegStart + declaredCompressedSize);
      if (jpegEnd <= jpegStart) {
        throw new Error('Malformed PSD thumbnail resource: empty JPEG payload');
      }
      return buffer.subarray(jpegStart, jpegEnd);
    }

    pos = dataEnd + (dataLen % 2 !== 0 ? 1 : 0); // resource data is padded to even length
  }

  return null; // structurally fine, just no thumbnail resource present
}

// ---------------------------------------------------------------------------
// Per-branch thumbnail generators (isolate sharp/libheif-js calls; deps injectable)
// ---------------------------------------------------------------------------

async function rasterThumbnail(buffer, cfg, deps) {
  const sharpLib = deps.sharp || sharp;
  const { data, info } = await sharpLib(buffer, { limitInputPixels: cfg.limitInputPixels, animated: false })
    .rotate() // auto-orient per EXIF before resizing, then strip the tag
    .resize(cfg.maxDimension, cfg.maxDimension, { fit: 'inside', withoutEnlargement: cfg.withoutEnlargement })
    .webp({ quality: cfg.webpQuality })
    .toBuffer({ resolveWithObject: true });
  return success(data, 'webp', info.width, info.height, cfg);
}

async function svgThumbnail(buffer, cfg, deps) {
  const sharpLib = deps.sharp || sharp;
  // Reading SVG metadata is XML attribute parsing, not rasterization — no
  // pixel data is decoded at this stage regardless of how large the
  // declared width/height/viewBox are, so the pixel-limit guard is
  // deliberately left off here. It would otherwise reject the metadata
  // read itself for a legitimately huge-canvas SVG before we ever get the
  // chance to compute a safely bounded density in response. The guard is
  // reinstated below, on the call that actually rasterizes pixels.
  const metadata = await sharpLib(buffer, { limitInputPixels: false }).metadata();
  const density = computeBoundedSvgDensity(metadata.width, metadata.height, cfg.maxDimension, cfg.maxSvgDensity);

  const { data, info } = await sharpLib(buffer, { density, limitInputPixels: cfg.limitInputPixels })
    .resize(cfg.maxDimension, cfg.maxDimension, { fit: 'inside', withoutEnlargement: cfg.withoutEnlargement })
    .webp({ quality: cfg.webpQuality })
    .toBuffer({ resolveWithObject: true });
  return success(data, 'webp', info.width, info.height, cfg);
}

async function heicThumbnail(buffer, cfg, deps) {
  const HeifDecoder = deps.HeifDecoder || libheif.HeifDecoder;
  const sharpLib = deps.sharp || sharp;

  const decoder = new HeifDecoder();
  const images = decoder.decode(buffer);
  if (!images || images.length === 0) {
    throw new Error('Could not decode HEIC/HEIF image: no images found in container');
  }

  const image = images[0];
  const width = image.get_width();
  const height = image.get_height();
  if (!width || !height || width <= 0 || height <= 0) {
    throw new Error('Could not decode HEIC/HEIF image: invalid dimensions');
  }

  // Checked before allocating the RGBA buffer or calling display(), which
  // is the expensive step this guard is meant to avoid triggering. Kept
  // as its own message, not routed through formatFileTooLargeError — this
  // limit is measured in pixels, not bytes, so fmtSize's units don't
  // apply; only the "File too large:" prefix is shared, for consistency
  // with every other too-large message an extractor can emit.
  if (width * height > cfg.limitInputPixels) {
    const err = new Error(
      `File too large: HEIC/HEIF image is ${width}x${height} (${width * height} pixels), exceeding the ${cfg.limitInputPixels}-pixel limit.`
    );
    err.code = ErrorCode.TOO_MANY_PIXELS;
    throw err;
  }

  const displayData = await new Promise((resolve, reject) => {
    image.display({ data: new Uint8ClampedArray(width * height * 4), width, height }, (result) => {
      if (!result) {
        reject(new Error('HEIF processing error while extracting pixel data'));
        return;
      }
      resolve(result);
    });
  });

  const rawBuffer = Buffer.from(displayData.data.buffer, displayData.data.byteOffset, displayData.data.byteLength);

  const { data, info } = await sharpLib(rawBuffer, {
    raw: { width, height, channels: 4 },
    limitInputPixels: cfg.limitInputPixels,
  })
    .resize(cfg.maxDimension, cfg.maxDimension, { fit: 'inside', withoutEnlargement: cfg.withoutEnlargement })
    .webp({ quality: cfg.webpQuality })
    .toBuffer({ resolveWithObject: true });

  return success(data, 'webp', info.width, info.height, cfg);
}

async function psdThumbnail(buffer, cfg, deps) {
  const sharpLib = deps.sharp || sharp;
  const parse = deps.extractPsdEmbeddedThumbnailJpeg || extractPsdEmbeddedThumbnailJpeg;

  const jpegBytes = parse(buffer);
  if (!jpegBytes) {
    const err = new Error('PSD has no embedded JPEG thumbnail resource (1036); full compositing is out of scope.');
    err.code = ErrorCode.NO_EMBEDDED_THUMBNAIL;
    throw err;
  }

  const { data, info } = await sharpLib(jpegBytes, { limitInputPixels: cfg.limitInputPixels })
    .resize(cfg.maxDimension, cfg.maxDimension, { fit: 'inside', withoutEnlargement: cfg.withoutEnlargement })
    .jpeg({ quality: cfg.jpegQuality })
    .toBuffer({ resolveWithObject: true });

  return success(data, 'jpeg', info.width, info.height, cfg);
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Produces a single-format (WebP, except JPEG for the PSD
 * embedded-thumbnail path) thumbnail bounded to config.maxDimension, from
 * image bytes of an asserted format. Never throws.
 *
 * @param {Buffer} fileContent - the image's raw bytes
 * @param {string} fileType - one of 'jpeg'/'jpg', 'png', 'webp', 'avif',
 *   'tiff'/'tif', 'gif', 'svg', 'heic', 'heif', 'psd'. Not validated or
 *   inferred by this module — the caller is responsible for only ever
 *   asserting a format it has already identified. Anything else
 *   (RAW formats, ICO, ...) resolves to an unsupported-format error.
 * @param {object} [config] - overrides for DEFAULT_CONFIG
 * @param {object} [deps] - injectable dependencies: { sharp, HeifDecoder, extractPsdEmbeddedThumbnailJpeg }
 * @returns {{ thumbnail: Buffer|null, html: string|null, format: string, width: number, height: number, error: null }
 *          | { thumbnail: null, html: null, error: { code: string, message: string } }}
 */
async function getImageThumbnail(fileContent, fileType, config = {}, deps = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const type = normalizeFileType(fileType);

  let buffer;
  try {
    buffer = Buffer.isBuffer(fileContent) ? fileContent : Buffer.from(fileContent);
  } catch (err) {
    return failure(ErrorCode.PARSE_ERROR, `fileContent could not be read as a Buffer: ${err.message}`);
  }

  if (buffer.byteLength > cfg.maxFileSizeBytes) {
    return failure(ErrorCode.TOO_LARGE, formatFileTooLargeError(buffer.byteLength, cfg.maxFileSizeBytes));
  }

  try {
    if (RASTER_FORMATS.has(type)) {
      return await rasterThumbnail(buffer, cfg, deps);
    }
    if (type === 'svg') {
      return await svgThumbnail(buffer, cfg, deps);
    }
    if (HEIC_FORMATS.has(type)) {
      return await heicThumbnail(buffer, cfg, deps);
    }
    if (type === 'psd') {
      return await psdThumbnail(buffer, cfg, deps);
    }
    return failure(ErrorCode.UNSUPPORTED_FORMAT, `Unsupported image format: "${fileType}".`);
  } catch (err) {
    const code = (err && err.code) || ErrorCode.PARSE_ERROR;
    return failure(code, err && err.message ? err.message : String(err));
  }
}

module.exports = {
  getImageThumbnail,
  // exported for unit testing / composition
  normalizeFileType,
  computeBoundedSvgDensity,
  extractPsdEmbeddedThumbnailJpeg,
  buildThumbnailDataUriHtml,
  failure,
  success,
  ErrorCode,
  DEFAULT_CONFIG,
};
