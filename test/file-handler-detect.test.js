'use strict';

/**
 * test/file-handler-detect.test.js
 *
 * Tests for paco/file-handler-detect.js, the I/O layer behind the F4
 * file-handlers cascade. Uses real temp files with deliberately constructed
 * content/permissions, since this module's entire job is touching disk.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('fs');
const fsp  = require('fs/promises');
const path = require('path');
const os   = require('os');
const detect = require('../paco/file-handler-detect');

let tmpDir;

before(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'paco-handler-detect-'));
});

after(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

// ─── detectMime ───────────────────────────────────────────────────────────────

describe('detectMime', () => {
  test('recognises a real PNG signature', async () => {
    const p = path.join(tmpDir, 'real.png');
    const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await fsp.writeFile(p, Buffer.concat([pngSignature, Buffer.alloc(20)]));
    const mime = await detect.detectMime(p);
    assert.equal(mime, 'image/png');
  });

  test('returns null for a plain text file (no binary signature)', async () => {
    const p = path.join(tmpDir, 'plain.txt');
    await fsp.writeFile(p, 'just some text content here\n');
    const mime = await detect.detectMime(p);
    assert.equal(mime, null);
  });

  test('returns null for a non-existent file rather than throwing', async () => {
    const mime = await detect.detectMime(path.join(tmpDir, 'ghost.bin'));
    assert.equal(mime, null);
  });

  test('returns null for an empty file', async () => {
    const p = path.join(tmpDir, 'empty.bin');
    await fsp.writeFile(p, '');
    const mime = await detect.detectMime(p);
    assert.equal(mime, null);
  });
});

// ─── detectIsTextual ──────────────────────────────────────────────────────────

describe('detectIsTextual', () => {
  test('plain ASCII text → true', async () => {
    const p = path.join(tmpDir, 'ascii.txt');
    await fsp.writeFile(p, 'Hello, world!\nLine two.\n');
    assert.equal(await detect.detectIsTextual(p), true);
  });

  test('UTF-8 text with multi-byte characters → true', async () => {
    const p = path.join(tmpDir, 'utf8.txt');
    await fsp.writeFile(p, 'Café, naïve, façade — 日本語', 'utf8');
    assert.equal(await detect.detectIsTextual(p), true);
  });

  test('text with common control characters (tab, CRLF) → true', async () => {
    const p = path.join(tmpDir, 'controls.txt');
    await fsp.writeFile(p, 'col1\tcol2\r\nval1\tval2\r\n');
    assert.equal(await detect.detectIsTextual(p), true);
  });

  test('content containing a NUL byte → false', async () => {
    const p = path.join(tmpDir, 'has-nul.bin');
    await fsp.writeFile(p, Buffer.from([0x48, 0x65, 0x00, 0x6c, 0x6c, 0x6f]));
    assert.equal(await detect.detectIsTextual(p), false);
  });

  test('content with disallowed control bytes → false', async () => {
    const p = path.join(tmpDir, 'weird-controls.bin');
    // 0x01-0x08 are control codes not in the allowed set (tab/LF/CR/FF/ESC)
    await fsp.writeFile(p, Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05]));
    assert.equal(await detect.detectIsTextual(p), false);
  });

  test('empty file → true (harmless default)', async () => {
    const p = path.join(tmpDir, 'truly-empty.txt');
    await fsp.writeFile(p, '');
    assert.equal(await detect.detectIsTextual(p), true);
  });

  test('non-existent file → false (safer default than assuming text)', async () => {
    const result = await detect.detectIsTextual(path.join(tmpDir, 'ghost2.txt'));
    assert.equal(result, false);
  });
});

// ─── detectIsExecutable ───────────────────────────────────────────────────────

describe('detectIsExecutable', () => {
  test('a file with the executable bit set is detected as executable (POSIX only)',
    { skip: process.platform === 'win32' }, async () => {
      const p = path.join(tmpDir, 'script.sh');
      await fsp.writeFile(p, '#!/bin/sh\necho hi\n');
      await fsp.chmod(p, 0o755);
      assert.equal(await detect.detectIsExecutable(p), true);
    });

  test('a file without the executable bit is NOT detected as executable (POSIX only)',
    { skip: process.platform === 'win32' }, async () => {
      const p = path.join(tmpDir, 'data.txt');
      await fsp.writeFile(p, 'just data');
      await fsp.chmod(p, 0o644);
      assert.equal(await detect.detectIsExecutable(p), false);
    });

  test('a .exe-extensioned file is detected as executable (Windows only)',
    { skip: process.platform !== 'win32' }, async () => {
      const p = path.join(tmpDir, 'setup.exe');
      await fsp.writeFile(p, 'not a real exe, extension is what matters here');
      assert.equal(await detect.detectIsExecutable(p), true);
    });

  test('a .txt-extensioned file is NOT detected as executable (Windows only)',
    { skip: process.platform !== 'win32' }, async () => {
      const p = path.join(tmpDir, 'notes.txt');
      await fsp.writeFile(p, 'just notes');
      assert.equal(await detect.detectIsExecutable(p), false);
    });

  test('non-existent path does not throw, returns false', async () => {
    const result = await detect.detectIsExecutable(path.join(tmpDir, 'ghost3.bin'));
    assert.equal(result, false);
  });
});
