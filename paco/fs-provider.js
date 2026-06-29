'use strict';

/**
 * paco/fs-provider.js
 *
 * The single abstraction layer for all filesystem I/O in PACO.
 * Tasks NEVER call fs directly — they call these functions instead.
 *
 * This keeps all platform quirks, permission handling, and future
 * provider-swapping (e.g. SFTP, zip-as-folder) contained here.
 *
 * All functions return plain, JSON-serialisable values so task results
 * can be sent over IPC/WS without transformation.
 */

const fs    = require('fs');
const fsp   = require('fs/promises');
const path  = require('path');
const os    = require('os');

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} FsEntry
 * @property {string}  name        — filename only
 * @property {string}  path        — absolute path
 * @property {'dir'|'file'|'symlink'|'other'} type
 * @property {number}  size        — bytes (0 for dirs)
 * @property {number}  mtime       — ms since epoch
 * @property {number}  created     — ms since epoch (birthtime)
 * @property {boolean} hidden      — dot-file on unix, or Windows hidden attr
 * @property {boolean} readable
 * @property {boolean} writable
 * @property {string|null} linkTarget — resolved target if symlink, else null
 */

// ─── Directory listing ────────────────────────────────────────────────────────

/**
 * List the contents of a directory.
 *
 * @param {string}  dirPath
 * @param {object}  [opts]
 * @param {boolean} [opts.showHidden=false]
 * @param {string}  [opts.sortBy='name']    'name'|'size'|'mtime'|'type'
 * @param {boolean} [opts.sortAsc=true]
 * @returns {Promise<FsEntry[]>}
 */
async function list(dirPath, opts = {}) {
  const {
    showHidden = false,
    sortBy     = 'name',
    sortAsc    = true,
  } = opts;

  const names = await fsp.readdir(dirPath);
  const entries = [];

  for (const name of names) {
    const hidden = name.startsWith('.') || await _isWindowsHidden(path.join(dirPath, name));
    if (!showHidden && hidden) continue;

    const entry = await _stat(path.join(dirPath, name), name);
    if (entry) entries.push(entry);
  }

  return _sort(entries, sortBy, sortAsc);
}

/**
 * Build an FsEntry for a single path.
 * Returns null if the path cannot be stated (race condition / permission).
 *
 * @param {string} fullPath
 * @param {string} [nameOverride]
 * @returns {Promise<FsEntry|null>}
 */
async function stat(fullPath, nameOverride) {
  return _stat(fullPath, nameOverride || path.basename(fullPath));
}

async function _stat(fullPath, name) {
  try {
    const lstat = await fsp.lstat(fullPath);
    let type, size = 0, linkTarget = null;

    if (lstat.isSymbolicLink()) {
      type = 'symlink';
      try {
        linkTarget = await fsp.realpath(fullPath);
        const real = await fsp.stat(fullPath);
        size = real.size;
      } catch (_) {
        // broken symlink — still include it
      }
    } else if (lstat.isDirectory()) {
      type = 'dir';
    } else if (lstat.isFile()) {
      type = 'file';
      size = lstat.size;
    } else {
      type = 'other';
    }

    // Basic read/write check via access flags — best-effort
    let readable = false, writable = false;
    try { await fsp.access(fullPath, fs.constants.R_OK); readable = true; } catch (_) {}
    try { await fsp.access(fullPath, fs.constants.W_OK); writable = true; } catch (_) {}

    const hidden = name.startsWith('.') || await _isWindowsHidden(fullPath);

    return {
      name,
      path:       fullPath,
      type,
      size,
      mtime:      lstat.mtimeMs,
      created:    lstat.birthtimeMs,
      hidden,
      readable,
      writable,
      linkTarget,
    };
  } catch (_) {
    return null;
  }
}

/**
 * Richer, single-item stat used only by the Viewer panel's single-selection
 * table — NOT called during normal directory listing, since resolving an
 * owner name and reading Windows attributes is comparatively expensive and
 * only ever needed for the one item currently selected, not for every row
 * in a potentially large directory.
 *
 * @param {string} fullPath
 * @returns {Promise<object|null>} null if the path can't be stated.
 *   On POSIX: { owner: string|null, mode: number, octal: string }
 *   On Windows: { isReadOnly: boolean, isExecutable: boolean }
 *   (owner/mode/octal are always present but null/0 on Windows where they
 *   carry no meaningful information; isReadOnly/isExecutable are always
 *   present but isReadOnly is meaningless on POSIX, which has the real
 *   octal permissions to show instead.)
 */
async function statDetails(fullPath) {
  try {
    const lstat = await fsp.lstat(fullPath);
    const mode  = lstat.mode & 0o777;
    const octal = mode.toString(8).padStart(3, '0');

    let owner = null;
    if (process.platform !== 'win32') {
      owner = await _resolveOwnerName(lstat.uid);
    }

    let isReadOnly = false;
    if (process.platform === 'win32') {
      const flags = await _windowsAttribFlags(fullPath);
      isReadOnly = flags.readOnly;
    }

    const isExecutable = await _detectExecutable(fullPath);

    return { owner, mode, octal, isReadOnly, isExecutable };
  } catch (_) {
    return null;
  }
}

/**
 * Resolve a POSIX uid to a username via the `id` command — Node has no
 * built-in getpwuid equivalent (a known, longstanding gap; see
 * nodejs/node#24488 and #37517). Falls back to the raw numeric uid as a
 * string if resolution fails (unknown uid, command unavailable, etc.).
 *
 * @param {number} uid
 * @returns {Promise<string>}
 */
async function _resolveOwnerName(uid) {
  try {
    const { execFile } = require('child_process');
    const { promisify } = require('util');
    const execFileAsync = promisify(execFile);
    const { stdout } = await execFileAsync('id', ['-un', String(uid)]);
    return stdout.trim() || String(uid);
  } catch (_) {
    return String(uid);
  }
}

/**
 * Executable check, reusing the exact same logic the F4 file-handlers
 * cascade already uses for its executable safety gate — see
 * paco/file-handler-detect.js#detectIsExecutable for the full rationale
 * (POSIX: real X_OK permission bit; Windows: PATHEXT extension match).
 *
 * @param {string} fullPath
 * @returns {Promise<boolean>}
 */
async function _detectExecutable(fullPath) {
  try {
    const detect = require('./file-handler-detect');
    return await detect.detectIsExecutable(fullPath);
  } catch (_) {
    return false;
  }
}

async function _isWindowsHidden(fullPath) {
  const flags = await _windowsAttribFlags(fullPath);
  return flags.hidden;
}

/**
 * Read Windows file attributes (hidden, read-only) via the `attrib`
 * command in a single call — used both by _isWindowsHidden (per-row, list
 * context) and by statDetails (single-item, Viewer context) so the
 * attrib-output parsing logic lives in exactly one place.
 *
 * @param {string} fullPath
 * @returns {Promise<{hidden: boolean, readOnly: boolean}>}
 */
async function _windowsAttribFlags(fullPath) {
  if (process.platform !== 'win32') return { hidden: false, readOnly: false };
  try {
    const { execFile } = require('child_process');
    const { promisify } = require('util');
    const execFileAsync = promisify(execFile);
    const { stdout } = await execFileAsync('attrib', [fullPath]);
    // attrib's output is fixed-width attribute letters (A/R/H/S/...) in the
    // first ~8 columns, followed by the path — checking the first couple
    // of characters for each flag matches the existing _isWindowsHidden
    // behaviour exactly, just extended to also check for 'R' (read-only).
    const prefix = stdout.slice(0, 8);
    return {
      hidden:   prefix.includes('H'),
      readOnly: prefix.includes('R'),
    };
  } catch (_) {
    return { hidden: false, readOnly: false };
  }
}

function _sort(entries, sortBy, sortAsc) {
  // Dirs always first, then files
  const dirs  = entries.filter(e => e.type === 'dir');
  const files = entries.filter(e => e.type !== 'dir');

  const comparator = (a, b) => {
    let v = 0;
    if (sortBy === 'name')  v = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    if (sortBy === 'size')  v = a.size - b.size;
    if (sortBy === 'mtime') v = a.mtime - b.mtime;
    if (sortBy === 'type')  v = a.name.split('.').pop().localeCompare(b.name.split('.').pop());
    return sortAsc ? v : -v;
  };

  return [...dirs.sort(comparator), ...files.sort(comparator)];
}

// ─── Navigation helpers ───────────────────────────────────────────────────────

/**
 * Return the parent directory, clamped at the filesystem root.
 */
function parentDir(dirPath) {
  const parent = path.dirname(dirPath);
  return parent === dirPath ? dirPath : parent; // already at root
}

/**
 * List available volumes/drives.
 * On Unix returns ['/']. On Windows enumerates drive letters.
 * @returns {Promise<string[]>}
 */
async function listVolumes() {
  if (process.platform === 'win32') {
    return _windowsDrives();
  }
  // macOS: /Volumes, Linux: just /
  if (process.platform === 'darwin') {
    try {
      const vols = await fsp.readdir('/Volumes');
      return ['/', ...vols.map(v => `/Volumes/${v}`)];
    } catch (_) {
      return ['/'];
    }
  }
  return ['/'];
}

async function _windowsDrives() {
  const { execFile } = require('child_process');
  const { promisify } = require('util');
  try {
    const execFileAsync = promisify(execFile);
    const { stdout } = await execFileAsync('wmic', ['logicaldisk', 'get', 'name']);
    return stdout
      .split('\n')
      .map(l => l.trim())
      .filter(l => /^[A-Z]:$/.test(l))
      .map(l => l + '\\');
  } catch (_) {
    return ['C:\\'];
  }
}

// ─── File operations ──────────────────────────────────────────────────────────

/**
 * Copy src to dst, calling onProgress(bytesDone, totalBytes) periodically.
 * dst should be the full destination path (not just a directory).
 *
 * @param {string}   src
 * @param {string}   dst
 * @param {Function} [onProgress]
 * @returns {Promise<void>}
 */
async function copy(src, dst, onProgress) {
  const srcStat = await fsp.stat(src);

  if (srcStat.isDirectory()) {
    return _copyDir(src, dst, onProgress);
  }
  return _copyFile(src, dst, srcStat.size, onProgress);
}

async function _copyFile(src, dst, totalSize, onProgress) {
  await fsp.mkdir(path.dirname(dst), { recursive: true });

  return new Promise((resolve, reject) => {
    let done = 0;
    const rd = fs.createReadStream(src);
    const wr = fs.createWriteStream(dst);

    rd.on('data', chunk => {
      done += chunk.length;
      if (onProgress && totalSize > 0) {
        onProgress(done, totalSize);
      }
    });
    rd.on('error', reject);
    wr.on('error', reject);
    wr.on('finish', resolve);
    rd.pipe(wr);
  });
}

async function _copyDir(src, dst, onProgress) {
  await fsp.mkdir(dst, { recursive: true });
  const entries = await fsp.readdir(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const dstPath = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      await _copyDir(srcPath, dstPath, onProgress);
    } else {
      const s = await fsp.stat(srcPath);
      await _copyFile(srcPath, dstPath, s.size, onProgress);
    }
  }
}

/**
 * Move src to dst. Tries rename first (fast, same-volume), falls back to
 * copy+delete across volumes.
 */
async function move(src, dst, onProgress) {
  try {
    await fsp.rename(src, dst);
  } catch (err) {
    if (err.code === 'EXDEV') {
      // Cross-device move
      await copy(src, dst, onProgress);
      await remove(src);
    } else {
      throw err;
    }
  }
}

/**
 * Delete a file or directory (recursive).
 */
async function remove(targetPath) {
  await fsp.rm(targetPath, { recursive: true, force: true });
}

/**
 * Create a directory (and any missing parents).
 */
async function mkdir(dirPath) {
  await fsp.mkdir(dirPath, { recursive: true });
}

/**
 * Create a new, empty (0-byte) file at the given path.
 *
 * Uses the 'wx' flag, which fails atomically at the OS level if anything
 * already exists there — file, directory, or otherwise. This is a stronger
 * guarantee than a separate stat-then-write (which would have a race
 * window between the check and the write); callers should still do an
 * explicit existence check first for a clean, humanized error message, but
 * this flag is the real safety net underneath that.
 *
 * @param {string} filePath
 */
async function createFile(filePath) {
  const handle = await fsp.open(filePath, 'wx');
  await handle.close();
}

/**
 * Rename (or move within the same directory).
 */
async function rename(oldPath, newPath) {
  await fsp.rename(oldPath, newPath);
}

// ─── Path utilities ───────────────────────────────────────────────────────────

/**
 * Split a path into breadcrumb segments.
 * e.g. '/home/user/docs' → [
 *   { label: '/',    path: '/' },
 *   { label: 'home', path: '/home' },
 *   { label: 'user', path: '/home/user' },
 *   { label: 'docs', path: '/home/user/docs' },
 * ]
 */
function breadcrumbs(dirPath) {
  const parts  = dirPath.split(path.sep).filter(Boolean);
  const crumbs = [];

  if (process.platform === 'win32') {
    // First part is 'C:' etc.
    let acc = parts[0] + '\\';
    crumbs.push({ label: acc, path: acc });
    for (let i = 1; i < parts.length; i++) {
      acc = path.join(acc, parts[i]);
      crumbs.push({ label: parts[i], path: acc });
    }
  } else {
    crumbs.push({ label: '/', path: '/' });
    let acc = '/';
    for (const part of parts) {
      acc = path.join(acc, part);
      crumbs.push({ label: part, path: acc });
    }
  }

  return crumbs;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  list,
  stat,
  statDetails,
  parentDir,
  listVolumes,
  copy,
  move,
  remove,
  mkdir,
  createFile,
  rename,
  breadcrumbs,
};
