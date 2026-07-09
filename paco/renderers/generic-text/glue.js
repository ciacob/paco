'use strict';

/**
 * paco/renderers/generic-text/glue.js
 *
 * Pure — given nothing but this renderer's own fixed identity (there's no
 * per-file variation for the base renderers; every text file gets the
 * exact same call), returns a plain description of which extractor to
 * invoke and how. No I/O here: not the file's bytes, not a child process,
 * not even a require() of the actual extractor module until the caller
 * asks for the resolved path (require.resolve() only resolves a path,
 * it doesn't load/execute the module).
 *
 * Consumed by worker/tasks/extract-preview.js's generic invocation
 * layer: modulePath + exportName tell it which module/function to load
 * and call in the forked child; fixedArgs are appended after the file
 * buffer, which the child reads from disk itself (buildInvocation never
 * touches the filesystem).
 *
 * Accepts (and ignores) an `ext` parameter purely so every renderer's
 * glue.js can be called uniformly as `buildInvocation(ext)` from
 * worker/tasks/extract-preview.js, without that call site needing to
 * know which renderers care about the extension and which don't.
 *
 * @param {string} [_ext] — unused; see above
 * @returns {{ modulePath: string, exportName: string, fixedArgs: any[] }}
 */
function buildInvocation(_ext) {
  return {
    modulePath: require.resolve('../../extractors/generic-extractor/src/genericExtractor'),
    exportName: 'getGenericPreview',
    fixedArgs: [true, {}], // isText = true
  };
}

module.exports = { buildInvocation };
