# PACO

PACO really comes from **Partial Commander** — a reverence to Christian Ghisler's Total Commander, the sacred beast of twin-panel commanders nobody will likely ever match in complexity and feature set. PACO doesn't try to. It picks a handful of things Total Commander does and tries to do those well: two panels, a real copy/move engine, live filesystem watching, and a UI that remembers where you left it.

## What it does

- **Two independent panels**, each with its own path, selection, tab set, and navigation history, persisted across restarts in `~/.paco/`.
- **Copy and move**, with progress reporting, pause/resume/abort, collision-safe naming (`(1) file.txt`, `(2) file.txt`, …), and a copy-then-delete strategy for moves — if a move is aborted mid-flight, sources are left untouched and partial destination copies are cleaned up.
- **Live updates** — both panels watch their open directories and refresh automatically when files change on disk, debounced to coalesce rapid bursts (e.g. from a move).
- **User-defined operations**, plus the standard set: navigate, rename, delete, create directory.
- A single filesystem abstraction (`fs-provider`) that every operation goes through, keeping platform quirks and future backends (SFTP, zip-as-folder, etc.) contained in one place.

## Running it

```bash
npm install
npm start          # headless
npm run start:ui   # opens the app window
```

On first `--ui` run, PACO downloads Chrome for Testing (~300 MB) into `.browsers/` and reuses it from then on — no Electron, no system browser dependency. The app runs as a regular Node.js process; the browser is just its window.

## Install scripts

Recent npm versions (11.16.0+) print a warning — and npm v12 will block outright — any dependency's `preinstall`/`install`/`postinstall` script that isn't explicitly reviewed via the `allowScripts` field in `package.json`. Two of PACO's dependencies currently ship one:

- **`ffmpeg-static`** — its `install` script downloads the actual `ffmpeg` binary the F3 Viewer's media extractor needs to produce video filmstrips and audio waveforms. Without it, every video/audio preview fails outright (`ffmpeg/ffprobe binaries were not found`) — this script is load-bearing, and is approved (`"ffmpeg-static@5.3.0": true`).
- **`tesseract.js`** — a direct dependency of `officeparser` (used for OCR on scanned/image-only PDF pages, a capability PACO's text-extractor never invokes). Its postinstall is `opencollective-postinstall || true` — a zero-dependency, 3.7 KB package whose only effect is printing a sponsorship message to the console; the trailing `|| true` means it can't even fail the install. It has no bearing on whether `tesseract.js` — or anything PACO actually uses — works, so it's denied (`"tesseract.js": false`) rather than approved without a reason.

If `npm install` reports a new script isn't yet covered (e.g. after a dependency bump), that's `npm approve-scripts --allow-scripts-pending` telling you to make the same call — check what the script actually does before approving it, same as above, and record the decision with `npm approve-scripts <pkg>` or `npm deny-scripts <pkg>` rather than leaving it unreviewed or reaching for `--ignore-scripts` globally (which would also block `ffmpeg-static`'s legitimate download).

If your environment can't reach `ffmpeg-static`'s download (e.g. a restricted network), note that `getMediaPreview` itself already accepts a `deps.ffmpegPath`/`deps.ffprobePath` override to point at a system-installed binary instead (see `paco/extractors/media-extractor/README.md`) — but as of this writing, PACO's own extraction task (`worker/tasks/extract-preview.js` → `paco/renderers/filmstrip|waveform/glue.js`) doesn't yet pass such an override through, so this isn't a working end-user setting today, just an existing seam in the extractor that a future change could wire up.

## Built on task-primer

PACO is an npm-distributable app built on top of [task-primer](https://github.com/ciacob/task-primer), a small Node.js application shell that handles process orchestration, the REST/WebSocket control layer, and the auto-downloaded Chrome UI window.
