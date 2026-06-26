'use strict';

/**
 * worker/tasks/open-native.js
 *
 * PACO command task: hand a single file/folder off to the OS to open with
 * its default application (macOS `open`, Windows `start`, Linux `xdg-open`).
 *
 * This is intentionally NOT a "wait until the app has opened" operation —
 * the `open` package (and the underlying OS commands) only confirm that the
 * launch request was *accepted*, not that the target application has
 * actually finished starting or rendered a window. There is no reliable
 * signal for that, so this task does not pretend to provide one.
 *
 * The spawned process is detached and has its stdio ignored (open's default
 * behaviour with wait:false, which is also the default), so PACO neither
 * blocks on it nor manages its lifecycle in any way.
 *
 * Config:
 *   {string} path  — absolute path of the file or bundle-folder to open
 *
 * Result:
 *   { opened: true, path }
 *
 * Failure modes surfaced via ctx.fail(): no path given, path no longer
 * exists, or the OS launcher itself failed to spawn (e.g. no associated
 * application on some minimal Linux setups).
 */

const provider = require('../../paco/fs-provider');

module.exports = {
  async start(ctx) {
    const { path: targetPath } = ctx.config;

    if (!targetPath) {
      return ctx.fail('No file or folder specified to open');
    }

    ctx.progress(20, `Opening "${require('path').basename(targetPath)}"…`);

    const entry = await provider.stat(targetPath);
    if (!entry) {
      return ctx.fail('This item no longer exists');
    }

    let open;
    try {
      open = require('open');
    } catch (err) {
      return ctx.fail('The "open" module is not available');
    }

    try {
      // wait:false (the default) — resolves once the OS launcher has been
      // spawned, detached, with stdio ignored. We do not and cannot wait
      // for the target application itself to finish opening.
      await open(targetPath);
    } catch (err) {
      return ctx.fail(`Could not open this item: ${err.message}`);
    }

    ctx.progress(100, 'Opened');
    ctx.done({ opened: true, path: targetPath });
  },
};
