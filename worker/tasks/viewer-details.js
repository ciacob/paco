'use strict';

/**
 * worker/tasks/viewer-details.js
 *
 * F3 Viewer panel: gather the parts of a single selected item's detail
 * table that paco/ui-state.js#describeViewerSelection can't produce on its
 * own, since that function is pure/synchronous and this requires I/O —
 * MIME/text-vs-binary detection (for the optional "Type: text/binary —
 * MIME|EXTENSION file" row, files only) and owner/octal-permissions/
 * Windows-attributes (via fs-provider.js#statDetails, files and folders
 * alike).
 *
 * This is intentionally a separate, second round-trip from the main
 * navigate/refresh result — the synchronous parts of the Viewer (location,
 * type, name, created, modified, size-for-files) render immediately from
 * data the UI already has; this task's result arrives a moment later and
 * fills in the rest, same two-phase spirit as F4's cascade gathering its
 * own inputs before deciding.
 *
 * Config:
 *   {string} path — absolute path of the single selected item
 *
 * Result:
 *   {
 *     kindLabel: string|null,   // e.g. "text — text/html file"; null for folders
 *     mime: string|null,        // raw detected MIME (files only), null for folders
 *                               // or when file-type found no signature match
 *     isTextual: boolean|null,  // raw content-sniff result (files only), null for folders.
 *                               // Exposed alongside kindLabel (which already encodes this)
 *                               // so the client can feed paco/renderers/matcher.js's
 *                               // classifyMime()/matchRenderers() directly, without
 *                               // parsing a human-readable label string back apart or
 *                               // running a second detectMime()/detectIsTextual() round-trip.
 *     owner: string|null,       // POSIX username, or null on Windows
 *     octal: string|null,       // e.g. "644"; null on Windows
 *     isReadOnly: boolean,      // meaningful on Windows only
 *     isExecutable: boolean,
 *     permissionGrid: object|null, // viewerPermissionGrid() result, null on Windows
 *   }
 */

const path     = require('path');
const provider = require('../../paco/fs-provider');
const detect   = require('../../paco/file-handler-detect');
const uiState  = require('../../paco/ui-state');

module.exports = {
  async start(ctx) {
    const { path: targetPath } = ctx.config;

    if (!targetPath) {
      return ctx.fail('No item specified');
    }

    ctx.progress(20, 'Inspecting…');
    const entry = await provider.stat(targetPath);
    if (!entry) {
      return ctx.fail('This item no longer exists');
    }

    ctx.progress(50, 'Reading details…');
    const details = await provider.statDetails(targetPath);

    let kindLabel = null;
    let mime = null;
    let isTextual = null;
    if (entry.type === 'file') {
      // Run in parallel — both are unconditionally needed now (isTextual no
      // longer depends on mime's result; see file-handler-detect.js's own
      // comments for why), so there's no reason to wait on one before
      // starting the other.
      [mime, isTextual] = await Promise.all([
        detect.detectMime(targetPath),
        detect.detectIsTextual(targetPath),
      ]);
      kindLabel = uiState.viewerKindLabel(isTextual, mime, path.extname(targetPath));
    }

    const permissionGrid = (details && process.platform !== 'win32')
      ? uiState.viewerPermissionGrid(details.mode)
      : null;

    ctx.progress(100, 'Done');
    ctx.done({
      kindLabel,
      mime,
      isTextual,
      owner:        details ? details.owner        : null,
      octal:        details ? details.octal        : null,
      isReadOnly:   details ? details.isReadOnly    : false,
      isExecutable: details ? details.isExecutable  : false,
      permissionGrid,
    });
  },
};
