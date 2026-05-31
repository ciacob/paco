'use strict';

/**
 * worker/tasks/move.js
 *
 * Same interface as copy.js. Uses fast rename() on same-volume,
 * falls back to copy+delete across volumes.
 *
 * Config:
 *   {string[]} sources, {string} dst, {string} panel, {string} dstPanel,
 *   {string} conflictFiles, {string} conflictFolders,
 *   {boolean} showHidden, {boolean} keepOnAbort, {boolean} showReport
 *
 * Result: { stats, aborted, errors, left, right }
 */

const engine = require('../../paco/copy-engine');

module.exports = {
  start(ctx) {
    return engine.runCopyMove(ctx, ctx.config, true);
  },
};
