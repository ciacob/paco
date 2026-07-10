'use strict';

/**
 * paco/file-handler-detect.js
 *
 * The I/O side of the F4 file-handlers cascade. Everything here is async
 * and touches the filesystem; the actual cascade DECISION is made by the
 * pure function `resolveFileHandler` in paco/ui-state.js, which this module
 * supplies inputs to (detected MIME, text-vs-binary sniff, executable check).
 *
 * Kept separate from ui-state.js deliberately: that module must stay pure
 * and synchronous so it can be unit-tested without touching disk. This
 * module is the (thin, separately-tested) boundary where real I/O happens.
 */

const fs   = require('fs/promises');
const fsc  = require('fs').constants;
const path = require('path');

// ─── MIME detection ───────────────────────────────────────────────────────────

/**
 * Detect a file's MIME type via magic-number signature (file-type@16, the
 * last CommonJS-compatible release — see package.json for why this is
 * pinned exactly rather than left on a caret range).
 *
 * No longer has any say in text-vs-binary (see detectIsTextual() below,
 * which is the sole authority on that now) — this exists purely to
 * classify what KIND of binary something is, once it's already been
 * determined to be one. It used to double as the text-vs-binary signal
 * too (mime found → assume binary), but that assumption broke for MIME
 * types that are themselves textual — confirmed concretely with SVG:
 * file-type only recognises it via an <?xml ...?> prolog, which valid,
 * common SVG (especially hand-authored/icon-library files) routinely
 * omits, so file-type's opinion on the SAME format flipped depending on
 * a detail invisible in the rendered result. Decoupling this from
 * isTextual entirely closes that whole class of inconsistency, not just
 * the one SVG instance of it.
 *
 * @param {string} filePath
 * @returns {Promise<string|null>} MIME type string, or null if no match
 */
async function detectMime(filePath) {
  try {
    const fileType = require('file-type');
    const result = await fileType.fromFile(filePath);
    return (result && result.mime) || null;
  } catch (_) {
    // Unreadable, too small to sniff, or the module itself failed to load —
    // treat as "no match" rather than throwing; the cascade has a fallback
    // for exactly this case.
    return null;
  }
}

// ─── Text-vs-binary content sniff ────────────────────────────────────────────

// Bytes considered when sniffing — enough to catch a NUL byte or a run of
// control characters near the start without reading the whole file.
const SNIFF_SAMPLE_BYTES = 8192;

// A NUL byte essentially never occurs in genuine text content but is common
// in binary formats file-type doesn't recognise (or only partially does).
// This single check, plus a tolerance for the handful of legitimate control
// characters real text uses (tab, newline, carriage return, form feed,
// escape — the last for ANSI-coloured log files etc.), is the same basic
// heuristic used by `file(1)`, Git's binary-file detection, and most editors.
const ALLOWED_CONTROL_CODES = new Set([
  0x09, // tab
  0x0a, // line feed
  0x0d, // carriage return
  0x0c, // form feed
  0x1b, // escape
]);

/**
 * Sniff whether a file's leading bytes look like text or binary content —
 * the SOLE authority on text-vs-binary now (see detectMime()'s own comment
 * for why that used to also have a say, and why that stopped being
 * reliable). Always run, never conditionally skipped based on what
 * detectMime() finds.
 *
 * Deliberately trusted over MIME sniffing for this specific decision:
 * genuinely binary content (compressed data, image/audio payloads, etc.)
 * has a vanishingly small chance of containing zero NUL bytes across an
 * 8KB sample — for effectively-random binary bytes, something on the
 * order of 10^-14 — confirmed empirically against real JPEG, PNG, ZIP,
 * and DOCX files during this change, all correctly identified as binary
 * by this check alone, with no help from MIME detection at all. Where
 * this heuristic COULD in principle be wrong (a very small file, or an
 * unusually long text preamble before any binary payload begins within
 * the sample window) the failure mode is mild — content displays as
 * garbled text rather than a hex dump, not a safety issue, since the
 * generic-text renderer's own escaping is already proven safe for
 * arbitrary bytes including NULs — whereas the OLD failure mode (a
 * MIME match forcing isTextual:false for something that was actually
 * text) was a genuine loss of functionality, not just a cosmetic one.
 *
 * @param {string} filePath
 * @returns {Promise<boolean>} true if the sampled content looks textual
 */
async function detectIsTextual(filePath) {
  let handle;
  try {
    handle = await fs.open(filePath, 'r');
    const buffer = Buffer.alloc(SNIFF_SAMPLE_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, SNIFF_SAMPLE_BYTES, 0);

    if (bytesRead === 0) return true; // empty file — treat as text, harmless either way

    for (let i = 0; i < bytesRead; i++) {
      const byte = buffer[i];
      if (byte === 0x00) return false; // NUL byte — essentially never in real text
      const isPrintable   = byte >= 0x20 && byte < 0x7f;
      const isHighUtf8Byte = byte >= 0x80; // allow UTF-8 continuation/lead bytes
      const isAllowedCtrl  = ALLOWED_CONTROL_CODES.has(byte);
      if (!isPrintable && !isHighUtf8Byte && !isAllowedCtrl) return false;
    }
    return true;
  } catch (_) {
    // Unreadable — caller's cascade will fall through to "other" via a
    // null-ish classification; returning false here is the safer default
    // (treat the unknown as non-text rather than assuming text).
    return false;
  } finally {
    if (handle) { try { await handle.close(); } catch (_) {} }
  }
}

// ─── Executable check ─────────────────────────────────────────────────────────

/**
 * Default Windows executable extensions, used only if PATHEXT is somehow
 * unset — mirrors cmd.exe's own built-in default.
 */
const DEFAULT_PATHEXT = ['.COM', '.EXE', '.BAT', '.CMD'];

/**
 * Determine whether a file should be treated as executable, for the
 * purpose of the F4 cascade's executable safety gate (see resolveFileHandler
 * in ui-state.js — this feeds its `isExecutable` parameter).
 *
 * POSIX (macOS/Linux): the real executable-permission-bit check via
 * fs.access(X_OK). This is the authoritative mechanism — it reflects
 * whatever chmod state the file actually has for the current user.
 *
 * Windows: there is no permission bit to check (fs.constants.X_OK behaves
 * like F_OK there — see Node's own docs). Windows' notion of "executable"
 * is purely extension-based, governed by the PATHEXT environment variable,
 * so we read that and match case-insensitively against it.
 *
 * @param {string} filePath
 * @returns {Promise<boolean>}
 */
async function detectIsExecutable(filePath) {
  if (process.platform === 'win32') {
    const pathExt = (process.env.PATHEXT || DEFAULT_PATHEXT.join(';'))
      .split(';')
      .filter(Boolean)
      .map(e => e.toUpperCase());
    const ext = path.extname(filePath).toUpperCase();
    return pathExt.includes(ext);
  }

  try {
    await fs.access(filePath, fsc.X_OK);
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = { detectMime, detectIsTextual, detectIsExecutable };
