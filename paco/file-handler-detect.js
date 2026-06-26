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
 * file-type is binary-signature-only: it returns undefined for text-based
 * formats by design (there is no fixed byte signature for "this is text"),
 * not as a bug or a gap we're working around — see detectIsTextual() below
 * for how that case is actually told apart from "this is some other binary
 * we don't recognise".
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
 * Sniff whether a file's leading bytes look like text or binary content.
 * Only meaningful — and only ever consulted — when detectMime() has already
 * returned null (file-type found no recognised binary signature).
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
