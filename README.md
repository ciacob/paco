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

## Built on task-primer

PACO is an npm-distributable app built on top of [task-primer](https://github.com/ciacob/task-primer), a small Node.js application shell that handles process orchestration, the REST/WebSocket control layer, and the auto-downloaded Chrome UI window.
