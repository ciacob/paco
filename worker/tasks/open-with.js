'use strict';

/**
 * worker/tasks/open-with.js
 *
 * PACO command task: F4 — open a single file/folder through the configured
 * file-handlers.json cascade (specific extension → MIME category → fallback),
 * instead of always handing off to the OS default app (that's F-Enter /
 * open-native.js).
 *
 * The cascade DECISION is made by the pure function
 * paco/ui-state.js#resolveFileHandler — this task's only job is to gather
 * the inputs that function needs (detected MIME, text/binary sniff,
 * executable check), call it, and act on the result:
 *
 *   { action: 'open', app, args }  → open(targetPath, { app: { name: app, arguments: args } })
 *   { action: 'nativeOpen' }       → same hand-off as open-native.js
 *   { action: 'lister' }           → no-op for now; F3 (read-only viewer) doesn't exist yet
 *   { action: 'none' }             → no-op
 *
 * Same "we cannot know when the app has actually opened" caveat as
 * open-native.js applies here too — see that file's header for the detail.
 *
 * Config:
 *   {string} path  — absolute path of the file to open
 *
 * Result:
 *   { action, app?, opened: boolean }
 */

const path     = require('path');
const provider = require('../../paco/fs-provider');
const detect   = require('../../paco/file-handler-detect');
const context  = require('../../paco/context');
const uiState  = require('../../paco/ui-state');

module.exports = {
  async start(ctx) {
    const { path: targetPath } = ctx.config;

    if (!targetPath) {
      return ctx.fail('No file specified to open');
    }

    ctx.progress(10, `Inspecting "${path.basename(targetPath)}"…`);

    const entry = await provider.stat(targetPath);
    if (!entry) {
      return ctx.fail('This item no longer exists');
    }
    if (entry.type === 'dir') {
      return ctx.fail('F4 only applies to files');
    }

    // ── Gather cascade inputs ──────────────────────────────────────────────────
    ctx.progress(30, 'Detecting file type…');
    const mime = await detect.detectMime(targetPath);

    ctx.progress(50, 'Checking content…');
    // Only worth sniffing if file-type found no binary signature match —
    // resolveFileHandler ignores this value entirely when mime is non-null.
    const looksTextual = mime ? false : await detect.detectIsTextual(targetPath);

    ctx.progress(65, 'Checking permissions…');
    const isExecutable = await detect.detectIsExecutable(targetPath);

    // ── Resolve via the pure cascade ───────────────────────────────────────────
    ctx.progress(80, 'Resolving handler…');
    const config   = context.readFileHandlers();
    const decision = uiState.resolveFileHandler(
      config, entry.name, mime, looksTextual, isExecutable
    );

    // ── Act on the decision ────────────────────────────────────────────────────
    if (decision.action === 'none') {
      ctx.progress(100, 'No handler configured');
      return ctx.done({ action: 'none', opened: false });
    }

    if (decision.action === 'lister') {
      // F3 (read-only viewer) doesn't exist yet — nothing to delegate to.
      ctx.progress(100, 'Viewer not yet available');
      return ctx.done({ action: 'lister', opened: false });
    }

    let open;
    try {
      open = require('open');
    } catch (err) {
      return ctx.fail('The "open" module is not available');
    }

    try {
      if (decision.action === 'open') {
        ctx.progress(90, `Opening with ${decision.app}…`);
        await open(targetPath, {
          app: { name: decision.app, arguments: decision.args || [] },
        });
        ctx.progress(100, 'Opened');
        return ctx.done({ action: 'open', app: decision.app, opened: true });
      }

      if (decision.action === 'nativeOpen') {
        ctx.progress(90, 'Opening…');
        await open(targetPath);
        ctx.progress(100, 'Opened');
        return ctx.done({ action: 'nativeOpen', opened: true });
      }
    } catch (err) {
      return ctx.fail(`Could not open this item: ${err.message}`);
    }

    // Defensive — resolveFileHandler should never return anything else,
    // but fail loudly rather than silently doing nothing if it somehow does.
    return ctx.fail(`Unrecognised handler action: ${decision.action}`);
  },
};
