'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs/promises');
const path = require('node:path');

const execFileAsync = promisify(execFile);

const SYSTEM_FFMPEG = process.env.MEDIA_EXTRACTOR_TEST_FFMPEG || '/usr/bin/ffmpeg';
const SYSTEM_FFPROBE = process.env.MEDIA_EXTRACTOR_TEST_FFPROBE || '/usr/bin/ffprobe';

/** deps object pointing at the system ffmpeg/ffprobe, for injecting into getMediaPreview in tests. */
const testDeps = { ffmpegPath: SYSTEM_FFMPEG, ffprobePath: SYSTEM_FFPROBE };

async function runFfmpeg(args) {
  await execFileAsync(SYSTEM_FFMPEG, ['-y', ...args], { maxBuffer: 50 * 1024 * 1024 });
}

/** A short silent-video-free test-pattern video with a tone, muxed into an MP4. */
async function buildVideoWithAudio(outPath, { width = 320, height = 240, fps = 10, durationSec = 6 } = {}) {
  await runFfmpeg([
    '-f', 'lavfi', '-i', `testsrc=size=${width}x${height}:rate=${fps}`,
    '-f', 'lavfi', '-i', 'sine=frequency=440',
    '-t', String(durationSec),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest',
    outPath,
  ]);
  return fs.readFile(outPath);
}

/** A short video with no audio stream at all. */
async function buildSilentVideo(outPath, { width = 320, height = 240, fps = 10, durationSec = 3 } = {}) {
  await runFfmpeg(['-f', 'lavfi', '-i', `testsrc=size=${width}x${height}:rate=${fps}`, '-t', String(durationSec), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', outPath]);
  return fs.readFile(outPath);
}

/** A short WebM (VP9/Opus) video, to prove multi-container support. */
async function buildWebm(outPath, { width = 320, height = 240, durationSec = 3 } = {}) {
  await runFfmpeg([
    '-f', 'lavfi', '-i', `testsrc=size=${width}x${height}:rate=10`,
    '-f', 'lavfi', '-i', 'sine=frequency=220',
    '-t', String(durationSec),
    '-c:v', 'libvpx-vp9', '-c:a', 'libopus', '-shortest',
    outPath,
  ]);
  return fs.readFile(outPath);
}

/** A short plain MP3 tone with no cover art. */
async function buildAudio(outPath, { durationSec = 5, frequency = 440 } = {}) {
  await runFfmpeg(['-f', 'lavfi', '-i', `sine=frequency=${frequency}:duration=${durationSec}`, outPath]);
  return fs.readFile(outPath);
}

/** An MP3 with an embedded (ID3 APIC) cover image. */
async function buildAudioWithCover(outPath, tmpDir, { durationSec = 5, coverSize = 200 } = {}) {
  const audioPath = path.join(tmpDir, 'cover-audio-src.mp3');
  const coverPath = path.join(tmpDir, 'cover-src.jpg');
  await runFfmpeg(['-f', 'lavfi', '-i', `sine=frequency=440:duration=${durationSec}`, audioPath]);
  await runFfmpeg(['-f', 'lavfi', '-i', `color=c=blue:s=${coverSize}x${coverSize}`, '-frames:v', '1', '-update', '1', coverPath]);
  await runFfmpeg(['-i', audioPath, '-i', coverPath, '-map', '0:a', '-map', '1:v', '-c', 'copy', '-id3v2_version', '3', outPath]);
  return fs.readFile(outPath);
}

module.exports = {
  testDeps,
  buildVideoWithAudio,
  buildSilentVideo,
  buildWebm,
  buildAudio,
  buildAudioWithCover,
};
