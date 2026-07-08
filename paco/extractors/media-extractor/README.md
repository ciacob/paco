# media-extractor

> **Status:** design notes, implementation, and tests for one of PACO's
> F3-viewer extractors (paired with a sandboxed-iframe architecture doc
> discussed alongside these, not yet checked into this repo). Not yet
> wired into `worker/tasks` — this folder is documentation-in-place
> pending that integration. It has no `package.json`/`node_modules` of
> its own: `ffmpeg-static`, `ffprobe-static`, and `sharp` are declared
> in PACO's root `package.json` and resolve from the root
> `node_modules` — `sharp` in particular is shared with, and
> deduplicated against, `image-extractor`'s own use of it.

Turns video/audio bytes of an asserted format into a small, bounded set
of **static preview images** — never full playback. No filesystem
access beyond a scoped temp directory that's always cleaned up, no
network access ever, no format sniffing (the caller asserts the type,
same contract as `text-extractor`/`image-extractor`).

- **video** → a filmstrip: one frame at each of several percentages
  through the duration (default 10/30/50/70/90%)
- **audio** → a waveform and a spectrogram, plus embedded cover art if
  present (e.g. an MP3's ID3 APIC frame)

## Why static images, not playback

This module exists because, unlike images, there's no cheap way to
"bound and re-encode" full audio/video the way `sharp` let
`image-extractor` cap dimensions at negligible cost — and unlike
documents, there's no realistic target runtime whose native codec
support can be trusted without per-deployment verification (a fixed
Chrome-for-Testing/WKWebView pairing turned out to have real,
non-obvious codec gaps — Chrome for Testing is an *unbranded* Chromium
build and very likely lacks H.264/AAC decode the way official Google
Chrome has it, and WebKitGTK's codec support depends on which
GStreamer plugins happen to be installed on a given machine, not a
fixed property of the app). Extracting a small, fixed number of static
images sidesteps both problems: every output is a plain raster image
that flows through the same bounded `sharp` pipeline already proven
out in `image-extractor` — nothing new has to be trusted on the output
side, and no playback-capability assumption has to be made about the
runtime at all.

## Why ffmpeg, and how the risk is contained

`ffmpeg`/`ffprobe` are a large C codebase and a real parser attack
surface — that doesn't go away just because we're not asking a browser
to decode the file. What changes is *containment*: every call runs as
a subprocess invoked with an **argument array, never a shell** (so
crafted content can't break out via shell metacharacters), with **no
network flags ever passed** (no SSRF surface — every ffmpeg invocation
only ever touches a local temp file we wrote ourselves), a **hard
timeout** per call, and a **bounded stdout size**. A malformed or
adversarial file can make one `ffmpeg`/`ffprobe` call fail or time
out; it can't make this module hang, leak file descriptors, or grow
memory unboundedly.

## Supported formats

Deliberately curated to "typical local files," not ffmpeg's full
nominal format zoo — same "trust but restrict which types we attempt"
philosophy as `text-extractor`/`image-extractor`. Anything else is an
`unsupported-format` error.

- **Video containers:** `mp4`, `mov`, `m4v`, `mkv`, `webm`, `avi`,
  `flv`, `ts`/`m2ts`/`mpegts`, `wmv`/`asf`, `ogv`
- **Audio formats:** `mp3`, `wav`, `aiff`/`aif`, `flac`, `m4a`, `aac`,
  `ogg`/`oga`, `wma`, `ape`, `wv`/`wavpack`

Container format alone doesn't say whether a file is "video" or
"audio-only" — an `.m4a` and an `.mp4` are frequently the exact same
underlying container, differing only in whether a video stream happens
to be present. So the asserted format only gates *which containers
we'll attempt at all*; the actual video-vs-audio branch decision comes
from inspecting `ffprobe`'s real stream list (see below).

## Usage

```js
const { getMediaPreview } = require('./src/mediaExtractor');

const buffer = fs.readFileSync('/path/to/video.mp4');
const result = await getMediaPreview(buffer, 'mp4');
```

Never throws. Always resolves to one of:

```js
// success
{
  kind: 'video' | 'audio',
  metadata: { duration, format, ... },   // see "Metadata" below
  items: [ { label, thumbnail, format, width, height, timecode? }, ... ],
  html: string | null,
  error: null
}

// failure
{
  kind: null, metadata: null, items: null, html: null,
  error: { code: 'too-large' | 'unsupported-format' | 'ffmpeg-unavailable' | 'parse-error', message: string }
}
```

**`items` by branch:**
- video: `frame@10%`, `frame@30%`, `frame@50%`, `frame@70%`, `frame@90%` (or whatever `filmstripPercentages` is configured to), each with a `timecode` field
- audio: `cover` (only if embedded art is present), `waveform`, `spectrogram`

## The attached-pic gotcha

A large fraction of real-world MP3/M4A files carry embedded cover art,
and `ffprobe` reports that as an actual video stream. A naive "does a
video stream exist?" check would misclassify practically every music
file with album art as *video*, and then try to build a 5-frame
filmstrip out of what's really one static image. `ffprobe`'s stream
objects expose a `disposition.attached_pic` flag exactly for this —
`classifyStreams()` uses it to separate "the real video stream" from
"the embedded cover art stream" before the video-vs-audio branch
decision is made. Covered directly by a regression test using a real
MP3 with embedded art (`kind` must come out `'audio'`, not `'video'`).

## The 100% filmstrip gotcha

Requesting a frame at exactly the file's reported duration (relevant
if a caller configures `filmstripPercentages` to include `100`)
frequently seeks *past* the last decodable frame — rounding and
keyframe alignment mean the container's reported duration and the
timestamp of its actual last frame rarely line up exactly. Found via a
genuine test failure, not anticipated in advance: `ffmpeg` would exit
successfully but produce zero bytes of frame data, which then failed
downstream in `sharp` with a confusing "input buffer is empty" error.
Fixed by clamping every requested timestamp to a small epsilon (0.1s)
short of the true end, so "give me the very last moment" still means
something sensible instead of silently failing.

## Output modes

Same `output: 'buffers' | 'html' | 'both'` toggle as `image-extractor`,
generalized from "one image" to "a labeled collection of images."
`'buffers'` (default) leaves `items[].thumbnail` populated and
`html: null`; `'html'` gives one assembled, ready-to-embed fragment
and nulls out every `items[].thumbnail`; `'both'` gives everything.

**Layout, video (filmstrip):** frames laid out in a horizontal row at
their generated size (no shrinking), wrapping onto additional rows
when horizontal space runs out, each frame's timecode centered
underneath it via `<figure>`/`<figcaption>`. A metadata `<table>`
sits beneath the filmstrip. The whole composition centers on both axes
when there's room, via the same centering-`<div>` pattern
`image-extractor` established.

**Layout, audio (cover + waveform + spectrogram):** stacked vertically
in that order (cover only if present), each shrinking to fit narrower
containers (`max-width:100%`) but never growing past its generated
resolution — the classic responsive-image pattern. Waveform and
spectrogram share identical nominal dimensions by construction, so
they shrink by the same factor and stay visually aligned as a column.
Same metadata table beneath, same whole-composition centering.

Markup is deliberately plain — semantic tags (`figure`/`figcaption`/
`table`/`th`/`td`), minimal inline styling, no visual design beyond
what the layout rules above require. Same "local tool, not a web
tool" instinct that dropped `image-extractor`'s `alt` support:
readability over design, and no caller-supplied text ever gets
interpolated into this markup, so there's nothing here that needs
escaping the way an open `altText` field would have.

## Metadata

- **Shared:** `duration` (formatted timecode), `format` (container name)
- **Video-only:** `width`, `height`, `fps`, `videoCodec`, `hasAudio`, `audioCodec` (of the accompanying audio track, if any)
- **Audio-only:** `sampleRate`, `channels`, `audioCodec`

## Config

`maxFileSizeBytes` (default 2GB — a sane-upper-bound gate, not a
memory-safety necessity, since `ffprobe`/`ffmpeg` here only ever read
headers and seek to specific points, never load the whole file into
memory), `filmstripPercentages` (default `[10,30,50,70,90]`),
`frameMaxDimension` (default 512), `waveformWidth`/`waveformHeight`
(default 1200×300, shared by both visualizations), `spectrogramColor`
(default `'fire'` — quiet maps to dark/cool, loud to bright/warm,
matching the traditional convention; validated against a fixed enum
before being interpolated into an ffmpeg filter-graph string, so an
unexpected value can't affect the constructed command), `coverMaxDimension`
(default 512), `webpQuality` (default 80), `limitInputPixels` (default
100 megapixels, same decompression-bomb guard as `image-extractor`,
applied even to ffmpeg's own generated rasters as defense in depth),
`ffmpegTimeoutMs` (default 20s per subprocess call),
`ffmpegMaxBufferBytes` (default 100MB per subprocess call), `output`
(`'buffers'` | `'html'` | `'both'`). `deps` accepts injected
dependencies (`sharp`, `ffmpegPath`, `ffprobePath`, `execFile`,
`fsModule`), used for testing here and also the intended override
point for supplying `ffmpeg-static`'s/`ffprobe-static`'s resolved
paths explicitly if needed.

## A note on this project's own test environment

`ffmpeg-static`'s installer downloads a prebuilt binary from a GitHub
release-assets URL at `npm install` time. In whatever sandbox this
module was developed and tested in, that specific download domain
wasn't reachable, so `ffmpeg-static`/`ffprobe-static` are declared as
real dependencies in PACO's root `package.json` (accurate for actual
deployments, where that download works normally) but were installed
with `--ignore-scripts` to skip the blocked download, and the test
suite instead injects a system-installed `ffmpeg`/`ffprobe` via the
`deps.ffmpegPath`/`deps.ffprobePath` override — the same
dependency-injection mechanism `getMediaPreview` exposes for any
caller. `test/fixtures.js` reads the path for each from the
`MEDIA_EXTRACTOR_TEST_FFMPEG`/`MEDIA_EXTRACTOR_TEST_FFPROBE`
environment variables, falling back to `/usr/bin/ffmpeg`/
`/usr/bin/ffprobe` if unset — set those two to point at a differently
located install (e.g. Homebrew's `/opt/homebrew/bin/ffmpeg`) without
touching any file. This is purely a test-running convenience; it
doesn't affect how the module behaves for a real caller with a working
`ffmpeg-static` install, which is the default when no
`deps.ffmpegPath`/`deps.ffprobePath` override is given.

## Testing

`test/mediaExtractor.test.js` uses Node's built-in test runner
(`node --test`); `test/fixtures.js` synthesizes real audio/video files
via the system `ffmpeg` at test-setup time (a test-pattern video with
a tone muxed in, a silent video, a WebM/VP9/Opus file to prove
multi-container support, a plain tone MP3, and an MP3 with real
embedded cover art) — no bundled binary fixtures. Covers: every pure
helper directly (`formatTimecode`, `extractDurationSeconds`,
`parseFrameRate`, `classifyStreams` including the attached-pic
regression case, `normalizeFileType`, the HTML assemblers); the video
branch end-to-end (frame count/labels/timecodes, `hasAudio` correctness
for both audio-present and silent sources, WebM support, custom
`frameMaxDimension` and `filmstripPercentages` including the 0%/100%
edge case); the audio branch end-to-end (waveform+spectrogram
dimensions, cover-art presence/absence/sizing, custom visualization
dimensions, the `spectrogramColor` enum guard); all three output modes
and their mutual consistency; every failure path (too-large before any
subprocess call, unsupported formats, garbage bytes, missing
`ffmpeg`/`ffprobe` binaries, a stream-less file) proving the function
never throws; and temp-directory cleanup after both success and
failure.
