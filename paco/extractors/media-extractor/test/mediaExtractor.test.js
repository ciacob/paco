'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');

const {
  getMediaPreview,
  normalizeFileType,
  formatTimecode,
  extractDurationSeconds,
  parseFrameRate,
  classifyStreams,
  boundAndEncode,
  encodeAsIs,
  metadataTableHtml,
  videoHtml,
  audioHtml,
  ErrorCode,
  ALLOWED_FORMATS,
  DEFAULT_CONFIG,
  SPECTROGRAM_COLORS,
} = require('../src/mediaExtractor');

const { testDeps, buildVideoWithAudio, buildSilentVideo, buildWebm, buildAudio, buildAudioWithCover } = require('./fixtures');

// ---------------------------------------------------------------------------
// Fixture setup — real files, generated once via the system ffmpeg
// ---------------------------------------------------------------------------

let tmpDir;
let videoWithAudioBuf;
let silentVideoBuf;
let webmBuf;
let audioBuf;
let audioWithCoverBuf;

test.before(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'media-extractor-fixtures-'));
  videoWithAudioBuf = await buildVideoWithAudio(path.join(tmpDir, 'video.mp4'));
  silentVideoBuf = await buildSilentVideo(path.join(tmpDir, 'silent.mp4'));
  webmBuf = await buildWebm(path.join(tmpDir, 'video.webm'));
  audioBuf = await buildAudio(path.join(tmpDir, 'audio.mp3'));
  audioWithCoverBuf = await buildAudioWithCover(path.join(tmpDir, 'audio_with_cover.mp3'), tmpDir);
});

test.after(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

// ---------------------------------------------------------------------------
// normalizeFileType / ALLOWED_FORMATS
// ---------------------------------------------------------------------------

test('normalizeFileType: lowercases and trims', () => {
  assert.equal(normalizeFileType('  MP4  '), 'mp4');
  assert.equal(normalizeFileType('Mp3'), 'mp3');
});

test('normalizeFileType: maps known aliases', () => {
  assert.equal(normalizeFileType('mpeg-ts'), 'mpegts');
  assert.equal(normalizeFileType('wavpack'), 'wv');
});

test('ALLOWED_FORMATS: covers the documented typical video and audio types', () => {
  for (const t of ['mp4', 'mov', 'mkv', 'webm', 'avi', 'flv', 'wmv', 'ogv']) {
    assert.ok(ALLOWED_FORMATS[t], `expected ${t} to be allowed`);
  }
  for (const t of ['mp3', 'wav', 'flac', 'm4a', 'ogg', 'wma', 'aiff']) {
    assert.ok(ALLOWED_FORMATS[t], `expected ${t} to be allowed`);
  }
});

// ---------------------------------------------------------------------------
// formatTimecode
// ---------------------------------------------------------------------------

test('formatTimecode: M:SS under an hour', () => {
  assert.equal(formatTimecode(0), '0:00');
  assert.equal(formatTimecode(5), '0:05');
  assert.equal(formatTimecode(65), '1:05');
  assert.equal(formatTimecode(3599), '59:59');
});

test('formatTimecode: H:MM:SS at/above an hour', () => {
  assert.equal(formatTimecode(3600), '1:00:00');
  assert.equal(formatTimecode(3665), '1:01:05');
  assert.equal(formatTimecode(7325), '2:02:05');
});

test('formatTimecode: negative input clamps to zero', () => {
  assert.equal(formatTimecode(-5), '0:00');
});

// ---------------------------------------------------------------------------
// extractDurationSeconds
// ---------------------------------------------------------------------------

test('extractDurationSeconds: reads format.duration when present', () => {
  const d = extractDurationSeconds({ format: { duration: '12.5' }, streams: [] });
  assert.equal(d, 12.5);
});

test('extractDurationSeconds: falls back to a stream duration if format lacks one', () => {
  const d = extractDurationSeconds({ format: {}, streams: [{ duration: '7.25' }] });
  assert.equal(d, 7.25);
});

test('extractDurationSeconds: returns null for missing/zero/negative/non-finite values', () => {
  assert.equal(extractDurationSeconds({ format: {}, streams: [] }), null);
  assert.equal(extractDurationSeconds({ format: { duration: '0' }, streams: [] }), null);
  assert.equal(extractDurationSeconds({ format: { duration: '-5' }, streams: [] }), null);
  assert.equal(extractDurationSeconds({ format: { duration: 'N/A' }, streams: [] }), null);
  assert.equal(extractDurationSeconds(null), null);
});

// ---------------------------------------------------------------------------
// parseFrameRate
// ---------------------------------------------------------------------------

test('parseFrameRate: parses "num/den" strings', () => {
  assert.equal(parseFrameRate('30/1'), 30);
  assert.equal(parseFrameRate('30000/1001'), 30000 / 1001);
});

test('parseFrameRate: handles null/malformed input gracefully', () => {
  assert.equal(parseFrameRate(null), null);
  assert.equal(parseFrameRate(''), null);
  assert.equal(parseFrameRate('not-a-rate'), null);
});

// ---------------------------------------------------------------------------
// classifyStreams — the attached-pic misclassification fix
// ---------------------------------------------------------------------------

test('classifyStreams: a real video stream is found and not confused with attached-pic', () => {
  const { videoStream, attachedPicStream, audioStream } = classifyStreams([
    { codec_type: 'video', index: 0, disposition: { attached_pic: 0 } },
    { codec_type: 'audio', index: 1 },
  ]);
  assert.ok(videoStream);
  assert.equal(attachedPicStream, undefined);
  assert.ok(audioStream);
});

test('classifyStreams: an attached-pic stream is NOT reported as the real video stream', () => {
  const { videoStream, attachedPicStream, audioStream } = classifyStreams([
    { codec_type: 'audio', index: 0 },
    { codec_type: 'video', index: 1, disposition: { attached_pic: 1 } },
  ]);
  assert.equal(videoStream, undefined);
  assert.ok(attachedPicStream);
  assert.equal(attachedPicStream.index, 1);
  assert.ok(audioStream);
});

test('classifyStreams: handles missing disposition objects without throwing', () => {
  const result = classifyStreams([{ codec_type: 'video', index: 0 }]);
  assert.ok(result.videoStream);
});

test('classifyStreams: handles empty/undefined stream lists', () => {
  assert.deepEqual(classifyStreams([]), { videoStream: undefined, attachedPicStream: undefined, audioStream: undefined });
  assert.deepEqual(classifyStreams(undefined), { videoStream: undefined, attachedPicStream: undefined, audioStream: undefined });
});

// ---------------------------------------------------------------------------
// boundAndEncode / encodeAsIs
// ---------------------------------------------------------------------------

test('boundAndEncode: boxes into maxDimension, fit inside, no upscale by default', async () => {
  const raw = await sharp({ create: { width: 800, height: 400, channels: 3, background: { r: 10, g: 20, b: 30 } } }).png().toBuffer();
  const result = await boundAndEncode(raw, { ...DEFAULT_CONFIG, maxDimension: 200 }, sharp);
  assert.equal(result.format, 'webp');
  assert.equal(result.width, 200);
  assert.equal(result.height, 100);
});

test('encodeAsIs: re-encodes without resizing, even when larger than a typical box size', async () => {
  const raw = await sharp({ create: { width: 1200, height: 300, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toBuffer();
  const result = await encodeAsIs(raw, DEFAULT_CONFIG, sharp);
  assert.equal(result.format, 'webp');
  assert.equal(result.width, 1200);
  assert.equal(result.height, 300);
});

// ---------------------------------------------------------------------------
// HTML assembly
// ---------------------------------------------------------------------------

test('metadataTableHtml: renders a semantic table, skipping null/undefined fields', () => {
  const html = metadataTableHtml({ a: 1, b: null, c: 'x', d: undefined });
  assert.match(html, /<table>/);
  assert.match(html, /<th>a<\/th><td>1<\/td>/);
  assert.match(html, /<th>c<\/th><td>x<\/td>/);
  assert.doesNotMatch(html, /<th>b<\/th>/);
  assert.doesNotMatch(html, /<th>d<\/th>/);
});

test('metadataTableHtml: escapes values (and keys) rather than interpolating them raw', () => {
  const html = metadataTableHtml({ videoCodec: '<script>alert(1)</script>', 'weird&key': 'a"b\'c' });
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /weird&amp;key/);
  assert.match(html, /a&quot;b&#39;c/);
});

test('videoHtml: wraps frames in figure/figcaption with centered timecodes, table beneath', () => {
  const items = [
    { label: 'frame@10%', timecode: '0:01', thumbnail: Buffer.from('x'), width: 100, height: 50 },
    { label: 'frame@50%', timecode: '0:03', thumbnail: Buffer.from('y'), width: 100, height: 50 },
  ];
  const html = videoHtml(items, { duration: '0:06' });
  assert.match(html, /<figure/);
  assert.match(html, /<figcaption>0:01<\/figcaption>/);
  assert.match(html, /<figcaption>0:03<\/figcaption>/);
  assert.match(html, /flex-wrap:wrap/);
  assert.match(html, /<table>/);
  // width/height are percentage-based, not the item's own real pixel
  // dimensions — see videoHtml's own comment for why: the containing
  // <figure> has no explicit size, but a flex item's width still
  // genuinely shrinks under flex-shrink when there isn't room for all
  // frames at natural size, and height="100%" falls back to auto,
  // scaling proportionally with whatever width flexbox resolved.
  assert.match(html, /<img[^>]+width="100%"[^>]+height="100%"/);
});

test("videoHtml: outer wrapper omits align-items:center — overflowing content shouldn't be symmetrically clipped top and bottom", () => {
  const items = [{ label: 'frame@10%', timecode: '0:01', thumbnail: Buffer.from('x'), width: 100, height: 50 }];
  const html = videoHtml(items, {});
  const outerDivStyle = html.match(/<div style="([^"]*)"/)[1];
  assert.doesNotMatch(outerDivStyle, /align-items/);
  assert.match(outerDivStyle, /justify-content:center/); // horizontal centering is unaffected
});

test('audioHtml: stacks images with shrink-never-grow styling, table beneath', () => {
  const items = [
    { label: 'waveform', thumbnail: Buffer.from('x'), width: 1200, height: 300 },
    { label: 'spectrogram', thumbnail: Buffer.from('y'), width: 1200, height: 300 },
  ];
  const html = audioHtml(items, { duration: '0:05' });
  assert.match(html, /max-width:100%/);
  assert.doesNotMatch(html, /flex-wrap/);
  assert.match(html, /<table>/);
});

test('audioHtml: outer wrapper also omits align-items:center, same reasoning as videoHtml', () => {
  const items = [{ label: 'waveform', thumbnail: Buffer.from('x'), width: 1200, height: 300 }];
  const html = audioHtml(items, {});
  const outerDivStyle = html.match(/<div style="([^"]*)"/)[1];
  assert.doesNotMatch(outerDivStyle, /align-items/);
  assert.match(outerDivStyle, /justify-content:center/);
});

// ---------------------------------------------------------------------------
// getMediaPreview: video branch (real fixtures)
// ---------------------------------------------------------------------------

test('getMediaPreview: video with audio produces a 5-frame filmstrip and correct metadata', async () => {
  const result = await getMediaPreview(videoWithAudioBuf, 'mp4', {}, testDeps);
  assert.equal(result.error, null);
  assert.equal(result.kind, 'video');
  assert.equal(result.items.length, 5);
  assert.deepEqual(
    result.items.map((i) => i.label),
    ['frame@10%', 'frame@30%', 'frame@50%', 'frame@70%', 'frame@90%']
  );
  for (const item of result.items) {
    assert.ok(Buffer.isBuffer(item.thumbnail));
    assert.equal(item.format, 'webp');
    assert.match(item.timecode, /^\d+:\d{2}$/);
  }
  assert.equal(result.metadata.width, 320);
  assert.equal(result.metadata.height, 240);
  assert.equal(result.metadata.videoCodec, 'h264');
  assert.equal(result.metadata.hasAudio, true);
  assert.equal(result.metadata.audioCodec, 'aac');
});

test('getMediaPreview: silent video (no audio stream) still produces a filmstrip, hasAudio false', async () => {
  const result = await getMediaPreview(silentVideoBuf, 'mp4', {}, testDeps);
  assert.equal(result.error, null);
  assert.equal(result.kind, 'video');
  assert.equal(result.items.length, 5);
  assert.equal(result.metadata.hasAudio, false);
  assert.equal(result.metadata.audioCodec, null);
});

test('getMediaPreview: WebM (VP9/Opus) container works, proving multi-container support', async () => {
  const result = await getMediaPreview(webmBuf, 'webm', {}, testDeps);
  assert.equal(result.error, null);
  assert.equal(result.kind, 'video');
  assert.equal(result.items.length, 5);
});

test('getMediaPreview: frames are boxed to frameMaxDimension', async () => {
  const result = await getMediaPreview(videoWithAudioBuf, 'mp4', { frameMaxDimension: 64 }, testDeps);
  assert.equal(result.error, null);
  for (const item of result.items) {
    assert.ok(item.width <= 64 && item.height <= 64);
  }
});

test('getMediaPreview: custom filmstripPercentages are respected', async () => {
  const result = await getMediaPreview(videoWithAudioBuf, 'mp4', { filmstripPercentages: [0, 50, 100] }, testDeps);
  assert.equal(result.error, null);
  assert.deepEqual(
    result.items.map((i) => i.label),
    ['frame@0%', 'frame@50%', 'frame@100%']
  );
});

// ---------------------------------------------------------------------------
// getMediaPreview: audio branch (real fixtures)
// ---------------------------------------------------------------------------

test('getMediaPreview: plain audio (no cover) produces waveform + spectrogram, no cover item', async () => {
  const result = await getMediaPreview(audioBuf, 'mp3', {}, testDeps);
  assert.equal(result.error, null);
  assert.equal(result.kind, 'audio');
  assert.deepEqual(
    result.items.map((i) => i.label),
    ['waveform', 'spectrogram']
  );
  for (const item of result.items) {
    assert.equal(item.width, DEFAULT_CONFIG.waveformWidth);
    assert.equal(item.height, DEFAULT_CONFIG.waveformHeight);
  }
  assert.equal(result.metadata.audioCodec, 'mp3');
  assert.equal(result.metadata.sampleRate, 44100);
});

test('getMediaPreview: audio with embedded cover art is classified as audio (not video), cover appears first', async () => {
  const result = await getMediaPreview(audioWithCoverBuf, 'mp3', {}, testDeps);
  assert.equal(result.error, null);
  assert.equal(result.kind, 'audio'); // the key regression check: NOT 'video'
  assert.deepEqual(
    result.items.map((i) => i.label),
    ['cover', 'waveform', 'spectrogram']
  );
  const cover = result.items[0];
  assert.equal(cover.width, 200);
  assert.equal(cover.height, 200);
});

test('getMediaPreview: cover art is boxed to coverMaxDimension and never upscaled', async () => {
  const result = await getMediaPreview(audioWithCoverBuf, 'mp3', { coverMaxDimension: 100 }, testDeps);
  assert.equal(result.error, null);
  const cover = result.items.find((i) => i.label === 'cover');
  assert.equal(cover.width, 100);
  assert.equal(cover.height, 100);
});

test('getMediaPreview: waveformWidth/waveformHeight config is respected by both visualizations', async () => {
  const result = await getMediaPreview(audioBuf, 'mp3', { waveformWidth: 400, waveformHeight: 120 }, testDeps);
  assert.equal(result.error, null);
  for (const item of result.items) {
    assert.equal(item.width, 400);
    assert.equal(item.height, 120);
  }
});

test('getMediaPreview: an invalid spectrogramColor falls back to "fire" rather than breaking the filter', async () => {
  const result = await getMediaPreview(audioBuf, 'mp3', { spectrogramColor: 'not-a-real-color; evil' }, testDeps);
  assert.equal(result.error, null);
  assert.equal(result.kind, 'audio');
});

test('SPECTROGRAM_COLORS: "fire" (the default) is a valid member', () => {
  assert.ok(SPECTROGRAM_COLORS.has(DEFAULT_CONFIG.spectrogramColor));
});

// ---------------------------------------------------------------------------
// getMediaPreview: output modes
// ---------------------------------------------------------------------------

test('getMediaPreview: output "buffers" (default) — thumbnails present, html null', async () => {
  const explicit = await getMediaPreview(audioBuf, 'mp3', { output: 'buffers' }, testDeps);
  const implicit = await getMediaPreview(audioBuf, 'mp3', {}, testDeps);
  for (const result of [explicit, implicit]) {
    assert.equal(result.html, null);
    assert.ok(result.items.every((i) => Buffer.isBuffer(i.thumbnail)));
  }
});

test('getMediaPreview: output "html" — thumbnails null, html present and non-empty', async () => {
  const result = await getMediaPreview(videoWithAudioBuf, 'mp4', { output: 'html' }, testDeps);
  assert.equal(result.error, null);
  assert.ok(result.items.every((i) => i.thumbnail === null));
  assert.equal(typeof result.html, 'string');
  assert.match(result.html, /data:image\/webp;base64,/);
});

test('getMediaPreview: output "both" — both present and mutually consistent', async () => {
  const result = await getMediaPreview(audioBuf, 'mp3', { output: 'both' }, testDeps);
  assert.equal(result.error, null);
  assert.ok(result.items.every((i) => Buffer.isBuffer(i.thumbnail)));
  assert.equal(typeof result.html, 'string');
  const firstEmbedded = result.html.match(/base64,([^"]+)"/)[1];
  assert.ok(Buffer.from(firstEmbedded, 'base64').equals(result.items[0].thumbnail));
});

// ---------------------------------------------------------------------------
// getMediaPreview: failure paths — never throws
// ---------------------------------------------------------------------------

test('getMediaPreview: too-large is checked before touching ffmpeg/ffprobe at all', async () => {
  const result = await getMediaPreview(Buffer.alloc(1000), 'mp4', { maxFileSizeBytes: 10 }, testDeps);
  assert.equal(result.kind, null);
  assert.equal(result.error.code, ErrorCode.TOO_LARGE);
  assert.match(result.error.message, /1000/);
});

for (const fileType of ['rm', 'divx', 'mpeg1', '']) {
  test(`getMediaPreview: unsupported format "${fileType}" yields unsupported-format, never throws`, async () => {
    const result = await getMediaPreview(Buffer.from('irrelevant'), fileType, {}, testDeps);
    assert.equal(result.kind, null);
    assert.equal(result.error.code, ErrorCode.UNSUPPORTED_FORMAT);
  });
}

test('getMediaPreview: garbage bytes with a valid asserted type yield parse-error, never throw', async () => {
  const result = await getMediaPreview(Buffer.from('this is not a real media file'), 'mp4', {}, testDeps);
  assert.equal(result.kind, null);
  assert.equal(result.error.code, ErrorCode.PARSE_ERROR);
});

test('getMediaPreview: missing ffmpeg/ffprobe binaries yield ffmpeg-unavailable, never throw', async () => {
  const badDeps = { ffmpegPath: '/does/not/exist/ffmpeg', ffprobePath: '/usr/bin/ffprobe' };
  const result = await getMediaPreview(videoWithAudioBuf, 'mp4', {}, badDeps);
  assert.equal(result.kind, null);
  assert.equal(result.error.code, ErrorCode.FFMPEG_UNAVAILABLE);
});

test('getMediaPreview: a file with neither audio nor video streams yields parse-error', async () => {
  // A tiny valid-but-empty WAV header (44 bytes, zero audio frames) is
  // enough for ffprobe to open the container; whether it reports zero
  // duration or zero usable streams, either path must fail gracefully.
  const emptyWav = Buffer.concat([
    Buffer.from('RIFF', 'ascii'),
    Buffer.from([0x24, 0, 0, 0]),
    Buffer.from('WAVEfmt ', 'ascii'),
    Buffer.from([16, 0, 0, 0, 1, 0, 1, 0, 0x44, 0xac, 0, 0, 0x88, 0x58, 1, 0, 2, 0, 16, 0]),
    Buffer.from('data', 'ascii'),
    Buffer.from([0, 0, 0, 0]),
  ]);
  const result = await getMediaPreview(emptyWav, 'wav', {}, testDeps);
  assert.equal(result.kind, null);
  assert.equal(result.error.code, ErrorCode.PARSE_ERROR);
});

test('getMediaPreview: accepts a non-Buffer array-like and coerces it', async () => {
  const bytes = Array.from(audioBuf);
  const result = await getMediaPreview(bytes, 'mp3', {}, testDeps);
  assert.equal(result.error, null);
  assert.equal(result.kind, 'audio');
});

// ---------------------------------------------------------------------------
// Temp file cleanup
// ---------------------------------------------------------------------------

test('getMediaPreview: cleans up its scoped temp directory after a successful run', async () => {
  const before = (await fsp.readdir(os.tmpdir())).filter((n) => n.startsWith('media-extractor-'));
  await getMediaPreview(audioBuf, 'mp3', {}, testDeps);
  const after = (await fsp.readdir(os.tmpdir())).filter((n) => n.startsWith('media-extractor-'));
  assert.equal(after.length, before.length, 'expected no leftover media-extractor temp directories');
});

test('getMediaPreview: cleans up its scoped temp directory even after a failure', async () => {
  const before = (await fsp.readdir(os.tmpdir())).filter((n) => n.startsWith('media-extractor-'));
  await getMediaPreview(Buffer.from('garbage'), 'mp4', {}, testDeps);
  const after = (await fsp.readdir(os.tmpdir())).filter((n) => n.startsWith('media-extractor-'));
  assert.equal(after.length, before.length, 'expected no leftover media-extractor temp directories after failure');
});
