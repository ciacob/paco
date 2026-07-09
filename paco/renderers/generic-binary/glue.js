'use strict';

/**
 * paco/renderers/generic-binary/glue.js
 *
 * See generic-text/glue.js's header — same reasoning, isText flipped to
 * false for the hex + Latin-1 dump path.
 *
 * Accepts (and ignores) an `ext` parameter purely so every renderer's
 * glue.js can be called uniformly as `buildInvocation(ext)` from
 * worker/tasks/extract-preview.js — see generic-text/glue.js's fuller
 * comment on this.
 *
 * @param {string} [_ext] — unused
 * @returns {{ modulePath: string, exportName: string, fixedArgs: any[] }}
 */
function buildInvocation(_ext) {
  return {
    modulePath: require.resolve('../../extractors/generic-extractor/src/genericExtractor'),
    exportName: 'getGenericPreview',
    fixedArgs: [false, {}], // isText = false
  };
}

module.exports = { buildInvocation };
