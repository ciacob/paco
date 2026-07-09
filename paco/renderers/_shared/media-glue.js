'use strict';

/**
 * paco/renderers/_shared/media-glue.js
 *
 * Shared implementation behind BOTH filmstrip/glue.js and
 * waveform/glue.js. media-extractor's own getMediaPreview() takes
 * exactly the same (fileType, config) shape regardless of whether the
 * file turns out to contain video or audio — it decides that itself, via
 * ffprobe, and returns it as the result's own top-level `kind` field
 * ('video'|'audio'). filmstrip's and waveform's renderer.json file_type
 * lists are disjoint (video containers vs. audio formats), so extension
 * matching only ever resolves ONE of the two as the specific match for a
 * given selection — there is no scenario where both get invoked for the
 * same file, so sharing this implementation is a DRY nicety, not a
 * de-duplication mechanism guarding against a real double-invocation
 * risk. The one thing that DOES need to happen once the (single) result
 * comes back is deciding whether the extension-based guess (which of
 * filmstrip/waveform got preselected) agrees with the confirmed `kind` —
 * that comparison is client-side UI logic (which tab to reveal), not
 * this glue's concern; see ui-state.js's siblingRendererByName-style
 * helper and paco-app.js's extraction result handling.
 *
 * Pure — no I/O, not even a require() of media-extractor itself beyond
 * resolving its path. output:'html' is fixed here for the same reason as
 * thumbnail-glue.js.
 *
 * @param {string} ext — file extension without the leading dot, e.g. 'mp4', 'mp3'
 * @returns {{ modulePath: string, exportName: string, fixedArgs: any[] }}
 */
function buildInvocation(ext) {
  return {
    modulePath: require.resolve('../../extractors/media-extractor/src/mediaExtractor'),
    exportName: 'getMediaPreview',
    fixedArgs: [ext, { output: 'html' }],
  };
}

module.exports = { buildInvocation };
