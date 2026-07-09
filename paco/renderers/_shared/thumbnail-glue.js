'use strict';

/**
 * paco/renderers/_shared/thumbnail-glue.js
 *
 * Shared implementation behind BOTH thumbnail/glue.js and
 * thumbnail-svg/glue.js. Those two renderer.json manifests exist only
 * because file-type detects SVG's signature as generic application/xml
 * rather than an image/* MIME (confirmed empirically — see
 * thumbnail-svg/renderer.json), landing it in binary_category "other"
 * instead of "image" even though it's still a binary-mode file needing
 * its own file_type match. image-extractor's own call is identical
 * either way: same (fileType, config) shape regardless of which specific
 * raster/vector/proprietary format is asserted.
 *
 * Pure — no I/O, not even a require() of image-extractor itself beyond
 * resolving its path. output:'html' is fixed here (never 'buffer'/'both')
 * — the iframe only ever needs the ready-made HTML fragment, never the
 * raw thumbnail bytes separately.
 *
 * @param {string} ext — file extension without the leading dot, e.g. 'png', 'svg'
 * @returns {{ modulePath: string, exportName: string, fixedArgs: any[] }}
 */
function buildInvocation(ext) {
  return {
    modulePath: require.resolve('../../extractors/image-extractor/src/imageExtractor'),
    exportName: 'getImageThumbnail',
    fixedArgs: [ext, { output: 'html' }],
  };
}

module.exports = { buildInvocation };
