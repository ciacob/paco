'use strict';

/**
 * media-extractor
 *
 * Turns video/audio bytes of an asserted format into a small set of
 * bounded, safe preview images — never full playback:
 *   - video -> a filmstrip: one frame at each of several percentages
 *     through the file's duration (default 10/30/50/70/90%)
 *   - audio -> a waveform and a spectrogram, plus embedded cover art
 *     if present (e.g. ID3 APIC frames in MP3/M4A)
 *
 * This exists because, unlike images, there is no cheap way to "bound
 * and re-encode" full audio/video for safe inline playback (see the
 * design discussion this module grew out of) — and unlike documents,
 * there's no realistic target runtime whose native codec support can
 * be trusted without per-deployment verification. Extracting a small,
 * fixed number of *static images* sidesteps both problems: every
 * output is a plain raster image that flows through the same bounded
 * sharp pipeline already proven out in image-extractor, so nothing new
 * has to be trusted on the output side.
 *
 * All decode/seek/render work happens in `ffmpeg`/`ffprobe` subprocesses
 * — a large C codebase and a real parser attack surface, same as any
 * media tool, but *contained*: invoked with argument arrays (never a
 * shell), no network flags ever passed, a hard timeout per call, and a
 * bounded stdout size. No filesystem access beyond a scoped temp
 * directory that's always cleaned up.
 *
 * config.output controls what's returned: 'buffers' (default, just the
 * encoded item bytes), 'html' (a single ready-to-embed fragment laying
 * out the filmstrip/visualizations + a metadata table), or 'both'.
 *
 * Return shape (always, never throws):
 *   { kind: 'video'|'audio', metadata: {...}, items: [...], html: string|null, error: null }
 *   { kind: null, metadata: null, items: null, html: null, error: { code, message } }
 */

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const sharp = require('sharp');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG = {
  // Generous, sane upper bound — ffprobe/ffmpeg here only ever read
  // headers and seek to specific points, never load the whole file into
  // memory, so this is a "reject absurd files" gate, not a memory-safety
  // necessity the way byte-size gates were for base64-embedded images.
  maxFileSizeBytes: 2 * 1024 * 1024 * 1024, // 2 GB

  // Percentages through the duration at which to grab a video frame.
  filmstripPercentages: [10, 30, 50, 70, 90],

  // Each filmstrip frame is boxed into this, same semantics as
  // image-extractor's maxDimension: fit inside, never upscale.
  frameMaxDimension: 512,

  // Waveform and spectrogram share these nominal dimensions, so they
  // stay visually aligned as a column when both are shown.
  waveformWidth: 1200,
  waveformHeight: 300,

  // ffmpeg's showspectrumpic color mode. 'fire' maps quiet -> dark/cool,
  // loud -> bright/warm, matching the traditional spectrogram convention
  // this module was asked to reproduce. Validated against a fixed enum
  // below rather than interpolated as free text, since it ends up inside
  // an ffmpeg filter-graph string.
  spectrogramColor: 'fire',

  // Embedded cover art (e.g. MP3/M4A ID3 APIC) is boxed into this.
  coverMaxDimension: 512,

  webpQuality: 80,
  withoutEnlargement: true,

  // Explicit decompression-bomb guard applied to every ffmpeg-produced
  // raster before re-encoding, same rationale and same default as
  // image-extractor.
  limitInputPixels: 100_000_000,

  // Hard per-subprocess timeout. A malformed or adversarial file
  // shouldn't be able to hang an ffmpeg/ffprobe call indefinitely.
  ffmpegTimeoutMs: 20_000,

  // Hard cap on a single subprocess's stdout, to bound worst-case memory
  // use regardless of what a call produces.
  ffmpegMaxBufferBytes: 100 * 1024 * 1024, // 100 MB

  output: 'buffers', // 'buffers' | 'html' | 'both'
};

const SPECTROGRAM_COLORS = new Set([
  'channel', 'intensity', 'rainbow', 'moreland', 'nebulae', 'fire', 'fiery', 'magma', 'green',
]);

// A small fixed vocabulary of error codes callers can branch on.
const ErrorCode = Object.freeze({
  TOO_LARGE: 'too-large',
  UNSUPPORTED_FORMAT: 'unsupported-format',
  FFMPEG_UNAVAILABLE: 'ffmpeg-unavailable',
  PARSE_ERROR: 'parse-error',
});

// Caller-asserted format -> temp file extension, so ffmpeg/ffprobe's own
// extension-based format detection has something sensible to work with.
// Deliberately curated to "typical local files" rather than ffmpeg's full
// nominal format zoo — same "trust but restrict which types we attempt"
// philosophy as text-extractor/image-extractor.
const ALLOWED_FORMATS = Object.freeze({
  // video containers
  mp4: 'mp4', mov: 'mov', m4v: 'm4v',
  mkv: 'mkv', webm: 'webm', avi: 'avi', flv: 'flv',
  ts: 'ts', m2ts: 'm2ts', mpegts: 'ts',
  wmv: 'wmv', asf: 'asf', ogv: 'ogv',
  // audio formats
  mp3: 'mp3', wav: 'wav', aiff: 'aiff', aif: 'aiff',
  flac: 'flac', m4a: 'm4a', aac: 'aac',
  ogg: 'ogg', oga: 'oga',
  wma: 'wma', ape: 'ape', wv: 'wv', wavpack: 'wv',
});

/** Normalizes caller-supplied format aliases onto our canonical names. */
function normalizeFileType(fileType) {
  const t = String(fileType || '').trim().toLowerCase();
  if (t === 'mpeg-ts') return 'mpegts';
  if (t === 'wavpack') return 'wv';
  return t;
}

// ---------------------------------------------------------------------------
// Pure helpers (no I/O, no injected libs)
// ---------------------------------------------------------------------------

function failure(code, message) {
  return { kind: null, metadata: null, items: null, html: null, error: { code, message } };
}

/** M:SS under an hour, H:MM:SS at/above. */
function formatTimecode(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

/**
 * Picks a finite, positive duration in seconds out of an ffprobe result,
 * trying the container-level duration first and falling back to any
 * stream that reports one. Returns null if nothing usable is found.
 */
function extractDurationSeconds(probeResult) {
  const candidates = [
    probeResult && probeResult.format && probeResult.format.duration,
    ...((probeResult && probeResult.streams) || []).map((s) => s.duration),
  ];
  for (const candidate of candidates) {
    const n = Number(candidate);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

/** Parses an ffprobe "num/den" frame-rate string into a plain number. */
function parseFrameRate(rateString) {
  if (!rateString || typeof rateString !== 'string') return null;
  const [num, den] = rateString.split('/').map(Number);
  if (!Number.isFinite(num)) return null;
  if (!Number.isFinite(den) || den === 0) return num;
  return num / den;
}

/**
 * Finds the real video stream (if any), the attached-picture stream
 * (cover art, if any — e.g. an MP3's embedded ID3 APIC frame, which
 * ffprobe reports as a video stream but flags via disposition), and the
 * audio stream (if any). Separating these matters: naively branching on
 * "does any video stream exist" would misclassify most music files with
 * embedded cover art as video.
 */
function classifyStreams(streams) {
  const list = streams || [];
  const videoStream = list.find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
  const attachedPicStream = list.find((s) => s.codec_type === 'video' && s.disposition && s.disposition.attached_pic);
  const audioStream = list.find((s) => s.codec_type === 'audio');
  return { videoStream, attachedPicStream, audioStream };
}

// ---------------------------------------------------------------------------
// Subprocess plumbing (isolated; binary paths and execFile injectable)
// ---------------------------------------------------------------------------

/** Resolves ffmpeg/ffprobe binary paths: injected deps first, then the -static packages. */
function resolveBinaryPaths(deps) {
  const ffmpegPath = deps.ffmpegPath || require('ffmpeg-static');
  const ffprobePath = deps.ffprobePath || require('ffprobe-static').path;
  return { ffmpegPath, ffprobePath };
}

/**
 * Runs a binary with an argument array (never a shell) and returns its
 * stdout as a Buffer. Enforces a timeout and a max buffer size; failures
 * (non-zero exit, timeout, spawn error) reject with a descriptive Error
 * rather than leaking raw execFile internals.
 */
function runProcess(binaryPath, args, { timeoutMs, maxBufferBytes }, execFileImpl = execFile) {
  return new Promise((resolve, reject) => {
    execFileImpl(
      binaryPath,
      args,
      { timeout: timeoutMs, maxBuffer: maxBufferBytes, encoding: 'buffer', windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          const stderrSnippet = stderr ? stderr.toString('utf-8').slice(0, 500) : '';
          const reason = err.killed ? 'timed out' : `exited with an error`;
          reject(new Error(`${path.basename(binaryPath)} ${reason}: ${err.message}${stderrSnippet ? ` | stderr: ${stderrSnippet}` : ''}`));
          return;
        }
        resolve(stdout);
      }
    );
  });
}

async function runFfprobe(filePath, ffprobePath, cfg, execFileImpl) {
  const args = ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath];
  const stdout = await runProcess(ffprobePath, args, { timeoutMs: cfg.ffmpegTimeoutMs, maxBufferBytes: cfg.ffmpegMaxBufferBytes }, execFileImpl);
  try {
    return JSON.parse(stdout.toString('utf-8'));
  } catch (err) {
    throw new Error(`Could not parse ffprobe output as JSON: ${err.message}`);
  }
}

async function extractFrameAt(filePath, ffmpegPath, timeSeconds, cfg, execFileImpl) {
  const args = ['-y', '-ss', String(timeSeconds), '-i', filePath, '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1'];
  return runProcess(ffmpegPath, args, { timeoutMs: cfg.ffmpegTimeoutMs, maxBufferBytes: cfg.ffmpegMaxBufferBytes }, execFileImpl);
}

async function extractStreamAsImage(filePath, ffmpegPath, streamIndex, cfg, execFileImpl) {
  // Decodes (rather than stream-copies) the given stream into a PNG frame.
  // Simpler and more robust than true copy semantics for what's here
  // always a single embedded still image, and the downstream sharp pass
  // re-encodes it anyway, so nothing is lost by decoding here.
  const args = ['-y', '-i', filePath, '-map', `0:${streamIndex}`, '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1'];
  return runProcess(ffmpegPath, args, { timeoutMs: cfg.ffmpegTimeoutMs, maxBufferBytes: cfg.ffmpegMaxBufferBytes }, execFileImpl);
}

async function renderWaveform(filePath, ffmpegPath, cfg, execFileImpl) {
  const filter = `showwavespic=s=${cfg.waveformWidth}x${cfg.waveformHeight}`;
  const args = ['-y', '-i', filePath, '-filter_complex', filter, '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1'];
  return runProcess(ffmpegPath, args, { timeoutMs: cfg.ffmpegTimeoutMs, maxBufferBytes: cfg.ffmpegMaxBufferBytes }, execFileImpl);
}

async function renderSpectrogram(filePath, ffmpegPath, cfg, execFileImpl) {
  const color = SPECTROGRAM_COLORS.has(cfg.spectrogramColor) ? cfg.spectrogramColor : 'fire';
  const filter = `showspectrumpic=s=${cfg.waveformWidth}x${cfg.waveformHeight}:legend=0:color=${color}`;
  const args = ['-y', '-i', filePath, '-lavfi', filter, '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1'];
  return runProcess(ffmpegPath, args, { timeoutMs: cfg.ffmpegTimeoutMs, maxBufferBytes: cfg.ffmpegMaxBufferBytes }, execFileImpl);
}

/** Bounds a raw raster buffer into a WebP thumbnail, same shape as image-extractor's rasterThumbnail. */
async function boundAndEncode(rawBuffer, cfg, sharpLib) {
  const { data, info } = await sharpLib(rawBuffer, { limitInputPixels: cfg.limitInputPixels })
    .resize(cfg.maxDimension, cfg.maxDimension, { fit: 'inside', withoutEnlargement: cfg.withoutEnlargement })
    .webp({ quality: cfg.webpQuality })
    .toBuffer({ resolveWithObject: true });
  return { thumbnail: data, format: 'webp', width: info.width, height: info.height };
}

/**
 * Re-encodes a raw raster buffer to WebP without any resize step. Used
 * for ffmpeg's own showwavespic/showspectrumpic output, which is already
 * rendered at exactly the requested dimensions — running that through
 * the same "fit inside a box" logic as video frames would be redundant
 * at best and, for non-square configured dimensions, could risk
 * unintended scaling. limitInputPixels is still applied, defensively,
 * even though we generated the input ourselves.
 */
async function encodeAsIs(rawBuffer, cfg, sharpLib) {
  const { data, info } = await sharpLib(rawBuffer, { limitInputPixels: cfg.limitInputPixels })
    .webp({ quality: cfg.webpQuality })
    .toBuffer({ resolveWithObject: true });
  return { thumbnail: data, format: 'webp', width: info.width, height: info.height };
}

// ---------------------------------------------------------------------------
// HTML assembly
// ---------------------------------------------------------------------------

/**
 * Escapes a value for safe embedding as HTML text content. Every current
 * `metadata` field (duration, format_name, codec_name, numeric fields) is
 * drawn from this module's own formatting or from ffmpeg/ffprobe's fixed
 * internal vocabularies, never from file-supplied free text (no ID3/tag
 * fields are read) — but `metadataTableHtml` has no way to enforce that
 * invariant on the caller's behalf, and it's one plausible future field
 * (e.g. a title/artist tag) away from being false. Escaping here costs
 * nothing today and removes that dependency entirely.
 */
function escapeHtmlText(str) {
  return String(str).replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case "'": return '&#39;';
      default: return ch;
    }
  });
}

function metadataTableHtml(metadata) {
  const rows = Object.entries(metadata)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => `<tr><th>${escapeHtmlText(k)}</th><td>${escapeHtmlText(v)}</td></tr>`)
    .join('');
  return `<table><tbody>${rows}</tbody></table>`;
}

function videoHtml(items, metadata) {
  const frames = items
    .map(
      (item) =>
        `<figure style="display:flex;flex-direction:column;align-items:center;gap:4px;margin:0;">` +
        `<img src="data:image/webp;base64,${item.thumbnail.toString('base64')}" width="${item.width}" height="${item.height}" decoding="async" style="display:block;">` +
        `<figcaption>${item.timecode}</figcaption>` +
        `</figure>`
    )
    .join('');
  return (
    '<div style="display:flex;align-items:center;justify-content:center;width:100%;height:100%;">' +
    '<div style="display:flex;flex-direction:column;align-items:center;gap:16px;">' +
    `<div style="display:flex;flex-wrap:wrap;justify-content:center;gap:16px;">${frames}</div>` +
    metadataTableHtml(metadata) +
    '</div>' +
    '</div>'
  );
}

function audioHtml(items, metadata) {
  const images = items
    .map(
      (item) =>
        `<img src="data:image/webp;base64,${item.thumbnail.toString('base64')}" width="${item.width}" height="${item.height}" decoding="async" ` +
        'style="display:block;width:auto;height:auto;max-width:100%;">'
    )
    .join('');
  return (
    '<div style="display:flex;align-items:center;justify-content:center;width:100%;height:100%;">' +
    '<div style="display:flex;flex-direction:column;align-items:center;gap:16px;">' +
    images +
    metadataTableHtml(metadata) +
    '</div>' +
    '</div>'
  );
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Produces a bounded set of preview images from video/audio bytes of an
 * asserted format: a filmstrip for video, or a waveform/spectrogram
 * (plus cover art, if present) for audio. Never throws.
 *
 * @param {Buffer} fileContent - the media file's raw bytes
 * @param {string} fileType - one of the keys in ALLOWED_FORMATS. Not
 *   validated or inferred beyond that allowlist — the caller is
 *   responsible for only ever asserting a format this module supports.
 * @param {object} [config] - overrides for DEFAULT_CONFIG
 * @param {object} [deps] - injectable dependencies: { sharp, ffmpegPath, ffprobePath, execFile, fsModule }
 * @returns {Promise<object>} see module-level doc comment for the return shape
 */
async function getMediaPreview(fileContent, fileType, config = {}, deps = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const sharpLib = deps.sharp || sharp;
  const execFileImpl = deps.execFile || execFile;
  const fsModule = deps.fsModule || fsp;

  let buffer;
  try {
    buffer = Buffer.isBuffer(fileContent) ? fileContent : Buffer.from(fileContent);
  } catch (err) {
    return failure(ErrorCode.PARSE_ERROR, `fileContent could not be read as a Buffer: ${err.message}`);
  }

  if (buffer.byteLength > cfg.maxFileSizeBytes) {
    return failure(ErrorCode.TOO_LARGE, `File is ${buffer.byteLength} bytes, exceeding the ${cfg.maxFileSizeBytes}-byte limit.`);
  }

  const type = normalizeFileType(fileType);
  const tempExtension = ALLOWED_FORMATS[type];
  if (!tempExtension) {
    return failure(ErrorCode.UNSUPPORTED_FORMAT, `Unsupported media format: "${fileType}".`);
  }

  let ffmpegPath;
  let ffprobePath;
  try {
    ({ ffmpegPath, ffprobePath } = resolveBinaryPaths(deps));
    if (!ffmpegPath || !ffprobePath || !fs.existsSync(ffmpegPath) || !fs.existsSync(ffprobePath)) {
      throw new Error('ffmpeg/ffprobe binaries were not found at the resolved paths');
    }
  } catch (err) {
    return failure(ErrorCode.FFMPEG_UNAVAILABLE, err.message);
  }

  const tempDir = await fsModule.mkdtemp(path.join(os.tmpdir(), 'media-extractor-'));
  const tempFile = path.join(tempDir, `input-${crypto.randomBytes(6).toString('hex')}.${tempExtension}`);

  try {
    await fsModule.writeFile(tempFile, buffer);

    let probeResult;
    try {
      probeResult = await runFfprobe(tempFile, ffprobePath, cfg, execFileImpl);
    } catch (err) {
      return failure(ErrorCode.PARSE_ERROR, err.message);
    }

    const duration = extractDurationSeconds(probeResult);
    if (duration === null) {
      return failure(ErrorCode.PARSE_ERROR, 'Could not determine a usable duration from the file.');
    }

    const { videoStream, attachedPicStream, audioStream } = classifyStreams(probeResult.streams);
    const formatName = probeResult.format && probeResult.format.format_name;

    if (videoStream) {
      const metadata = {
        kind: 'video',
        duration: formatTimecode(duration),
        format: formatName,
        width: videoStream.width,
        height: videoStream.height,
        fps: parseFrameRate(videoStream.avg_frame_rate) || parseFrameRate(videoStream.r_frame_rate),
        videoCodec: videoStream.codec_name,
        hasAudio: !!audioStream,
        audioCodec: audioStream ? audioStream.codec_name : null,
      };

      const items = [];
      for (const pct of cfg.filmstripPercentages) {
        // Seeking to exactly the reported duration frequently lands past
        // the last decodable frame (rounding/keyframe alignment), so
        // ffmpeg produces nothing at all for pct === 100. Clamping a
        // small epsilon short of the true end keeps the "100%" request
        // meaningful (a frame very near the end) without hitting that
        // failure mode; anything below the epsilon-adjusted ceiling is
        // unaffected.
        const rawT = (duration * pct) / 100;
        const t = Math.min(Math.max(rawT, 0), Math.max(duration - 0.1, 0));
        let rawFrame;
        try {
          rawFrame = await extractFrameAt(tempFile, ffmpegPath, t, cfg, execFileImpl);
        } catch (err) {
          return failure(ErrorCode.PARSE_ERROR, `Failed extracting frame at ${pct}%: ${err.message}`);
        }
        if (!rawFrame || rawFrame.length === 0) {
          return failure(ErrorCode.PARSE_ERROR, `No frame could be extracted at ${pct}% (t=${t.toFixed(2)}s).`);
        }
        const bounded = await boundAndEncode(rawFrame, { ...cfg, maxDimension: cfg.frameMaxDimension }, sharpLib);
        items.push({ label: `frame@${pct}%`, timecode: formatTimecode(t), ...bounded });
      }

      const html = cfg.output === 'buffers' ? null : videoHtml(items, metadata);
      const wantsBuffers = cfg.output !== 'html';
      return {
        kind: 'video',
        metadata,
        items: wantsBuffers ? items : items.map((i) => ({ ...i, thumbnail: null })),
        html,
        error: null,
      };
    }

    if (audioStream) {
      const metadata = {
        kind: 'audio',
        duration: formatTimecode(duration),
        format: formatName,
        sampleRate: audioStream.sample_rate ? Number(audioStream.sample_rate) : null,
        channels: audioStream.channels || null,
        audioCodec: audioStream.codec_name,
      };

      const items = [];

      if (attachedPicStream) {
        try {
          const rawCover = await extractStreamAsImage(tempFile, ffmpegPath, attachedPicStream.index, cfg, execFileImpl);
          const bounded = await boundAndEncode(rawCover, { ...cfg, maxDimension: cfg.coverMaxDimension }, sharpLib);
          items.push({ label: 'cover', ...bounded });
        } catch (_err) {
          // Cover art is optional and soft-failing: an absent or
          // unextractable embedded image is not an error for the audio
          // branch as a whole, just a missing item.
        }
      }

      let rawWaveform;
      let rawSpectrogram;
      try {
        rawWaveform = await renderWaveform(tempFile, ffmpegPath, cfg, execFileImpl);
        rawSpectrogram = await renderSpectrogram(tempFile, ffmpegPath, cfg, execFileImpl);
      } catch (err) {
        return failure(ErrorCode.PARSE_ERROR, `Failed rendering audio visualization: ${err.message}`);
      }

      const waveformBounded = await encodeAsIs(rawWaveform, cfg, sharpLib);
      items.push({ label: 'waveform', ...waveformBounded });
      const spectrogramBounded = await encodeAsIs(rawSpectrogram, cfg, sharpLib);
      items.push({ label: 'spectrogram', ...spectrogramBounded });

      const html = cfg.output === 'buffers' ? null : audioHtml(items, metadata);
      const wantsBuffers = cfg.output !== 'html';
      return {
        kind: 'audio',
        metadata,
        items: wantsBuffers ? items : items.map((i) => ({ ...i, thumbnail: null })),
        html,
        error: null,
      };
    }

    return failure(ErrorCode.PARSE_ERROR, 'No audio or video stream found in the file.');
  } catch (err) {
    return failure(ErrorCode.PARSE_ERROR, err && err.message ? err.message : String(err));
  } finally {
    await fsModule.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = {
  getMediaPreview,
  // exported for unit testing / composition
  normalizeFileType,
  formatTimecode,
  extractDurationSeconds,
  parseFrameRate,
  classifyStreams,
  resolveBinaryPaths,
  runProcess,
  boundAndEncode,
  encodeAsIs,
  escapeHtmlText,
  metadataTableHtml,
  videoHtml,
  audioHtml,
  failure,
  ErrorCode,
  ALLOWED_FORMATS,
  DEFAULT_CONFIG,
  SPECTROGRAM_COLORS,
};
