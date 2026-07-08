'use strict';

const sharp = require('sharp');

/** Builds a solid-color raster image buffer in the requested format. */
async function buildRasterImage({ width, height, color = { r: 180, g: 60, b: 60 }, format = 'png' }) {
  let pipeline = sharp({ create: { width, height, channels: 3, background: color } });
  if (format === 'jpeg') pipeline = pipeline.jpeg();
  else if (format === 'png') pipeline = pipeline.png();
  else if (format === 'webp') pipeline = pipeline.webp();
  else if (format === 'avif') pipeline = pipeline.avif();
  else if (format === 'tiff') pipeline = pipeline.tiff();
  else throw new Error(`buildRasterImage: unsupported format "${format}"`);
  return pipeline.toBuffer();
}

/** Builds a multi-frame animated GIF buffer. */
async function buildAnimatedGif({ width = 100, height = 60, frameColors }) {
  const frames = await Promise.all(
    frameColors.map((color) => sharp({ create: { width, height, channels: 3, background: color } }).png().toBuffer())
  );
  return sharp(frames, { join: { animated: true } }).gif().toBuffer();
}

/**
 * Hand-builds a minimal PSD/PSB buffer, optionally containing an Image
 * Resource Block 1036 (embedded JPEG thumbnail) wrapping a real, tiny
 * JPEG generated via sharp. Mirrors the structure described in
 * src/imageExtractor.js's extractPsdEmbeddedThumbnailJpeg.
 */
async function buildSyntheticPsd({ withThumbnail = true, thumbWidth = 64, thumbHeight = 32 } = {}) {
  const parts = [];

  const header = Buffer.alloc(26);
  header.write('8BPS', 0, 'ascii');
  header.writeUInt16BE(1, 4); // version = 1 (PSD)
  header.writeUInt16BE(3, 12); // channels
  header.writeUInt32BE(100, 14); // height
  header.writeUInt32BE(100, 18); // width
  header.writeUInt16BE(8, 22); // depth
  header.writeUInt16BE(3, 24); // color mode (RGB)
  parts.push(header);

  parts.push(Buffer.alloc(4)); // Color Mode Data section length = 0, no data

  let resourceBlocks = Buffer.alloc(0);

  if (withThumbnail) {
    const jpegThumb = await sharp({
      create: { width: thumbWidth, height: thumbHeight, channels: 3, background: { r: 10, g: 200, b: 90 } },
    })
      .jpeg({ quality: 90 })
      .toBuffer();

    const thumbHeader = Buffer.alloc(28);
    thumbHeader.writeUInt32BE(1, 0); // format = kJpegRGB
    thumbHeader.writeUInt32BE(thumbWidth, 4);
    thumbHeader.writeUInt32BE(thumbHeight, 8);
    thumbHeader.writeUInt32BE(thumbWidth * 3, 12); // widthBytes
    thumbHeader.writeUInt32BE(thumbWidth * thumbHeight * 3, 16); // totalSize
    thumbHeader.writeUInt32BE(jpegThumb.length, 20); // compressedSize
    thumbHeader.writeUInt16BE(24, 24); // bitsPerPixel
    thumbHeader.writeUInt16BE(1, 26); // numPlanes

    const thumbData = Buffer.concat([thumbHeader, jpegThumb]);
    const dataLen = thumbData.length;
    const padding = dataLen % 2 !== 0 ? Buffer.alloc(1) : Buffer.alloc(0);

    const blockHeader = Buffer.alloc(4 + 2 + 2); // '8BIM' + resourceId(2) + empty Pascal name padded to 2 bytes
    blockHeader.write('8BIM', 0, 'ascii');
    blockHeader.writeUInt16BE(1036, 4);

    const dataLenField = Buffer.alloc(4);
    dataLenField.writeUInt32BE(dataLen, 0);

    resourceBlocks = Buffer.concat([blockHeader, dataLenField, thumbData, padding]);
  }

  const resourcesLenField = Buffer.alloc(4);
  resourcesLenField.writeUInt32BE(resourceBlocks.length, 0);
  parts.push(resourcesLenField, resourceBlocks);

  return Buffer.concat(parts);
}

/** Builds a random-noise raster image — needed for tests where a flat solid color would compress identically regardless of quality settings. */
async function buildNoiseImage({ width, height, format = 'png' }) {
  const pixelCount = width * height * 3;
  const noise = Buffer.alloc(pixelCount);
  for (let i = 0; i < pixelCount; i++) noise[i] = Math.floor(Math.random() * 256);
  let pipeline = sharp(noise, { raw: { width, height, channels: 3 } });
  if (format === 'jpeg') pipeline = pipeline.jpeg();
  else if (format === 'png') pipeline = pipeline.png();
  else if (format === 'webp') pipeline = pipeline.webp();
  else throw new Error(`buildNoiseImage: unsupported format "${format}"`);
  return pipeline.toBuffer();
}

module.exports = { buildRasterImage, buildAnimatedGif, buildSyntheticPsd, buildNoiseImage };
