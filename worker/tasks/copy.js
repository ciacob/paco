'use strict';

/**
 * worker/tasks/copy.js
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
    return engine.runCopyMove(ctx, ctx.config, false);
  },
};
