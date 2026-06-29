'use strict';

/**
 * worker/calc-size-child.js
 *
 * Standalone script, run as its own child process via child_process.fork()
 * from worker/tasks/calc-size.js — NOT a worker/tasks/*.js task itself (it
 * has no TaskShell ctx, no progress reporting, nothing). Its only job:
 * recursively sum the size of the given paths, then report the total (or
 * an error) back to its parent via IPC, and exit.
 *
 * Deliberately reports NO intermediate progress — per the agreed design,
 * the UI shows a spinner while this runs and a result when it's done,
 * nothing in between.
 *
 * Receives its target paths via process.argv (JSON-encoded array), since
 * that's simpler than IPC round-tripping for a single, one-shot input that
 * never changes after spawn.
 *
 * Sends exactly one message before exiting:
 *   { ok: true,  bytes: number }
 *   { ok: false, error: string }
 */

const fs   = require('fs');
const path = require('path');

async function sizeOf(targetPath) {
  let stat;
  try {
    stat = await fs.promises.lstat(targetPath);
  } catch (_) {
    return 0; // vanished mid-walk (deleted, unmounted, etc.) — just skip it
  }

  if (stat.isSymbolicLink()) {
    // Don't follow symlinks — count only the link itself, never recurse
    // through it (avoids cycles and double-counting shared targets).
    return stat.size;
  }

  if (!stat.isDirectory()) {
    return stat.size;
  }

  let total = 0;
  let children;
  try {
    children = await fs.promises.readdir(targetPath);
  } catch (_) {
    return 0; // permission denied or similar — skip, don't fail the whole calc
  }

  for (const child of children) {
    total += await sizeOf(path.join(targetPath, child));
  }
  return total;
}

async function main() {
  const rawArg = process.argv[2];
  let targetPaths;
  try {
    targetPaths = JSON.parse(rawArg);
    if (!Array.isArray(targetPaths)) throw new Error('not an array');
  } catch (_) {
    if (process.send) process.send({ ok: false, error: 'Invalid arguments to calc-size-child' });
    process.exit(1);
    return;
  }

  try {
    let bytes = 0;
    for (const p of targetPaths) {
      bytes += await sizeOf(p);
    }
    if (process.send) process.send({ ok: true, bytes });
  } catch (err) {
    if (process.send) process.send({ ok: false, error: err.message });
  }
  process.exit(0);
}

main();
